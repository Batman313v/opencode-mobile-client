package com.logicedge.opencodemobile;

import android.content.Context;
import android.content.Intent;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Starts/stops the {@link ListeningService} foreground service from app code. {@code start} passes
 * the ntfy subscription config (endpoint, optional token, per-server auth map, i18n labels) as JSON
 * so the service can open its native subscription immediately. Only called while the app is in the
 * foreground (launch or settings toggle), so Android 12+ background-start restrictions never apply.
 */
@CapacitorPlugin(name = "ServerEvents")
public class ServerEventsPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // JS passes the config as an object; optString returns strings as-is and serializes objects to JSON text.
        String configJson = call.getData().optString("config", "{}");
        if (configJson.isEmpty()) configJson = "{}";

        Intent intent = new Intent(getContext(), ListeningService.class);
        intent.putExtra(ListeningService.EXTRA_CONFIG, configJson);
        // minSdk is 26, so the foreground-service API is always available.
        getContext().startForegroundService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ListeningService.class));
        // Drop the persisted config so a later sticky restart cannot resurrect monitoring.
        getContext()
                .getSharedPreferences(ListeningService.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .remove(ListeningService.PREF_KEY_CONFIG)
                .apply();
        call.resolve();
    }
}
