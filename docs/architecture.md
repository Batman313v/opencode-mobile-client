# Architecture

## Overview

OpenCode Mobile is a Vue 3 + TypeScript application running inside Capacitor on Android and iOS. It wraps the OpenCode Web UI by opening it in an isolated native web view (`@capgo/capacitor-inappbrowser`) with injected mobile fixes, providing a native-feeling shell for server management, secure credential storage, connection lifecycle handling, and native notifications.

---

## Technology Stack

| Layer | Choice | Rationale |
|---|---|---|
| UI Framework | Vue 3 (Composition API) | Lightweight, modern reactive framework |
| Language | TypeScript (strict) | Type safety across the codebase |
| State Management | Pinia | Official Vue 3 state management |
| Routing | Vue Router | SPA routing for native + web shells |
| Mobile Shell | Capacitor 8 | Access to native APIs (HTTP, storage, bars, notifications) |
| OpenCode Web View | `@capgo/capacitor-inappbrowser` | Isolated full-screen web view with script injection and a message bridge |
| Secure Storage | `@aparajita/capacitor-secure-storage` | Keychain (iOS) + EncryptedSharedPreferences (Android) |
| Preferences | `@capacitor/preferences` | Non-sensitive metadata storage |
| Push transport | ntfy topic (self-hosted) | A server-side plugin publishes events to one shared topic — a single app-side subscription survives Android backgrounding where per-server web-view SSE does not |
| Notifications | `@capacitor/local-notifications` | OS permission opt-in; JS-side notifications on non-Android platforms (on Android the listening service and the action receiver post them natively) |
| Background Monitoring (Android) | Project-local `ListeningService` + `NotificationActionReceiver` (Java) | Foreground service running the ntfy topic subscription on a native thread, posting local notifications in the background; the receiver resolves approval actions from notification taps |
| Styling | Tailwind CSS v4 | Utility-first styling, dark/light via `prefers-color-scheme` |
| Testing | Vitest + jsdom | Fast, Vite-native test runner |

---

## Component Tree

```
App.vue                           (root — reconciles the notification pipeline per platform on launch/list/locale changes)
└── <router-view>
    ├── ServerList.vue              (path: / — main page)
    │   └── server cards (inline)
    │       ├── StatusDot.vue
    │       └── actions: Open, Edit, Models, Duplicate, Default, Delete
    │
    ├── ServerProfileForm.vue       (paths: /servers/new, /servers/:id/edit)
    │
    ├── ServerModelsScreen.vue      (path: /servers/:id/models — per-server model show/hide)
    │
    ├── SettingsScreen.vue          (path: /settings — includes Help link)
    │   └── StoreBadges.vue
    │
    ├── HelpScreen.vue              (path: /help)
    │
    └── ConnectionShell.vue         (path: /connect/:id)
        ├── InAppBrowser web view   (full-screen, runs the OpenCode UI)
        │   └── injected scripts: status toolbar + options panel, pull-to-refresh,
        │       mobile composer layout fix, error hiding, model-visibility merge (per-server)
        ├── DemoSessionMock.vue     (demo mode only)
        └── loading / error overlay

Shared UI primitives live in components/ui/ (button, card, dialog, sheet, …).
```

---

## Data Flow

### Profile Management

1. User opens the add/edit form (`/servers/new` or `/servers/:id/edit`)
2. Form validates URL + optional credentials client-side
3. `serverStore.add/update` persists profile metadata to Preferences (JSON)
4. Passwords go to secure storage (Keychain / EncryptedSharedPreferences), never to Preferences
5. The main page polls health for all profiles via the `useServerHealthPoll` composable

### Connection Lifecycle

```
1. User taps "Open" on a server card from the main list (/)
2. Router navigates to /connect/:id → ConnectionShell mounts
3. connectionStore.connect(profileId):
   a. state → 'checking'
   b. checkServerHealth(baseUrl, credentials) — native HTTP probe with timeout
      (CapacitorHttp; no webview CORS involved)
   c. 2xx/3xx → 'connected', health poll interval starts
   d. 401 without stored password → 'auth_required'
   e. 401 with stored password → 'wrong_credentials'
   f. network error / timeout → 'unreachable'
4. On 'connected': the shell opens the OpenCode UI in an isolated native web view:
   a. iOS: Basic Auth embedded in the URL (built fresh, never persisted)
   b. Android: credentials passed via the web view's `credentials` option
5. Every 10s (configurable): health poll re-checks connectivity
6. On failure: state → 'disconnected', exponential reconnect starts
7. Reconnect delays: 1s, 2s, 4s, 8s, 15s, 30s (capped; toggleable in settings)
```

### Native Notifications

Notifications ride **one ntfy topic** — no FCM, no relay server, and no per-server SSE connections from the phone (Android freezes web-view JavaScript while backgrounded; that is why this design replaced the old per-server streams). Each OpenCode server runs the bundled `ntfy-bridge` plugin (`src/opencode-plugin/`, auto-discovered from `~/.config/opencode/plugins/`), which subscribes to the v2 event bus and publishes compact JSON payloads to a shared topic:

| Server-side trigger | Published payload (v1 wire contract) |
|---|---|
| `session.execution.started` followed by `succeeded` on the same session (executions that never started are skipped; v2 does not emit `session.status`) | `{v:1, kind:"idle", serverName, sessionID, title?}` — the title comes from the session API with a 5-minute cache + negative caching |
| `permission.asked` | `{v:1, kind:"permission", serverUrl, serverName, requestID, sessionID, action, resources?, message?}` |

The plugin is configured per machine by a sibling JSON file (`ntfy-bridge.json`: `ntfyServer`, `topic`, `serverUrl`, optional `serverName`); missing or invalid config disables it with a console warning. Its stream loop wraps the event-bus iteration in a 3 s retry loop because v2 subscribers do not auto-resubscribe on failure.

1. At launch App.vue requests OS permission once via `ensureNativeNotificationsOptedIn()` —
   standard prompt on first launch; if the user already granted or denied it in system settings,
   no dialog appears and the outcome is recorded silently. It then calls
   `applyNotificationState()`, which reconciles the pipeline with the persisted setting:
   - Android + enabled → hands the ntfy endpoint (+ optional token, per-server auth map, pre-translated labels)
     to a native foreground service that owns everything from there on
   - other platforms + enabled → opens one subscription to the topic via the JS monitor
   - disabled or unusable endpoint (empty URL / bad topic charset) → stops whichever path is active
2. **Android** — `ListeningService` (project-local Capacitor plugin `ServerEventsPlugin` in
   android/app) runs `GET {endpoint}` on a native thread, not web view JavaScript. It parses SSE
   frames line by line (`data:` lines up to a blank line), maps them with the rules below and posts
   notifications directly through NotificationManager (channel `opencode-server-events`). Permission
   notifications carry **Approve / Always allow / Deny** actions: the tap reaches
   `NotificationActionReceiver`, which POSTs `{"decision"}` to
   `{serverUrl}/api/session/{sessionID}/permission/{requestID}/reply` — with the server's stored
   Basic Auth header when present (an anonymous attempt is still made, since a failure is more
   useful than silence) — and posts a short-lived result notification (approved/denied on 204/200,
   already-handled on 404, could-not-respond otherwise), with the original body as truncated context.
   Dropped streams resume via a `since=<id>` query parameter — ntfy v2 carries the message id inside
   each JSON envelope rather than in SSE id lines; reconnects happen after ~5 s. The service uses the
   `specialUse` foreground type — so it is not subject to the 6-hour background lifetime limit of
   `dataSync` — and persists its config, which a system-initiated restart restores; an explicit stop
   clears it (so a sticky restart can never resurrect monitoring).
3. **Other platforms** — the monitor (`services/opencode/ntfyTopicMonitor.ts`) owns one stream for
   the lifetime of the app process: `GET {endpoint}` via a ReadableStream reader with a Bearer
   header when an access token is set, reconnecting after ~5 s and resuming via `since=<id>`. It
   needs no per-server credentials at all — the topic is the only thing it talks to. Informational
   notifications only (no action buttons). On iOS this covers while-running delivery; background
   delivery there would require push.
4. Reconcile triggers: server list changes (rebuilds the auth map), locale changes (labels are baked
   into the config so natively posted texts stay translated), and ntfy settings edits (debounced
   ~500 ms in SettingsScreen). On Android the config JSON is compared and the service only rebuilds
   its connection when it actually changed; the JS path re-subscribes.
5. Frame mapping: an ntfy envelope (`event: message`, `data: {…message…}`) → inner v1 payload →
   **session-complete** (posted as `<task-finished label>` with the project name in the body,
   falling back to the session title), **approval-needed** (`<approval label>`, body
   `${serverName}: ${message || action}`) or **waiting** (`<waiting label>`, body = the question).
   The **waiting-clear** and **permission-clear** frames are not notifications — they dismiss the
   matching pending one: each delivery path (the Android service, the JS monitor) tracks the posted
   notification id per session/request and cancels it when the question is answered or the request
   is settled elsewhere (CLI, web UI, another phone). Anything else on the topic — plain text,
   other tools' JSON — renders as a generic notification with the raw body truncated.

**Survivability**: on Android the foreground service pins the process with a low-importance ongoing
notification — the same technique ntfy uses for its persistent-connection mode. If the OS kills the
process the service is restarted (sticky) and restores its persisted config; force-stopping the app
stops monitoring until it is launched again. iOS suspends backgrounded apps, so there notifications
are delivered while the app is running only.

The plugin requires **OpenCode v2** on each server (it consumes the v2 event bus). ntfy answers
browser subscriptions with permissive CORS headers, so no `opencode.json` changes are needed for the
JS monitor — including iOS's custom-scheme origin.

### Model Visibility

Per-server show/hide overrides live in the profile metadata (`modelVisibility?: { providerID, modelID, visibility }[]`) — exactly OpenCode's own persisted format:

1. The models screen fetches the server's catalog from `GET /api/model` (CapacitorHttp on native, fetch on web; same Basic Auth as health checks)
2. Each switch shows the effective state: the explicit override when present, otherwise the computed default — mirroring OpenCode's web UI rule (latest release per provider+family within six months, plus models without a finite release date)
3. Toggling adds or removes an explicit entry; toggling back to the default removes it, so overrides stay minimal
4. On every web view load (`browserPageLoaded`), ConnectionShell injects the script built by `buildModelVisibilityScript()`, which merges the saved overrides into OpenCode's own persisted state — the localStorage key `opencode.global.dat:model` in the webview origin
5. The merge runs immediately and again after ~1.5 s (OpenCode hydrates that state synchronously at bootstrap); only if storage actually changed does it trigger a single `location.reload()` so the in-memory app picks up the new values — idempotent, cannot loop; with no overrides no script is injected at all
6. OpenCode stores this state globally per origin, so one set of overrides applies to every project/chat/workspace on that server

### QR Pairing

The add-server screen has exactly two text boxes — name and address (IP + port, scheme-free; normalized to a full URL on save). On native platforms the address box doubles as the pairing target for `opencode pair` QR codes:

1. The address is where the scanned code gets redeemed, which matters because `opencode pair` may advertise only `127.0.0.1` in its QR — unreachable from the phone
2. Scanning reads either the QR payload (`{"code","urls"}` JSON) or a plain link of the form `http://host:port/auth/connect/<code>`; either way only the code is needed, since redemption happens at the entered address
3. All candidates are redeemed in parallel (`GET /auth/connect/<code>`, CapacitorHttp on native, fetch on web): the user-supplied address first, then Tailscale CGNAT addresses (100.64.0.0/10), then the rest — so pairing lands on the tailnet whenever it is reachable
4. The code is single-use: exactly one address answers `{ token }`; that token works as the Basic Auth password (username `opencode`) at every address of the server, and is prefilled into the form together with the paired address
5. If the preferred address answered but lost the redemption race, a follow-up health check confirms it accepts the token before keeping it; any 401 answer reports the link as expired/used, otherwise unreachable
6. The redeemed token is cached per code in the form, so saving (or retrying) never re-spends the code

---

## Route Design

| Path | Component | Purpose |
|---|---|---|
| `/` | `ServerList` | Main page — all saved server profiles; brand header with **+** (add) and settings actions |
| `/servers/new` | `ServerProfileForm` | Create a new server profile — manually or by pairing (`opencode pair` QR/link) |
| `/servers/:id/edit` | `ServerProfileForm` | Edit an existing server profile |
| `/servers/:id/models` | `ServerModelsScreen` | Per-server model visibility — show/hide models for every session on that server |
| `/settings` | `SettingsScreen` | Timeouts, poll interval, reconnect toggle, notifications, language, about + help link |
| `/help` | `HelpScreen` | Setup and troubleshooting guide |
| `/connect/:id` | `ConnectionShell` | Full-screen native web view running the OpenCode UI |

---

## State Management

### serverStore (Pinia)

- `profiles: ServerProfile[]` — all saved server profiles
- Profile CRUD (add / edit / delete), persisted to Preferences
- `getPassword(id)` — reads a password from secure storage on demand
- Health results update each profile's `lastStatus` / `lastConnectedAt`

### connectionStore (Pinia)

- `state: ConnectionState` — current state-machine value
- `activeServerId` / `activeServer` — currently connected server profile
- `reconnectAttempt` — counter driving exponential backoff
- `healthCheckTimeout` / `healthPollInterval` / `exponentialReconnectEnabled` — user settings from the Settings screen
- `lastWebviewServerId` — last server opened in the web view (drives status display on the list page)
- `connect(id)` — health check + transition to connected on success
- `disconnect()` — stops polling, resets state
- `cancelReconnect()` — aborts reconnection attempts

---

## Storage Layer

| Data | Backend | Notes |
|---|---|---|
| Server profiles (metadata) | Preferences (JSON) | URLs, names, auth flags, default flag, last status |
| Passwords | Secure storage plugin | Keychain on iOS / EncryptedSharedPreferences on Android; localStorage fallback for web dev only |
| Notification preference | Preferences | `{ enabled, decided, ntfyServerUrl, ntfyTopic, ntfyToken }` — `decided` means the user was already asked (first launch or settings); missing ntfy fields normalize to defaults on load |
| Model visibility overrides | Preferences (JSON) | Part of the server profile metadata (`modelVisibility`), stored in OpenCode's own entry format so it can be merged 1:1 into the webview state |

The credential-bearing web view URL is never stored — it is built fresh at open time and discarded when the web view closes.

---

## Security Architecture

1. **Passwords never touch non-secure storage** — they live only in Keychain / EncryptedSharedPreferences (localStorage in web dev mode).
2. **No credential-in-URL persistence** — the full auth URL is built fresh at web-view open time and discarded on close.
3. **Native HTTP stack for health checks** — `CapacitorHttp` bypasses webview CORS entirely; credentials travel in request headers, never in a stored URL.
4. **Isolated web view** — OpenCode runs in an InAppBrowser context separate from the app's own web view. Injected scripts cannot access app storage and communicate only through the message bridge (`mobileApp.postMessage` / `messageFromWebview`).

---

## Platform Integration

- `systemBars.ts` — status/navigation bar configuration, applied on launch from the main page
- `backButton.ts` — Android hardware back integration (closes the web view / returns to the server list)
- `listeningService.ts` — wrapper for the project-local `ServerEvents` Capacitor plugin; hands the ntfy endpoint config (endpoint, optional token, per-server auth map keyed by raw + slash-trimmed base URL, pre-translated labels) to / stops the native Android foreground service (`ListeningService`)
- `nativeNotifications.ts` — notification settings (enable switch + ntfy URL/topic/token), launch-time permission opt-in, emit bridge for `@capacitor/local-notifications`, and `applyNotificationState()` which reconciles the whole pipeline (native Android service **or** JS monitor, per platform) with the persisted setting

---

## Testing Strategy

| Test file | Coverage |
|---|---|
| `url.test.ts` | URL normalization, validation, display sanitization, credential URL construction |
| `auth.test.ts` | Basic Auth header generation + credential encoding |
| `health.test.ts` | Health probe status classification (connected / auth_required / wrong_credentials / unreachable) |
| `profileStorage.test.ts` | Profile CRUD, default selection, duplication |
| `connectionState.test.ts` | Connection state machine: connect / disconnect / reconnect transitions |
| `events.test.ts` | SSE frame parser (chunk boundaries, CRLF, multi-line data), ntfy envelope → notification mapping, stream client (auth header, reconnect, since= resume) |
| `ntfyTopicMonitor.test.ts` | Topic monitor reconciliation (open / close / re-subscribe on source change), bearer header, frame fan-out with unmappable-frame drop |
| `ntfyBridge.test.ts` | Bridge plugin: config parsing/validation, execution started/succeeded transitions (unstarted-execution skip, per-turn publish, title fetch + truncation), permission payloads (resources/message omission rules) |
| `nativeNotifications.test.ts` | Notification settings persistence, launch-time opt-in, emit bridge, platform-branched pipeline orchestration (Android native config handoff incl. auth headers / demo skip / rebuild dedupe; JS monitor start/stop elsewhere) |
| `modelVisibility.test.ts` | Model catalog fetch (mapping, auth header, errors), default-visibility rules, in-webview state merge source, injection script builder |

Vitest with jsdom; Capacitor plugins are mocked.
