# OpenCode Mobile &lt;Client&gt; 📱

💫 A lightweight mobile client that wraps the [OpenCode Web](https://opencode.ai/docs/web/) UI as native Android and iOS apps. Connects to an already-running OpenCode server over LAN or VPN / Tailscale.

Chat with your agents from your phone while they and the server run on your computer, with full access to your code and tools 🖥️

🔃 Seamlessly continue sessions started on your computer from your phone, or vice versa. Available on [Android](https://play.google.com/store/apps/details?id=com.logicedge.opencodemobile), [iOS](https://apps.apple.com/app/id6787161501) and [VS Code](https://marketplace.visualstudio.com/items?itemName=bmpenuelas.opencode-web-sidebar)

[![install Android](docs/install_google_play_color_light.png)](https://play.google.com/store/apps/details?id=com.logicedge.opencodemobile) [![install iOS](docs/install_app_store_color_light.png)](https://apps.apple.com/app/id6787161501) [![install VS Code](docs/install_vscode_color_light.png)](https://marketplace.visualstudio.com/items?itemName=bmpenuelas.opencode-web-sidebar)

---

## Features

- 🌐 Connect to any OpenCode server over HTTP/HTTPS (LAN or VPN / Tailscale when you're away from home🚶)
- ⌨️ Toggleable Enter=newline mode (Enter inserts a newline, Shift+Enter sends the prompt)
- 📱 Injects narrow-screen fixes to the stock OpenCode web UI
- 📋 Multiple server profiles with auto-connect support
- 🧠 Per-server model visibility — show/hide models across all sessions on that server
- 🔑 Basic Auth support (matching OpenCode's `OPENCODE_SERVER_PASSWORD`)
- 📷 QR pairing — enter the server's reachable address (IP + port, e.g. its Tailscale IP), then scan the `opencode pair` QR code; the QR itself may only carry 127.0.0.1, so the code is redeemed at your entered address
- 🎛️ Pull-down menu for server management while connected. Pull to refresh, tap ⋮ to open menu.
- ❤️ Automatic health checks with exponential reconnect
- 🔔 Native notifications through your own [ntfy](https://ntfy.sh) instance — session-complete alerts and approval requests you can resolve from the phone (**Approve / Always allow / Deny** on Android), even while the app is backgrounded
- 🔒 Secure storage for passwords (Keychain/EncryptedSharedPreferences)
- 🌓 Dark theme with light theme support (`prefers-color-scheme`)

<p align="center">
  <img src="docs/screenshots/android/play-store-01-landing.png" width="30%" alt="Landing" />
  <img src="docs/screenshots/android/play-store-04-connected.png" width="30%" alt="Connected session" />
  <img src="docs/screenshots/android/play-store-05-pull-menu.png" width="30%" alt="Pull menu" />
</p>

---

## How to start your OpenCode Server (REQUIRED TO USE THE APP❗)

The app is a client that connects to a opencode web server running on the machine where you have your code and build tools. It needs a running web server to connect to.

### No authentication

```bash
opencode web --hostname 0.0.0.0 --port 4096
```

### With authentication (recommended)

```bash
export OPENCODE_SERVER_PASSWORD="your-secret-password"
opencode serve --hostname 0.0.0.0 --port 4096
```

When auth is enabled, the username defaults to `opencode` in the app. Find more options in the [official docs](https://opencode.ai/docs/web/).

---

## Push notifications (ntfy)

The app has **no push infrastructure of its own** — no FCM, no relay server. Instead, a small plugin bundled in this repo runs inside each OpenCode server process and publishes session events to an [ntfy](https://ntfy.sh) topic; the app subscribes to that one topic (natively on Android, so notifications keep arriving while the app is backgrounded). The ntfy instance must run **v2** — the app subscribes through the topic's `/sse` stream endpoint.

### 1. Install the bridge plugin on each server

```bash
mkdir -p ~/.config/opencode/plugins
cp <this-repo>/src/opencode-plugin/ntfy-bridge.ts ~/.config/opencode/plugins/ntfy-bridge.ts
```

OpenCode auto-discovers `.ts` files in that directory. Then create a **machine-specific** config file next to it:

```json
{
  "serverUrl":  "http://100.64.0.5:4096",
  "ntfyServer": "https://notify.example.net",
  "topic":      "opencode-mobile"
}
```

- `serverUrl` — the address your **phone** reaches this server at (Tailscale or LAN). It is embedded in approval notifications so the phone can send the reply back. Never use `127.0.0.1`.
- `ntfyServer` / `topic` — must match what you enter in the app's Settings.
- `serverName` — optional, defaults to the machine hostname; shown in notification titles.

> ⚠️ If you sync `~/.config/opencode` across machines (git / Syncthing), **exclude `ntfy-bridge.json`** — each machine needs its own `serverUrl`. A missing or invalid config disables the plugin with a console warning; it never crashes OpenCode.

Restart the server, then verify delivery from any device:

```bash
curl -N https://notify.example.net/opencode-mobile/sse
```

You should see an `event: open` frame immediately, then JSON message frames as sessions go idle or permissions are requested. (On ntfy v2 the bare topic path serves the web app — always append `/sse` for streaming.) Publishing uses no auth header — if your ntfy instance protects topics with access tokens, keep this topic open and set the token in the app instead (it applies to subscription only).

### 2. Configure the app

**Settings → Notifications**: enable the toggle and enter the **ntfy server URL**, **topic** and optional **access token** that match the plugin's config. Defaults: `https://ntfy.sh` with no topic. To set up notifications you must create your own topic (on ntfy.sh or a self-hosted instance) and enter it in **both** the app settings and the plugin's `ntfy-bridge.json` — the two must match exactly.

- **Session finished** — posted when an execution that started while the bridge was listening completes successfully (`session.execution.started` → `succeeded`, once per turn); the title is "Task finished" and the body names the project that finished (falling back to the session title when the project cannot be determined).
- **Approval needed** — posted for every permission request. On Android the notification carries **Approve**, **Always allow** and **Deny** buttons that resolve the request on the server directly (`POST /api/session/{id}/permission/{requestID}/reply`); a short-lived result notification confirms the outcome (approved / denied / already handled). The notification dismisses itself when the request is settled anywhere — phone, CLI, or the web UI — and the same applies to **Waiting for input** notifications once the question is answered.
- Anything else published to the topic renders as a plain-text notification, so other tools can share it.

> Approval notifications only appear when your server actually *asks*: with auto-approve rules nothing is ever requested. To get them, set ask-rules in `opencode.json`, e.g. `"permission": { "edit": "ask", "bash": "ask" }`.

---

## Troubleshooting

### Cannot connect

- Verify the server is running: `opencode serve --hostname 0.0.0.0 --port 4096`
- Verify the URL is correct. Try `curl http://your-server:4096/` from another device on the same network.
- Check that the port is not firewalled.
- Ensure the server is listening on `0.0.0.0` (not `127.0.0.1`, which would only accept local connections).

### Auth required

- The server returned HTTP 401 and no password is stored in the app.
- Go to Edit Server and set the password that matches `OPENCODE_SERVER_PASSWORD`.

### Wrong credentials

- The stored username or password does not match the server.
- Try connecting with the correct credentials via curl first: `curl -u opencode:your-password http://server:4096/`

### HTTP blocked on Android/iOS

- Android: Ensure `android:networkSecurityConfig` allows cleartext (see Android Setup above).
- iOS: Ensure `NSAllowsLocalNetworking` is set in `Info.plist` (see iOS Setup above).

### Notifications don't appear at all

- Enable them in **Settings → Notifications** (the app asks for OS permission on first launch).
- The ntfy URL and topic in Settings must match the plugin's `ntfy-bridge.json` exactly. Verify what actually reaches the topic from any device: `curl -N {ntfyServer}/{topic}/sse` — if nothing shows up when a session finishes, the problem is server-side (plugin not installed, bad config, or server not restarted).
- The server must run **OpenCode v2** — the plugin consumes the v2 event bus.
- On Android, notifications are posted by a foreground service that survives screen-off and even OS process reclaims; force-stopping the app stops monitoring until it is opened again. iOS suspends backgrounded apps, so there notifications arrive only while the app is running.

### Approvals from the phone fail ("Could not respond")

- `serverUrl` in the plugin's config must be reachable **from your phone** — a Tailscale or LAN address, never `127.0.0.1`.
- If the server uses Basic Auth, store matching credentials in that server profile — the reply is sent with them when present, anonymously otherwise (which fails on password-protected servers).
- A short result notification confirms whether the server accepted your reply: approved, denied, or "could not respond" (for example when the request was already resolved elsewhere).

---

## Contributing

PRs are welcome!

### Prerequisites

- **Node.js** 18+
- **npm** 9+
- For native builds:
  - **Android**: Android Studio, JDK 17, Android SDK 34+
  - **iOS**: Xcode 15+ (macOS only)

### Development (UI only - for functionality related to the opencode webview you need to test on a native platform, bot Android and iOS are supported)

```bash
npm install
npm run dev
```

Open `http://localhost:5173` in a browser. The web target is for development and quick UI testing only. CORS may block health checks from the browser — test native builds for full functionality.

### Android

```bash
npm install
npm run build
npx cap add android
npx cap sync
npx cap open android
```

In Android Studio, build and run on a device/emulator.

### iOS

```bash
npm install
npm run build
npx cap add ios
npx cap sync
npx cap open ios
```

In Xcode, build and run on a device/simulator.

---

## Commands Reference

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server (web) |
| `npm run build` | Type-check and build for production |
| `npm run preview` | Preview production build |
| `npm test` | Run unit tests (Vitest) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | TypeScript type-check only |
| `npm run cap:sync` | Sync Capacitor native projects |
| `npm run cap:add:android` | Add Android platform |
| `npm run cap:add:ios` | Add iOS platform |
| `npm run cap:open:android` | Open Android project in Android Studio |
| `npm run cap:open:ios` | Open iOS project in Xcode |
| `npm run store:verify` | Check store-readiness config files and release scaffolding |
| `npm run android:play:bundle` | Build a signed Android App Bundle for Play Console (requires signing config) |
| `npm run android:play:apk` | Build a signed Android release APK (requires signing config) |

---

## Project Structure

```
src/
  main.ts                          App entry
  App.vue                          Root component
  types.ts                         TypeScript type definitions
  i18n/index.ts                    Lightweight i18n (8 locales)
  router/index.ts                  Vue Router config
  stores/
    serverStore.ts                 Pinia store for server profiles
    connectionStore.ts             Pinia store for connection state
  composables/
    useServerHealthPoll.ts         Periodic health checks across all servers
  services/
    storage/
      profileStorage.ts            Server profile CRUD via Preferences
      secureSecretStorage.ts       Password storage via Keychain/EncryptedSP
      webDevSecretStorage.ts       localStorage fallback for web dev
      index.ts                     Storage adapter factory
    opencode/
      url.ts                       URL normalization, validation, sanitization
      auth.ts                      Basic Auth header generation
      health.ts                    Server health check via native HTTP
      events.ts                    SSE parser, ntfy frame mapping + auto-reconnecting /sse stream client (since= resume)
      ntfyTopicMonitor.ts          JS topic monitor for non-Android platforms (one subscription while the app is active)
      modelVisibility.ts           Model catalog fetch, default-visibility rules, webview state merge script
      pairing.ts                   opencode pair QR/link/code parsing + one-time code redemption (supplied address, then Tailscale-first)
      demoMode.ts                  Demo-mode detection (mock session)
    opencode-plugin/
      ntfy-bridge.ts               OpenCode v2 plugin — publishes session/permission events to ntfy (runs on each server, see "Push notifications")
      opencode-plugin.d.ts         Ambient type stub for @opencode/plugin (provided by the host at runtime)
    platform/
      systemBars.ts                Status/navigation bar configuration
      backButton.ts                Android back button handler
      listeningService.ts          Wrapper for the native ServerEvents plugin (Android foreground service subscribing to the ntfy topic)
      nativeNotifications.ts       Local notification emit, settings + app-level pipeline orchestration
  components/
    ServerList.vue                 Main page — server profile list
    ServerProfileForm.vue          Add/edit server form
    ConnectionShell.vue            Full-screen native web view shell (OpenCode UI)
    ServerModelsScreen.vue         Per-server model visibility screen
    SettingsScreen.vue             App settings (incl. help link)
    HelpScreen.vue                 Setup and troubleshooting guide
    DemoSessionMock.vue            Mock session for demo mode
    StatusDot.vue                  Status indicator
    StoreBadges.vue                Play/App Store badges
    ConfirmDialog.vue              Reusable confirmation dialog
  styles/
    base.css                       Global styles, buttons, dark/light theme
    safe-area.css                  Safe-area CSS variables
  tests/
    url.test.ts                    URL unit tests
    auth.test.ts                   Auth unit tests
    health.test.ts                 Health check classification unit tests
    profileStorage.test.ts         Profile storage unit tests
    connectionState.test.ts        Connection state unit tests
    events.test.ts                 SSE frame parser, ntfy → notification mapping + stream client unit tests
    ntfyTopicMonitor.test.ts       Topic monitor reconciliation (open / close / re-subscribe) + frame fan-out unit tests
    ntfyBridge.test.ts             Bridge plugin: config parsing/validation, execution start/success transitions, permission payloads
    modelVisibility.test.ts        Model catalog fetch, default-visibility rules, state merge script unit tests
    nativeNotifications.test.ts    Notification settings/emit + pipeline orchestration unit tests
```

---

## Security Notes

### LAN HTTP is acceptable for trusted local networks only

The app allows connecting to HTTP servers because OpenCode servers commonly run on LAN without TLS. HTTP traffic should never traverse the public internet.

### For remote access, use a VPN or HTTPS reverse proxy

- **Recommended**: Tailscale, WireGuard, or OpenVPN to securely extend your LAN
- **Alternative**: Put OpenCode behind an HTTPS reverse proxy (Caddy, Nginx, Traefik) with proper TLS termination
- **Public/VPS servers**: use HTTPS. The app may warn on public HTTP, but does not block it unless product policy changes.

**Do not expose OpenCode directly to the public internet without strong authentication and transport security.**

### Password storage

- **Native (Android/iOS)**: Passwords are stored in platform secure storage — Android EncryptedSharedPreferences and iOS Keychain — via `@aparajita/capacitor-secure-storage`.
- **Web (development only)**: Passwords fall back to `localStorage` with the prefix `opencode_dev_pw_`. A console warning is shown on each access. This is **insecure** and only suitable for local development.
- Passwords are never logged, never shown in the UI by default, and never included in error messages.
- The `sanitizeUrlForDisplay()` helper strips credentials from URLs before display or logging.

### Web view credentials

When Basic Auth is enabled:

- **iOS**: WKWebView cannot set an `Authorization` header, so credentials are embedded in the web view URL (`http://username:password@host:port/`). The full-credential URL is built only at open time and is **never stored**, logged, or displayed.
- **Android**: credentials are passed to the web view via its native `credentials` option — they never appear in a URL.

For production remote access, prefer HTTPS + VPN so credentials do not travel over cleartext HTTP.

### Auth-less mode

When authentication is disabled on the server, the web view loads the plain URL without any credentials.

---

## Known Limitations

1. **iOS credential-in-URL**: On iOS, Basic Auth credentials must be embedded in the web view URL (WKWebView cannot set an `Authorization` header). The URL is built at open time and never stored or logged.
2. **ntfy + OpenCode v2 required for notifications**: Each server runs the bundled `ntfy-bridge` plugin (v2 event bus) publishing to a shared ntfy topic; the app keeps one subscription instead of one per server. No FCM or push relay is involved — see "Push notifications (ntfy)" above.
3. **Web dev CORS**: Health checks in browser dev mode may be blocked by CORS. Native builds use `CapacitorHttp` which bypasses this.
4. **Single web view**: Only one OpenCode session at a time. The app shows one server's UI in the full screen.
5. **Notifications need a live app process (no FCM/push relay)**: On Android this runs natively inside a `specialUse` foreground service — not subject to the 6-hour background limit — with its config persisted so monitoring survives OS process reclaims; force-stopping the app stops it until next launch. iOS suspends backgrounded apps, so there notifications are delivered only while the app is running (via a JS topic monitor). The Approve / Always allow / Deny buttons exist on Android only; approval replies go to `serverUrl` in each machine's plugin config, which must be reachable from the phone.
6. **Model visibility applies on load**: Per-server show/hide overrides are merged into OpenCode's own persisted model state when the web view loads; if anything actually changed, one automatic reload happens so the UI picks up the new values.

---

## Store Release Readiness

Store-readiness notes, review-risk flags, and draft listing metadata live in:

- `docs/store-readiness.md`
- `docs/webview-injection-review.md`
- `store/`

Before release, run:

```bash
npm run store:verify
npm run lint
npm test
npm run build
```

---

## License

MIT

### Third-party assets

- **Notification icon** — the robot head used in push notifications is based on the [Agent Robot Avatar](https://github.com/CX-ArtLab/agent-robot-avatar) by [CX ArtLab](https://github.com/CX-ArtLab) (MIT License).
