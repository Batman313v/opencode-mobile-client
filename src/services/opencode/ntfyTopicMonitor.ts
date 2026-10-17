import { mapNtfyFrame, openSseStream, type NtfyNotification, type SseFrame, type SseStreamHandle } from './events'

export interface NtfySource {
  /** Full SSE subscribe URL including topic, e.g. https://ntfy.example/opencode-mobile/sse. */
  endpoint: string
  /** Optional ntfy access token — sent as a Bearer credential when set. */
  token?: string
}

export interface NtfyTopicMonitorDeps {
  getSource(): Promise<NtfySource | null>
  onNotification(notification: NtfyNotification): void
}

export interface NtfyTopicMonitor {
  /** Reconciles the open stream with the current ntfy source. Idempotent — safe to call repeatedly. */
  start(): Promise<void>
  stop(): void
  isRunning(): boolean
}

/**
 * App-level owner of the ntfy topic subscription for platforms without a native background path
 * (iOS, web dev). Keeps one SSE stream open to the configured endpoint while the app is active —
 * iOS suspends backgrounded apps, so this is the most push-free delivery possible there. All event
 * content arrives through the topic itself (published by our OpenCode plugin), so no per-server
 * credentials are needed here.
 */
export function createNtfyTopicMonitor(deps: NtfyTopicMonitorDeps): NtfyTopicMonitor {
  let handle: SseStreamHandle | null = null
  let running = false
  let queue: Promise<void> = Promise.resolve()

  async function reconcile(): Promise<void> {
    const source = await deps.getSource()
    if (!running) return

    // Sources are tiny and can change (settings edits) — a full rebuild is the simplest correct path.
    handle?.close()
    handle = null
    if (!source || !source.endpoint) return

    const headers: Record<string, string> = {}
    if (source.token) headers.Authorization = `Bearer ${source.token}`

    handle = openSseStream({
      url: source.endpoint,
      headers,
      onFrame(frame: SseFrame): void {
        const notification = mapNtfyFrame(frame)
        if (notification) deps.onNotification(notification)
      },
    })
  }

  function scheduleReconcile(): Promise<void> {
    // Serialize so overlapping start/refresh calls never open duplicate streams.
    const next = queue.then(() => running ? reconcile() : undefined)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    async start(): Promise<void> {
      running = true
      await scheduleReconcile()
    },
    stop(): void {
      running = false
      handle?.close()
      handle = null
      // Any reconcile still queued bails out via the `running` check.
    },
    isRunning(): boolean {
      return running
    },
  }
}
