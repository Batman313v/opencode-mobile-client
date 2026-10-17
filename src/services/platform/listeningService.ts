import { Capacitor, registerPlugin } from '@capacitor/core'

/** Pre-translated notification texts so events posted natively stay localized. */
export interface NtfyListeningLabels {
  taskFinished: string
  sessionFinished: string
  approvalNeeded: string
  approveOnce: string
  approveAlways: string
  deny: string
  approved: string
  denied: string
  respondFailed: string
  waitingForInput: string
  waitingBody: string
  genericTitle: string
}

/** Transport config for the native Android ntfy subscription (see ListeningService.java). */
export interface NtfyListeningConfig {
  /** Full SSE subscribe URL including topic, e.g. https://ntfy.example/opencode-mobile/sse. */
  endpoint: string
  /** Optional ntfy access token — sent as a Bearer credential when set. */
  token?: string
  /** Bare ntfy publish URL for approval replies, e.g. https://ntfy.example/opencode-mobile-replies. */
  replyEndpoint: string
  labels: NtfyListeningLabels
}

interface ServerEventsPlugin {
  start(options: { config: NtfyListeningConfig }): Promise<void>
  stop(): Promise<void>
}

const serverEvents = registerPlugin<ServerEventsPlugin>('ServerEvents')

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

/**
 * Starts (or reconfigures) the Android foreground service that subscribes to the ntfy topic on a
 * native thread — messages keep arriving in the background, no web view involved. No-op off
 * Android, where the JS topic monitor covers delivery while the app is active. Failures are
 * swallowed: a rejected start only means monitoring stays quiet until the next apply.
 */
export async function startNtfyListening(config: NtfyListeningConfig): Promise<void> {
  if (!isAndroidNative()) return
  try {
    await serverEvents.start({ config })
  } catch {
    // Service already running or platform rejected it — not fatal.
  }
}

/** Stops the foreground listening service and its ntfy subscription. No-op off Android. */
export async function stopNtfyListening(): Promise<void> {
  if (!isAndroidNative()) return
  try {
    await serverEvents.stop()
  } catch {
    // Service was not running — nothing to do.
  }
}
