import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Preferences } from '@capacitor/preferences'
import { t } from '@/i18n'
import type { NtfyNotification } from '@/services/opencode/events'
import { createNtfyTopicMonitor, type NtfySource, type NtfyTopicMonitor } from '@/services/opencode/ntfyTopicMonitor'
import { startNtfyListening, stopNtfyListening, type NtfyListeningConfig } from './listeningService'

const CHANNEL_ID = 'opencode-server-events'
const MAX_ANDROID_NOTIFICATION_ID = 2147483647
const SETTINGS_KEY = 'opencode_native_notifications'

let channelCreated = false
let nextNotificationId = Math.max(1, Date.now() % MAX_ANDROID_NOTIFICATION_ID)

export type NativeNotificationSettings = {
  enabled: boolean
  /** The user has already been asked (on first launch or via the settings screen). */
  decided: boolean
  ntfyServerUrl: string
  ntfyTopic: string
  ntfyToken: string
}

const DEFAULT_SETTINGS: NativeNotificationSettings = {
  enabled: false,
  decided: false,
  // Public ntfy default instance; the topic is intentionally unset — users create their own topic
  // and enter it here and in the plugin config (see README "Push notifications (ntfy)").
  ntfyServerUrl: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyToken: '',
}

async function ensureNotificationChannel(): Promise<void> {
  if (channelCreated || Capacitor.getPlatform() !== 'android') return

  await LocalNotifications.createChannel({
    id: CHANNEL_ID,
    name: 'OpenCode notifications',
    description: 'Notifications from a connected OpenCode server.',
    importance: 4,
    visibility: 0,
    vibration: true,
  })
  channelCreated = true
}

async function saveNotificationSettings(settings: NativeNotificationSettings): Promise<void> {
  await Preferences.set({ key: SETTINGS_KEY, value: JSON.stringify(settings) })
}

/** Resolves the OS permission state, showing the system prompt only if it has not been asked yet. */
async function requestNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false

  const current = await LocalNotifications.checkPermissions()
  const result = current.display === 'granted'
    ? current
    : await LocalNotifications.requestPermissions()

  const granted = result.display === 'granted'
  if (granted) await ensureNotificationChannel()
  return granted
}

async function hasNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false
  const current = await LocalNotifications.checkPermissions()
  const granted = current.display === 'granted'
  if (granted) await ensureNotificationChannel()
  return granted
}

function getNextNotificationId(): number {
  nextNotificationId = (nextNotificationId % MAX_ANDROID_NOTIFICATION_ID) + 1
  return nextNotificationId
}

export async function loadNativeNotificationSettings(): Promise<NativeNotificationSettings> {
  const { value } = await Preferences.get({ key: SETTINGS_KEY })
  if (!value) return { ...DEFAULT_SETTINGS }

  try {
    // Normalize to the known fields so stale keys from older app versions are dropped on next save.
    const parsed = JSON.parse(value) as Partial<NativeNotificationSettings>
    return {
      enabled: Boolean(parsed.enabled),
      decided: Boolean(parsed.decided),
      ntfyServerUrl: typeof parsed.ntfyServerUrl === 'string' ? parsed.ntfyServerUrl : DEFAULT_SETTINGS.ntfyServerUrl,
      ntfyTopic: typeof parsed.ntfyTopic === 'string' && parsed.ntfyTopic.trim()
        ? parsed.ntfyTopic
        : DEFAULT_SETTINGS.ntfyTopic,
      ntfyToken: typeof parsed.ntfyToken === 'string' ? parsed.ntfyToken : '',
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/** Persists the ntfy transport fields (server URL, topic, optional token) from the settings screen. */
export async function saveNtfySettings(input: { serverUrl: string; topic: string; token: string }): Promise<void> {
  const current = await loadNativeNotificationSettings()
  await saveNotificationSettings({
    ...current,
    ntfyServerUrl: input.serverUrl.trim(),
    ntfyTopic: input.topic.trim(),
    ntfyToken: input.token.trim(),
  })
}

/**
 * Runs once per app start (see App.vue): asks the OS for notification access on first launch so
 * users get the standard system prompt without needing a live server event. If permission was
 * already granted or denied in system settings, no dialog appears — we just record the outcome.
 */
export async function ensureNativeNotificationsOptedIn(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return

  const settings = await loadNativeNotificationSettings()
  if (settings.enabled || settings.decided) return

  const granted = await requestNotificationPermission()
  await saveNotificationSettings({ ...settings, enabled: granted, decided: true })
}

export async function enableNativeNotificationsFromSettings(): Promise<boolean> {
  const granted = await requestNotificationPermission()
  await saveNotificationSettings({
    ...(await loadNativeNotificationSettings()),
    enabled: granted,
    decided: true,
  })
  return granted
}

export async function disableNativeNotificationsFromSettings(): Promise<void> {
  await saveNotificationSettings({
    ...(await loadNativeNotificationSettings()),
    enabled: false,
    decided: true,
  })
}

/** Posts a local notification and returns its id (null when no permission) so clear frames can cancel it. */
export async function emitServerEventNotification(title: string, body: string): Promise<number | null> {
  const cleanTitle = title.trim() || 'OpenCode'
  const cleanBody = body.trim()
  if (!(await hasNotificationPermission())) return null

  const id = getNextNotificationId()
  await LocalNotifications.schedule({
    notifications: [{
      id,
      title: cleanTitle,
      body: cleanBody,
      largeBody: cleanBody || undefined,
      channelId: CHANNEL_ID,
      extra: { source: 'opencode-server-event' },
    }],
  })
  return id
}

function ellipsize(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
}

/** Full SSE subscribe URL for the configured ntfy instance and topic; '' when either is unusable. */
export function buildNtfyEndpoint(settings: NativeNotificationSettings): string {
  const server = settings.ntfyServerUrl.trim().replace(/\/+$/, '')
  const topic = settings.ntfyTopic.trim()
  if (!/^https?:\/\//.test(server) || !/^[A-Za-z0-9_-]+$/.test(topic)) return ''
  // ntfy v2 serves its web app at the bare topic path — the SSE stream lives under /sse.
  return `${server}/${topic}/sse`
}

/** Bare publish URL for approval replies; mirrors the plugin's default reply topic `<topic>-replies`. */
export function buildNtfyReplyEndpoint(settings: NativeNotificationSettings): string {
  const server = settings.ntfyServerUrl.trim().replace(/\/+$/, '')
  const topic = settings.ntfyTopic.trim()
  if (!/^https?:\/\//.test(server) || !/^[A-Za-z0-9_-]+$/.test(topic)) return ''
  return `${server}/${topic}-replies`
}

let monitor: NtfyTopicMonitor | null = null
/** Current ntfy source for the JS monitor; read lazily so settings edits take effect on re-apply. */
let ntfySource: NtfySource | null = null
/** JSON of the last config handed to the native service — avoids rebuilding its subscription. */
let lastAndroidConfigJson = ''
let notificationsActive = false

/**
 * Notification ids of pending event notifications, keyed by `approval:<requestID>` and
 * `waiting:<sessionID>`, so a matching clear frame (the request was settled or the question
 * answered elsewhere, e.g. in the CLI) can dismiss them.
 */
const pendingNotificationIds = new Map<string, number>()

async function cancelPendingNotification(key: string): Promise<void> {
  const id = pendingNotificationIds.get(key)
  if (id === undefined) return
  pendingNotificationIds.delete(key)
  await LocalNotifications.cancel({ notifications: [{ id }] })
}

async function handleNtfyNotification(notification: NtfyNotification): Promise<void> {
  if (!notificationsActive) return

  // Clear frames dismiss a pending notification posted earlier — they are not notifications.
  if (notification.kind === 'waiting-clear') {
    await cancelPendingNotification(`waiting:${notification.sessionID}`)
    return
  }
  if (notification.kind === 'permission-clear') {
    await cancelPendingNotification(`approval:${notification.requestID}`)
    return
  }

  let title: string
  let body: string
  let pendingKey: string | null = null
  if (notification.kind === 'session-complete') {
    title = t('notify.taskFinished')
    // Body names the project so several running at once can be told apart.
    body = notification.project ?? notification.sessionTitle ?? t('notify.sessionFinished')
  } else if (notification.kind === 'approval-needed') {
    title = t('notify.approvalNeeded')
    // Prefer the LLM summary (what the action will do), then the raw detail, then the action name.
    const detail = notification.summary || notification.message || notification.action
    body = ellipsize(`${notification.serverName}: ${detail || '?'}`)
    pendingKey = `approval:${notification.requestID}`
  } else if (notification.kind === 'waiting') {
    title = t('notify.waitingForInput')
    body = notification.title
      ? ellipsize(notification.title)
      : t('notify.waitingBody')
    pendingKey = `waiting:${notification.sessionID}`
  } else {
    title = t('notify.genericTitle')
    body = ellipsize(notification.text, 300)
  }

  const id = await emitServerEventNotification(title, body)
  if (id !== null && pendingKey !== null) pendingNotificationIds.set(pendingKey, id)
}

/** Builds the native service config (ntfy endpoint + reply publish URL + translated labels). */
function buildAndroidListeningConfig(settings: NativeNotificationSettings, endpoint: string): NtfyListeningConfig {
  return {
    endpoint,
    token: settings.ntfyToken.trim() || undefined,
    replyEndpoint: buildNtfyReplyEndpoint(settings),
    labels: {
      taskFinished: t('notify.taskFinished'),
      sessionFinished: t('notify.sessionFinished'),
      approvalNeeded: t('notify.approvalNeeded'),
      approveOnce: t('notify.approveOnce'),
      approveAlways: t('notify.approveAlways'),
      deny: t('notify.deny'),
      approved: t('notify.approved'),
      denied: t('notify.denied'),
      respondFailed: t('notify.respondFailed'),
      waitingForInput: t('notify.waitingForInput'),
      waitingBody: t('notify.waitingBody'),
      genericTitle: t('notify.genericTitle'),
    },
  }
}

/**
 * Reconciles the app-level notification pipeline with the stored settings. Call it at app start
 * (App.vue), after the settings toggle or locale changes anything, and whenever the server list
 * changes. Delivery is ntfy-only — servers publish events to the configured topic via our OpenCode
 * plugin:
 * - Android + enabled: the foreground listening service owns a single native subscription to the
 *   ntfy topic and posts notifications itself (with Approve/Deny actions) — works in the background
 * - other platforms + enabled: a JS monitor keeps one stream open while the app is active (iOS
 *   suspends backgrounded apps, so this is the most push-free delivery possible there)
 * - disabled or missing endpoint: stops whichever path is running
 */
export async function applyNotificationState(): Promise<void> {
  const settings = await loadNativeNotificationSettings()
  const androidNative = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
  const endpoint = buildNtfyEndpoint(settings)

  if (settings.enabled && endpoint) {
    notificationsActive = true
    if (androidNative) {
      // Labels are part of the JSON, so a locale change also triggers a rebuild.
      const config = buildAndroidListeningConfig(settings, endpoint)
      const json = JSON.stringify(config)
      if (json !== lastAndroidConfigJson) {
        lastAndroidConfigJson = json
        await startNtfyListening(config)
      }
    } else {
      ntfySource = { endpoint, token: settings.ntfyToken.trim() || undefined }
      if (!monitor) {
        // getSource reads the ref lazily so a later apply with new settings re-subscribes.
        monitor = createNtfyTopicMonitor({
          getSource: () => Promise.resolve(ntfySource),
          onNotification: handleNtfyNotification,
        })
      }
      await monitor.start()
    }
  } else {
    notificationsActive = false
    ntfySource = null
    if (monitor) {
      monitor.stop()
      monitor = null
    }
    if (lastAndroidConfigJson !== '') {
      lastAndroidConfigJson = ''
      await stopNtfyListening()
    }
  }
}

/** Test hook: drops cached pipeline state so tests start from a clean slate. */
export function resetNotificationPipelineForTests(): void {
  monitor?.stop()
  monitor = null
  ntfySource = null
  lastAndroidConfigJson = ''
  notificationsActive = false
  pendingNotificationIds.clear()
}
