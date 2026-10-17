import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'ios'),
  },
}))

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
  },
}))

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    createChannel: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
  },
}))

const { fakeMonitor } = vi.hoisted(() => ({
  fakeMonitor: { start: vi.fn(async () => undefined), stop: vi.fn(), isRunning: vi.fn(() => true) },
}))

vi.mock('@/services/opencode/ntfyTopicMonitor', () => ({
  createNtfyTopicMonitor: vi.fn(() => fakeMonitor),
}))

vi.mock('@/services/platform/listeningService', () => ({
  startNtfyListening: vi.fn(async (_config: unknown) => undefined),
  stopNtfyListening: vi.fn(async () => undefined),
}))

import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { LocalNotifications } from '@capacitor/local-notifications'
import { setActivePinia, createPinia } from 'pinia'
import { createNtfyTopicMonitor } from '@/services/opencode/ntfyTopicMonitor'
import { startNtfyListening, stopNtfyListening } from '@/services/platform/listeningService'
import {
  applyNotificationState,
  disableNativeNotificationsFromSettings,
  emitServerEventNotification,
  enableNativeNotificationsFromSettings,
  ensureNativeNotificationsOptedIn,
  loadNativeNotificationSettings,
  resetNotificationPipelineForTests,
} from '@/services/platform/nativeNotifications'

/** The app's built-in defaults — no topic, users create their own. */
const APP_DEFAULTS = {
  ntfyServerUrl: 'https://ntfy.sh',
  ntfyTopic: '',
  ntfyToken: '',
}

/** A fully user-configured transport, for tests that simulate stored settings. */
const CONFIGURED = {
  ntfyServerUrl: 'https://notify.example.net',
  ntfyTopic: 'opencode-mobile',
  ntfyToken: '',
}

function defaultSettings(overrides: Record<string, unknown> = {}) {
  return { enabled: false, decided: false, ...APP_DEFAULTS, ...overrides }
}

function fullSettings(overrides: Record<string, unknown> = {}) {
  return { enabled: false, decided: true, ...CONFIGURED, ...overrides }
}

function storedSettings() {
  const call = vi.mocked(Preferences.set).mock.calls.at(-1)
  return call ? JSON.parse(call[0].value) : null
}

describe('native notification settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks keeps implementations, so pin the platform back to native every test.
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
    vi.mocked(Preferences.get).mockResolvedValue({ value: null })
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'granted' })
    vi.mocked(LocalNotifications.requestPermissions).mockResolvedValue({ display: 'granted' })
  })

  it('asks for system permission on first launch and records the outcome', async () => {
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'prompt' })

    await ensureNativeNotificationsOptedIn()

    expect(LocalNotifications.requestPermissions).toHaveBeenCalledTimes(1)
    expect(storedSettings()).toEqual(defaultSettings({ enabled: true, decided: true }))
  })

  it('records a first-launch denial without re-asking on later starts', async () => {
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'denied' })
    vi.mocked(LocalNotifications.requestPermissions).mockResolvedValue({ display: 'denied' })

    await ensureNativeNotificationsOptedIn()
    expect(storedSettings()).toEqual(defaultSettings({ decided: true }))

    vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(storedSettings()) })
    await ensureNativeNotificationsOptedIn()
    expect(LocalNotifications.requestPermissions).toHaveBeenCalledTimes(1)
  })

  it('enables silently when the OS permission was already granted outside the app', async () => {
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'granted' })

    await ensureNativeNotificationsOptedIn()

    expect(LocalNotifications.requestPermissions).not.toHaveBeenCalled()
    expect(storedSettings()).toEqual(defaultSettings({ enabled: true, decided: true }))
  })

  it('does nothing on non-native platforms', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false)

    await ensureNativeNotificationsOptedIn()

    expect(Preferences.set).not.toHaveBeenCalled()
  })

  it('honors a disabled settings switch without asking again', async () => {
    await disableNativeNotificationsFromSettings()
    expect(storedSettings()).toEqual(defaultSettings({ decided: true }))

    vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(storedSettings()) })
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'prompt' })
    await ensureNativeNotificationsOptedIn()
    expect(LocalNotifications.requestPermissions).not.toHaveBeenCalled()
  })

  it('requests system permission when enabled from settings', async () => {
    await expect(enableNativeNotificationsFromSettings()).resolves.toBe(true)

    expect(storedSettings()).toEqual(defaultSettings({ enabled: true, decided: true }))
  })

  it('loads defaults (including the ntfy transport fields) when settings are absent or invalid', async () => {
    await expect(loadNativeNotificationSettings()).resolves.toEqual(defaultSettings())

    vi.mocked(Preferences.get).mockResolvedValue({ value: 'nope' })
    await expect(loadNativeNotificationSettings()).resolves.toEqual(defaultSettings())
  })

  it('emits a local notification without triggering a new system prompt', async () => {
    await emitServerEventNotification('Approval needed', 'Review the shell command.')

    expect(LocalNotifications.requestPermissions).not.toHaveBeenCalled()
    expect(LocalNotifications.schedule).toHaveBeenCalledWith({
      notifications: [expect.objectContaining({
        title: 'Approval needed',
        body: 'Review the shell command.',
      })],
    })
  })

  it('does not emit when native permission has been revoked', async () => {
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'denied' })

    await emitServerEventNotification('Done', '')

    expect(LocalNotifications.schedule).not.toHaveBeenCalled()
  })
})

describe('applyNotificationState (JS monitor path)', () => {
  beforeEach(() => {
    // Reset first: it may call stop() on a monitor left over from an earlier test.
    resetNotificationPipelineForTests()
    vi.clearAllMocks()
    fakeMonitor.start.mockImplementation(async () => undefined)
    fakeMonitor.stop.mockImplementation(() => undefined)
  })

  function storeSettings(overrides: Record<string, unknown> = {}): void {
    vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(fullSettings(overrides)) })
  }

  it('starts the JS topic monitor when enabled (no foreground service exists off Android)', async () => {
    storeSettings({ enabled: true })

    await applyNotificationState()

    expect(startNtfyListening).not.toHaveBeenCalled()
    expect(createNtfyTopicMonitor).toHaveBeenCalledTimes(1)
    expect(fakeMonitor.start).toHaveBeenCalledTimes(1)
  })

  it('re-applies stream reconciliation without touching the native service', async () => {
    storeSettings({ enabled: true })

    await applyNotificationState()
    await applyNotificationState()

    expect(startNtfyListening).not.toHaveBeenCalled()
    // Re-applying still reconciles the subscription (e.g. after a settings edit).
    expect(fakeMonitor.start).toHaveBeenCalledTimes(2)
  })

  it('starts nothing when the ntfy endpoint is unusable', async () => {
    storeSettings({ enabled: true, ntfyServerUrl: '' })

    await applyNotificationState()

    expect(startNtfyListening).not.toHaveBeenCalled()
    expect(createNtfyTopicMonitor).not.toHaveBeenCalled()
  })

  it('stops the JS monitor when notifications are disabled', async () => {
    storeSettings({ enabled: true })
    await applyNotificationState()

    storeSettings({ enabled: false })
    await applyNotificationState()

    expect(stopNtfyListening).not.toHaveBeenCalled()
    expect(fakeMonitor.stop).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh monitor after a disable/enable cycle', async () => {
    storeSettings({ enabled: true })
    await applyNotificationState()

    storeSettings({ enabled: false })
    await applyNotificationState()

    storeSettings({ enabled: true })
    await applyNotificationState()

    expect(createNtfyTopicMonitor).toHaveBeenCalledTimes(2)
  })
})

describe('notification mapping and self-clearing (JS monitor path)', () => {
  beforeEach(async () => {
    resetNotificationPipelineForTests()
    vi.clearAllMocks()
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
    vi.mocked(Capacitor.getPlatform).mockReturnValue('ios')
    vi.mocked(Preferences.get).mockResolvedValue({
      value: JSON.stringify(fullSettings({ enabled: true })),
    })
    vi.mocked(LocalNotifications.checkPermissions).mockResolvedValue({ display: 'granted' })
    vi.mocked(LocalNotifications.schedule).mockResolvedValue({ notifications: [] })
    vi.mocked(LocalNotifications.cancel).mockResolvedValue(undefined)
    await applyNotificationState()
  })

  /** The onNotification callback the pipeline handed to the (mocked) topic monitor. */
  function monitorCallback() {
    const deps = vi.mocked(createNtfyTopicMonitor).mock.calls.at(-1)?.[0]
    expect(deps?.onNotification).toBeTypeOf('function')
    return deps!.onNotification
  }

  function lastScheduled() {
    const call = vi.mocked(LocalNotifications.schedule).mock.calls.at(-1)
    return call?.[0].notifications[0]
  }

  it('posts a completion notification titled "Task finished" with the project as body', async () => {
    const onNotification = monitorCallback()

    await onNotification({ kind: 'session-complete', project: 'opencode-mobile-client', sessionTitle: 'Project overview' })

    expect(lastScheduled()).toMatchObject({ title: 'Task finished', body: 'opencode-mobile-client' })
  })

  it('falls back to the session title, then the finished text, when the project is unknown', async () => {
    const onNotification = monitorCallback()

    await onNotification({ kind: 'session-complete', sessionTitle: 'Project overview' })
    expect(lastScheduled()).toMatchObject({ title: 'Task finished', body: 'Project overview' })

    await onNotification({ kind: 'session-complete' })
    expect(lastScheduled()).toMatchObject({ title: 'Task finished', body: 'The session has finished.' })
  })

  it('dismisses the approval notification when a permission-clear arrives for its request', async () => {
    const onNotification = monitorCallback()

    await onNotification({ kind: 'approval-needed', serverName: 'Alpha', requestID: 'per_1', action: 'bash', summary: 'Run a command' })
    const posted = lastScheduled()!
    expect(posted).toMatchObject({ title: 'Approval needed', body: 'Alpha: Run a command' })

    await onNotification({ kind: 'permission-clear', requestID: 'per_1' })

    expect(LocalNotifications.cancel).toHaveBeenCalledWith({ notifications: [{ id: posted.id }] })
  })

  it('ignores permission-clear frames for requests it never posted', async () => {
    const onNotification = monitorCallback()

    await onNotification({ kind: 'permission-clear', requestID: 'per_unknown' })

    expect(LocalNotifications.cancel).not.toHaveBeenCalled()
  })

  it('dismisses the waiting notification when a waiting-clear arrives for its session', async () => {
    const onNotification = monitorCallback()

    await onNotification({ kind: 'waiting', serverName: 'Alpha', sessionID: 'ses_1', title: 'Which database?' })
    const posted = lastScheduled()!
    expect(posted).toMatchObject({ title: 'Waiting for input', body: 'Which database?' })

    await onNotification({ kind: 'waiting-clear', sessionID: 'ses_1' })

    expect(LocalNotifications.cancel).toHaveBeenCalledWith({ notifications: [{ id: posted.id }] })
  })
})

describe('applyNotificationState (android native service)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Reset first: it may call stop() on a monitor left over from an earlier test.
    resetNotificationPipelineForTests()
    vi.clearAllMocks()
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
    vi.mocked(Capacitor.getPlatform).mockReturnValue('android')
  })

  function storeSettings(overrides: Record<string, unknown> = {}): void {
    vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(fullSettings(overrides)) })
  }

  it('hands the ntfy endpoint and reply publish URL to the native service and skips the JS monitor', async () => {
    storeSettings({ enabled: true })

    await applyNotificationState()

    expect(createNtfyTopicMonitor).not.toHaveBeenCalled()
    expect(startNtfyListening).toHaveBeenCalledTimes(1)
    const [config] = vi.mocked(startNtfyListening).mock.calls[0]
    expect(config.endpoint).toBe('https://notify.example.net/opencode-mobile/sse')
    // Replies travel back through ntfy: the phone publishes to <topic>-replies — no server address needed.
    expect(config.replyEndpoint).toBe('https://notify.example.net/opencode-mobile-replies')
    // Labels are pre-translated so natively posted notifications stay localized.
    expect(config.labels.taskFinished).toBeTruthy()
  })

  it('rebuilds the native subscription when the ntfy settings change', async () => {
    storeSettings({ enabled: true })
    await applyNotificationState()

    storeSettings({ enabled: true, ntfyServerUrl: 'https://other.example' })
    await applyNotificationState()

    expect(startNtfyListening).toHaveBeenCalledTimes(2)
  })

  it('passes the optional ntfy token through and omits it when empty', async () => {
    storeSettings({ enabled: true, ntfyToken: 'tok' })
    await applyNotificationState()
    expect(vi.mocked(startNtfyListening).mock.calls[0]?.[0].token).toBe('tok')

    resetNotificationPipelineForTests()
    vi.clearAllMocks()
    storeSettings({ enabled: true })
    await applyNotificationState()
    expect(vi.mocked(startNtfyListening).mock.calls[0]?.[0].token).toBeUndefined()
  })

  it('does not rebuild the native subscription when re-applied with an unchanged config', async () => {
    storeSettings({ enabled: true })

    await applyNotificationState()
    await applyNotificationState()

    expect(startNtfyListening).toHaveBeenCalledTimes(1)
  })

  it('stops the native service when notifications are disabled', async () => {
    storeSettings({ enabled: true })
    await applyNotificationState()

    storeSettings({ enabled: false })
    await applyNotificationState()

    expect(stopNtfyListening).toHaveBeenCalledTimes(1)
  })
})
