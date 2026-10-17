package com.logicedge.opencodemobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Foreground service that subscribes to the app's ntfy topic ({@code GET <endpoint>}) on a native
 * thread — not in web view JavaScript, which Android freezes while the app is hidden — so messages
 * keep arriving with the screen off or the app in the background. Same approach as ntfy's own
 * Android client: a foreground service pins the process and does real work inside it. No FCM
 * involved; mapped messages are posted as local notifications directly from this service, including
 * Approve / Always / Deny actions for permission requests (handled by {@link NotificationActionReceiver}).
 *
 * Start payload JSON shape (from ServerEventsPlugin):
 * <pre>{
 *   "endpoint": "https://ntfy.example/opencode-mobile/sse",  // full SSE subscribe URL
 *   "token": null,                                       // optional ntfy access token
 *   "replyEndpoint": "https://ntfy.example/opencode-mobile-replies",  // approval reply publish URL
 *   "labels": { ...pre-translated notification texts... }
 * }</pre>
 */
public class ListeningService extends Service {

    public static final String EXTRA_CONFIG = "com.logicedge.opencodemobile.EXTRA_CONFIG";
    /** Persisted config so a system-initiated restart (null intent) restores the same subscription. */
    public static final String PREFS_NAME = "listening";
    public static final String PREF_KEY_CONFIG = "config";

    private static final String TAG = "ListeningService";
    private static final String LISTENING_CHANNEL_ID = "opencode-listening";
    // Must match the channel id used by the JS side (nativeNotifications.ts) so both share one channel.
    private static final String EVENTS_CHANNEL_ID = "opencode-server-events";
    private static final int LISTENING_NOTIFICATION_ID = 1;
    private static final long RECONNECT_DELAY_MS = 5000L;
    // Separate range from the JS plugin's ids to avoid clobbering in-flight notifications.
    private static final AtomicInteger EVENT_NOTIFICATION_IDS = new AtomicInteger(1_000_000);

    private volatile HttpURLConnection connection;
    private Thread worker;
    /** Last ntfy message id seen in a frame envelope — replayed via since=<id> when reconnecting. */
    private final AtomicReference<String> lastEventId = new AtomicReference<>();
    // sessionID → notification id for "waiting for input" notifications, so a later waiting-clear
    // frame dismisses the right one. Touched only on the worker thread (single-threaded), so no
    // synchronization is needed.
    private final Map<String, Integer> waitingNotificationIds = new HashMap<>();
    // requestID → notification id for "approval needed" notifications, so a later permission-clear
    // frame (the request was settled elsewhere, e.g. in the CLI) dismisses the right one.
    private final Map<String, Integer> permissionNotificationIds = new HashMap<>();

    // Parsed start payload (set once per configure(), read by the worker thread).
    private volatile String endpoint = "";
    private volatile String replyEndpoint = "";
    private volatile String token;
    private volatile JSONObject labels = new JSONObject();

    @Override
    public void onCreate() {
        super.onCreate();
        // minSdk is 26, so notification channels and startForeground(id, notification) are always available.
        createListeningChannel();
        startForeground(LISTENING_NOTIFICATION_ID, buildListeningNotification());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "onStartCommand freshConfig=" + (intent != null && intent.hasExtra(EXTRA_CONFIG)));
        if (intent != null && intent.hasExtra(EXTRA_CONFIG)) {
            String json = intent.getStringExtra(EXTRA_CONFIG);
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putString(PREF_KEY_CONFIG, json).apply();
            configure(json);
        } else {
            // System-initiated restart after a process death — restore the last known config.
            String saved = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getString(PREF_KEY_CONFIG, null);
            configure(saved != null ? saved : "{}");
        }
        // Restart if the system kills the process — monitoring should survive.
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopWorker();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void configure(String json) {
        stopWorker();
        lastEventId.set(null);

        try {
            JSONObject config = new JSONObject(json);
            String url = config.optString("endpoint", "");
            if (url.startsWith("http://") || url.startsWith("https://")) endpoint = url;
            token = config.isNull("token") ? null : config.optString("token", null);
            replyEndpoint = config.optString("replyEndpoint", "");
            JSONObject labelMap = config.optJSONObject("labels");
            labels = labelMap != null ? labelMap : new JSONObject();
        } catch (Exception e) {
            endpoint = ""; // Malformed payload — stay quiet rather than crash the service.
            Log.w(TAG, "malformed config payload", e);
        }

        if (!endpoint.isEmpty()) {
            worker = new Thread(this::monitorLoop, "opencode-ntfy");
            worker.start();
            Log.i(TAG, "worker started for endpoint=" + endpoint);
        } else {
            Log.w(TAG, "no valid endpoint in config — service running without a subscription");
        }
    }

    private void stopWorker() {
        HttpURLConnection current = connection;
        if (current != null) current.disconnect();
        connection = null;
        if (worker != null) worker.interrupt();
        worker = null;
    }

    /** Connect, read frames until the stream ends, wait, reconnect. Runs forever until interrupted. */
    private void monitorLoop() {
        while (!Thread.currentThread().isInterrupted()) {
            HttpURLConnection current = null;
            try {
                // ntfy v2 emits no SSE id lines, so a reconnect resumes via the since= query
                // parameter carrying the last message id we saw.
                String streamUrl = endpoint;
                String resumeFrom = lastEventId.get();
                if (resumeFrom != null && !resumeFrom.isEmpty()) {
                    streamUrl += "?since=" + URLEncoder.encode(resumeFrom, StandardCharsets.UTF_8);
                }
                current = (HttpURLConnection) new URL(streamUrl).openConnection();
                // Registered now, so a concurrent stop() will always disconnect it.
                connection = current;
                if (Thread.currentThread().isInterrupted()) throw new IOException("stopped");

                current.setRequestMethod("GET");
                current.setRequestProperty("Accept", "text/event-stream");
                String auth = token;
                if (auth != null && !auth.isEmpty()) {
                    // Self-hosted ntfy access tokens are sent as a Bearer credential.
                    current.setRequestProperty("Authorization", "Bearer " + auth);
                }
                current.setConnectTimeout(15_000);
                // No read timeout: the stream is long-lived and idle between messages. A dead
                // connection surfaces as EOF/IOException and triggers the reconnect below.

                int status = current.getResponseCode();
                if (status != 200) throw new IOException("ntfy stream status " + status);
                Log.i(TAG, "stream connected: " + streamUrl);

                InputStream in = current.getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                StringBuilder data = new StringBuilder();
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.isEmpty()) {
                        handleFrame(data.toString());
                        data.setLength(0);
                    } else if (line.startsWith(":")) {
                        // Comment / heartbeat — ignore.
                    } else if (line.startsWith("data:")) {
                        String value = line.substring(5);
                        if (value.startsWith(" ")) value = value.substring(1);
                        if (data.length() > 0) data.append('\n');
                        data.append(value);
                    }
                }
            } catch (Exception e) {
                // Dropped connection or interrupted — reconnect below while still running.
                if (!Thread.currentThread().isInterrupted()) Log.w(TAG, "stream error: " + e.getMessage());
            } finally {
                if (current != null) {
                    current.disconnect();
                    if (connection == current) connection = null;
                }
            }

            if (Thread.currentThread().isInterrupted()) return;
            try {
                Thread.sleep(RECONNECT_DELAY_MS);
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** Maps one ntfy SSE frame to a local notification. */
    private void handleFrame(String frameData) {
        if (frameData.isEmpty()) return;
        try {
            JSONObject message = new JSONObject(frameData);
            // Every envelope carries the ntfy message id — remember it so a reconnect can resume via since=.
            String id = message.optString("id", "");
            if (!id.isEmpty()) lastEventId.set(id);
            // ntfy delivers published messages as event: message — ignore other frame kinds.
            if (!"message".equals(message.optString("event", ""))) return;
            String text = message.optString("message", "");

            NtfyPayload payload = parseBridgePayload(text);
            if (payload != null) {
                Log.i(TAG, "frame kind=" + payload.kind + " server=" + payload.serverName);
                if ("idle".equals(payload.kind)) postIdleNotification(payload);
                else if ("permission".equals(payload.kind)) postPermissionNotification(payload);
                else if ("permission-clear".equals(payload.kind)) clearPermissionNotification(payload);
                else if ("waiting".equals(payload.kind)) postWaitingNotification(payload);
                else if ("waiting-clear".equals(payload.kind)) clearWaitingNotification(payload);
            } else {
                // Anything else on the topic (e.g. plain-text posts from other tools) — show as-is.
                Log.i(TAG, "generic frame: " + text.substring(0, Math.min(text.length(), 80)));
                postGenericNotification(text);
            }
        } catch (Exception ignored) {
            // Malformed frame — skip.
        }
    }

    /** Parses a v1 bridge payload out of an ntfy message body; null for non-bridge messages. */
    private static NtfyPayload parseBridgePayload(String text) {
        if (text.isEmpty()) return null;
        try {
            JSONObject json = new JSONObject(text);
            if (json.optInt("v", 0) != 1) return null;
            String kind = json.optString("kind", "");
            if (!"idle".equals(kind) && !"permission".equals(kind) && !"permission-clear".equals(kind)
                    && !"waiting".equals(kind) && !"waiting-clear".equals(kind)) return null;

            NtfyPayload payload = new NtfyPayload();
            payload.kind = kind;
            payload.serverName = json.optString("serverName", "OpenCode");
            payload.sessionID = json.optString("sessionID", "");
            if ("idle".equals(kind)) {
                payload.title = json.isNull("title") ? null : json.optString("title", null);
                payload.project = json.isNull("project") ? null : json.optString("project", null);
            } else if ("permission".equals(kind)) {
                payload.requestID = json.optString("requestID", "");
                payload.action = json.optString("action", "");
                if (!json.isNull("message")) payload.message = json.optString("message", null);
                if (!json.isNull("summary")) payload.summary = json.optString("summary", null);
            } else if ("permission-clear".equals(kind)) {
                payload.requestID = json.optString("requestID", "");
            } else if ("waiting".equals(kind)) {
                payload.title = json.isNull("title") ? null : json.optString("title", null);
            }
            return payload;
        } catch (Exception e) {
            return null; // Not JSON — caller posts it as a generic text notification.
        }
    }

    private static class NtfyPayload {
        String kind;
        String serverName;
        String sessionID;
        String title;      // idle: session title; waiting: the question (may be null)
        String project;    // idle: which project (workspace) finished (may be null)
        String requestID;  // permission / permission-clear: the permission request id
        String action;     // permission: e.g. "bash", "edit"
        String message;    // permission: human detail (may be null)
        String summary;    // permission: short LLM summary of the action (may be null)
    }

    private void postIdleNotification(NtfyPayload payload) {
        // Body names the project so several running at once can be told apart; fall back to the
        // session title, then the generic finished text.
        String body;
        if (payload.project != null && !payload.project.isEmpty()) body = payload.project;
        else if (payload.title != null && !payload.title.isEmpty()) body = payload.title;
        else body = label("sessionFinished", "The session has finished.");
        postEventNotification(label("taskFinished", "Task finished"), body);
    }

    private void postPermissionNotification(NtfyPayload payload) {
        // Prefer the LLM summary (what the action will do), then the raw detail, then the action name.
        String detail = payload.summary != null && !payload.summary.isEmpty()
                ? payload.summary
                : (payload.message != null && !payload.message.isEmpty() ? payload.message : payload.action);
        String body = ellipsize(payload.serverName + ": " + (detail.isEmpty() ? "?" : detail));
        // The id is allocated here so the reply actions can carry it and dismiss this notification
        // once resolved; it is also remembered so a permission-clear frame (the request settled
        // elsewhere, e.g. in the CLI) can dismiss it. A new request replaces an older entry.
        int id = EVENT_NOTIFICATION_IDS.getAndIncrement() % Integer.MAX_VALUE;
        permissionNotificationIds.put(payload.requestID, id);
        postEventNotification(label("approvalNeeded", "Approval needed"), body, buildReplyActions(payload, body, id), id);
    }

    private void clearPermissionNotification(NtfyPayload payload) {
        Integer id = permissionNotificationIds.remove(payload.requestID);
        if (id == null) return;
        NotificationManagerCompat.from(this).cancel(id);
        Log.i(TAG, "cleared approval notification id=" + id + " request=" + payload.requestID);
    }

    private void postWaitingNotification(NtfyPayload payload) {
        String body = payload.title != null && !payload.title.isEmpty()
                ? ellipsize(payload.title)
                : label("waitingBody", "The agent is waiting for your input.");
        int id = EVENT_NOTIFICATION_IDS.getAndIncrement() % Integer.MAX_VALUE;
        // Remember the id so a waiting-clear frame for this session can dismiss it. A session asks
        // one question at a time, so a single slot per session is enough (a new one replaces the old).
        waitingNotificationIds.put(payload.sessionID, id);
        postEventNotification(label("waitingForInput", "Waiting for input"), body, null, id);
    }

    private void clearWaitingNotification(NtfyPayload payload) {
        Integer id = waitingNotificationIds.remove(payload.sessionID);
        if (id == null) return;
        NotificationManagerCompat.from(this).cancel(id);
        Log.i(TAG, "cleared waiting notification id=" + id + " session=" + payload.sessionID);
    }

    private void postGenericNotification(String text) {
        if (text.trim().isEmpty()) return;
        postEventNotification(label("genericTitle", "OpenCode"), ellipsize(text, 300));
    }

    /** Approve / Always / Deny buttons that publish the v2 permission reply to the ntfy reply topic. */
    private NotificationCompat.Action[] buildReplyActions(NtfyPayload payload, String context, int sourceId) {
        if (replyEndpoint.isEmpty() || payload.requestID.isEmpty()) return null;

        try {
            // Replies travel back through ntfy: the phone publishes a small frame to the reply topic
            // and the plugin process that announced this request applies it in-process — no direct
            // server address or port is needed here.
            JSONObject target = new JSONObject();
            target.put("endpoint", replyEndpoint);
            target.put("sessionID", payload.sessionID);
            target.put("requestID", payload.requestID);

            String authHeader = (token != null && !token.isEmpty()) ? "Bearer " + token : null;
            JSONObject resultLabels = new JSONObject();
            resultLabels.put("approved", label("approved", "Approved"));
            resultLabels.put("denied", label("denied", "Denied"));
            resultLabels.put("respondFailed", label("respondFailed", "Could not respond to the request."));

            int baseRequestCode = EVENT_NOTIFICATION_IDS.get() * 3;
            return new NotificationCompat.Action[] {
                    actionFor(baseRequestCode, target.toString(), "once", authHeader, resultLabels.toString(), context, sourceId,
                            label("approveOnce", "Approve")),
                    actionFor(baseRequestCode + 1, target.toString(), "always", authHeader, resultLabels.toString(), context, sourceId,
                            label("approveAlways", "Always allow")),
                    actionFor(baseRequestCode + 2, target.toString(), "reject", authHeader, resultLabels.toString(), context, sourceId,
                            label("deny", "Deny")),
            };
        } catch (Exception e) {
            return null; // Label serialization failed — post without actions rather than crash.
        }
    }

    private NotificationCompat.Action actionFor(int requestCode, String replyTarget, String decision,
                                                String authHeader, String resultLabels, String context,
                                                int sourceId, String label) {
        Intent intent = new Intent(this, NotificationActionReceiver.class);
        intent.putExtra(NotificationActionReceiver.EXTRA_REPLY_TARGET, replyTarget);
        intent.putExtra(NotificationActionReceiver.EXTRA_DECISION, decision);
        intent.putExtra(NotificationActionReceiver.EXTRA_SOURCE_NOTIFICATION_ID, sourceId);
        if (authHeader != null && !authHeader.isEmpty()) {
            intent.putExtra(NotificationActionReceiver.EXTRA_AUTH_HEADER, authHeader);
        }
        intent.putExtra(NotificationActionReceiver.EXTRA_RESULT_LABELS, resultLabels);
        intent.putExtra(NotificationActionReceiver.EXTRA_CONTEXT, context == null ? "" : context);

        PendingIntent pending = PendingIntent.getBroadcast(
                this, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Action.Builder(null, label, pending).build();
    }

    private String label(String key, String fallback) {
        try {
            String value = labels.optString(key, "");
            return value.isEmpty() ? fallback : value;
        } catch (Exception e) {
            return fallback;
        }
    }

    private void postEventNotification(String title, String body) {
        postEventNotification(title, body, null);
    }

    private void postEventNotification(String title, String body, NotificationCompat.Action[] actions) {
        int id = EVENT_NOTIFICATION_IDS.getAndIncrement() % Integer.MAX_VALUE;
        postEventNotification(title, body, actions, id);
    }

    private void postEventNotification(String title, String body, NotificationCompat.Action[] actions, int id) {
        NotificationManagerCompat manager = NotificationManagerCompat.from(this);
        if (!manager.areNotificationsEnabled()) {
            Log.w(TAG, "notifications disabled by user — dropping '" + title + "'");
            return;
        }
        ensureEventsChannel();

        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, EVENTS_CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setAutoCancel(true)
                .setContentIntent(contentIntent);
        if (actions != null && actions.length > 0) {
            for (NotificationCompat.Action action : actions) builder.addAction(action);
        }

        manager.notify(id, builder.build());
        Log.i(TAG, "posted notification id=" + id + " title='" + title + "' actions=" + (actions == null ? 0 : actions.length));
    }

    private static String ellipsize(String value) {
        return ellipsize(value, 140);
    }

    private static String ellipsize(String value, int maxLength) {
        return value.length() > maxLength ? value.substring(0, maxLength - 3) + "..." : value;
    }

    // Channels persist across app upgrades. Re-create on every start so an earlier build that
    // created them at different properties cannot leave stale state (e.g. a visible badge for
    // the listening channel). Re-creating an existing channel updates its mutable properties.
    private void createListeningChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                LISTENING_CHANNEL_ID, "Listening", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while the app listens for OpenCode server events.");
        channel.setShowBadge(false);
        channel.enableLights(false);
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void ensureEventsChannel() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                EVENTS_CHANNEL_ID, "OpenCode notifications", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Notifications from a connected OpenCode server.");
        manager.createNotificationChannel(channel);
    }

    private Notification buildListeningNotification() {
        Intent intent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, LISTENING_CHANNEL_ID)
                .setContentTitle("Opencode Mobile Client")
                .setContentText("Listening for OpenCode server events")
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setOngoing(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                .setOnlyAlertOnce(true)
                .setContentIntent(contentIntent)
                .build();
    }
}
