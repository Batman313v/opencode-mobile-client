package com.logicedge.opencodemobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Receives the Approve / Always allow / Deny taps from permission notifications and publishes the
 * OpenCode v2 permission reply to the ntfy reply topic: {@code POST <replyEndpoint>} with body
 * {@code {"sessionID", "requestID", "decision"}}. The reply target, decision and (optional) auth
 * header are carried in the broadcast extras, so this works even if the listening service is no
 * longer running. A plugin instance on a server receives the frame via SSE; only the process that
 * announced the request applies it in-process. Posts a short-lived result notification: 2xx = reply
 * delivered (the request resolves within a second), anything else = could not deliver it.
 */
public class NotificationActionReceiver extends BroadcastReceiver {

    /** JSON: { endpoint, sessionID, requestID } — where and what to publish the reply as. */
    public static final String EXTRA_REPLY_TARGET = "com.logicedge.opencodemobile.REPLY_TARGET";
    public static final String EXTRA_DECISION = "com.logicedge.opencodemobile.DECISION";
    public static final String EXTRA_AUTH_HEADER = "com.logicedge.opencodemobile.AUTH_HEADER";
    /** JSON: { approved, denied, respondFailed } — pre-translated result titles. */
    public static final String EXTRA_RESULT_LABELS = "com.logicedge.opencodemobile.RESULT_LABELS";
    /** Body text of the original notification, shown as context in the result notification. */
    public static final String EXTRA_CONTEXT = "com.logicedge.opencodemobile.CONTEXT";
    /** Id of the permission notification that spawned this action — cancelled once the request is resolved. */
    public static final String EXTRA_SOURCE_NOTIFICATION_ID = "com.logicedge.opencodemobile.SOURCE_NOTIFICATION_ID";

    // Shared with ListeningService and the JS side so results land on the same channel.
    private static final String EVENTS_CHANNEL_ID = "opencode-server-events";
    // Separate range from the service's event ids to avoid clobbering in-flight notifications.
    private static final AtomicInteger RESULT_NOTIFICATION_IDS = new AtomicInteger(2_000_000);
    // How long the short-lived result notification stays before auto-dismissing on its own.
    private static final long RESULT_AUTO_DISMISS_MS = 10_000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        JSONObject target = parseReplyTarget(intent.getStringExtra(EXTRA_REPLY_TARGET));
        String decision = intent.getStringExtra(EXTRA_DECISION);
        if (target == null
                || (!"once".equals(decision) && !"always".equals(decision) && !"reject".equals(decision))) {
            return; // Not one of our action broadcasts.
        }

        String authHeader = intent.getStringExtra(EXTRA_AUTH_HEADER);
        // Single assignment so the variables stay effectively final for the reply thread below.
        JSONObject resultLabels = parseResultLabels(intent.getStringExtra(EXTRA_RESULT_LABELS));
        String contextText = intent.getStringExtra(EXTRA_CONTEXT);
        int sourceId = intent.getIntExtra(EXTRA_SOURCE_NOTIFICATION_ID, -1);

        // The reply is a network call that outlives onReceive — hold the receiver open with goAsync.
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                respond(context, target, decision, authHeader, resultLabels, contextText, sourceId);
            } finally {
                pending.finish();
            }
        }, "opencode-permission-reply").start();
    }

    private void respond(Context context, JSONObject target, String decision, String authHeader,
                         JSONObject labels, String contextText, int sourceId) {
        int status = -1;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(target.optString("endpoint", "")).openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            // ntfy publish: the body is stored verbatim and relayed to subscribers as message text.
            connection.setRequestProperty("Content-Type", "text/plain; charset=utf-8");
            if (authHeader != null && !authHeader.isEmpty()) {
                connection.setRequestProperty("Authorization", authHeader);
            }
            JSONObject frame = new JSONObject();
            frame.put("sessionID", target.optString("sessionID", ""));
            frame.put("requestID", target.optString("requestID", ""));
            frame.put("decision", decision);
            byte[] body = frame.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(body);
            }
            status = connection.getResponseCode();
            connection.disconnect();
        } catch (Exception e) {
            // Network failure — reported as "could not respond" below.
        }

        boolean delivered = status >= 200 && status < 300;
        String title = delivered
                ? label(labels, "reject".equals(decision) ? "denied" : "approved",
                        "reject".equals(decision) ? "Denied" : "Approved")
                : label(labels, "respondFailed", "Could not respond to the request.");

        // Delivered — drop the stale permission notification; the owning server resolves it shortly.
        if (delivered && sourceId >= 0) {
            NotificationManagerCompat.from(context).cancel(sourceId);
        }
        postResult(context, title, contextText);
    }

    private static JSONObject parseResultLabels(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return null;
        }
    }

    /** Parses the reply-target extra; null when missing or unusable. */
    private static JSONObject parseReplyTarget(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        try {
            JSONObject target = new JSONObject(raw);
            String endpoint = target.optString("endpoint", "");
            String requestID = target.optString("requestID", "");
            if (!endpoint.startsWith("http://") && !endpoint.startsWith("https://")) return null;
            if (requestID.isEmpty()) return null;
            return target;
        } catch (Exception e) {
            return null;
        }
    }

    private static String label(JSONObject labels, String key, String fallback) {
        if (labels == null) return fallback;
        try {
            String value = labels.optString(key, "");
            return value.isEmpty() ? fallback : value;
        } catch (Exception e) {
            return fallback;
        }
    }

    private void postResult(Context context, String title, String bodyText) {
        // Use the application context for the delayed auto-dismiss: the receiver's own context is
        // only valid while onReceive is running, but the cancel fires ~10s later on the main looper.
        Context appContext = context.getApplicationContext();
        NotificationManagerCompat manager = NotificationManagerCompat.from(appContext);
        if (!manager.areNotificationsEnabled()) return;
        ensureChannel(appContext);

        String body = (bodyText == null || bodyText.isEmpty()) ? "" : truncate(bodyText, 100);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(appContext, EVENTS_CHANNEL_ID)
                .setContentTitle(title)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(R.drawable.ic_notification_agent)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setAutoCancel(true);

        int notificationId = RESULT_NOTIFICATION_IDS.getAndIncrement() % Integer.MAX_VALUE;
        manager.notify(notificationId, builder.build());

        // Short-lived confirmation: drop it after a few seconds so it doesn't clutter the shade.
        new Handler(Looper.getMainLooper()).postDelayed(
                () -> NotificationManagerCompat.from(appContext).cancel(notificationId),
                RESULT_AUTO_DISMISS_MS);
    }

    private static String truncate(String value, int maxLength) {
        return value.length() > maxLength ? value.substring(0, maxLength - 3) + "..." : value;
    }

    private void ensureChannel(Context context) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(EVENTS_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                EVENTS_CHANNEL_ID, "OpenCode notifications", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Notifications from a connected OpenCode server.");
        manager.createNotificationChannel(channel);
    }
}
