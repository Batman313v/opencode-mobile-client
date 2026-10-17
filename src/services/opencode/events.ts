export type SseFrame = { event?: string; id?: string; data: string }

/**
 * Stateful SSE frame parser. Feed it accumulated stream text; it invokes onFrame for every
 * complete frame (delimited by a blank line) and returns the unconsumed tail to carry over into
 * the next chunk. Frames with an explicit `event:` or `id:` field report them; data-only frames
 * are reported with those fields undefined.
 */
export function parseSseChunk(buffer: string, onFrame: (frame: SseFrame) => void): string {
  const parts = buffer.split(/\r?\n\r?\n/)
  if (parts.length < 2) return buffer

  for (let i = 0; i < parts.length - 1; i++) {
    const frame: SseFrame = { data: '' }
    for (const line of parts[i].split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const idx = line.indexOf(':')
      const field = idx === -1 ? line : line.slice(0, idx)
      let value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '')
      if (field === 'event') frame.event = value
      else if (field === 'id') frame.id = value
      else if (field === 'data') frame.data = frame.data ? `${frame.data}\n${value}` : value
    }
    if (frame.data || frame.event) onFrame(frame)
  }

  return parts[parts.length - 1]
}

/** Notification request mapped from an ntfy message. */
export type NtfyNotification =
  | { kind: 'session-complete'; project?: string; sessionTitle?: string }
  | { kind: 'approval-needed'; serverName: string; requestID: string; action: string; message?: string; summary?: string }
  | { kind: 'waiting'; serverName: string; sessionID: string; title?: string }
  | { kind: 'waiting-clear'; sessionID: string }
  | { kind: 'permission-clear'; requestID: string }
  | { kind: 'generic'; text: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

/**
 * Maps one ntfy SSE frame to a notification request. ntfy delivers published messages as
 * `event: message` frames whose data is a JSON envelope `{ id, time, event, topic, message, ... }`;
 * the inner `message` field carries the body text. Bodies posted by our OpenCode plugin are v1
 * bridge payloads (JSON with `v: 1`) and map to structured notifications; anything else on the
 * topic — e.g. plain-text posts from other tools — maps to a generic notification.
 */
export function mapNtfyFrame(frame: SseFrame): NtfyNotification | null {
  if (frame.event && frame.event !== 'message') return null

  let envelope: unknown
  try {
    envelope = JSON.parse(frame.data)
  } catch {
    return null
  }
  if (!isRecord(envelope)) return null

  const text = typeof envelope.message === 'string' ? envelope.message : ''
  if (text.trim() === '') return null

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { kind: 'generic', text }
  }
  if (!isRecord(payload)) return { kind: 'generic', text }

  const serverName = typeof payload.serverName === 'string' && payload.serverName.trim()
    ? payload.serverName.trim()
    : 'OpenCode'

  if (payload.v === 1 && payload.kind === 'idle') {
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : undefined
    const project = typeof payload.project === 'string' && payload.project.trim()
      ? payload.project.trim()
      : undefined
    // The body names the project — serverName is not shown for completions.
    return { kind: 'session-complete', project, sessionTitle: title }
  }

  if (payload.v === 1 && payload.kind === 'permission') {
    const requestID = typeof payload.requestID === 'string' ? payload.requestID : ''
    const action = typeof payload.action === 'string' ? payload.action : ''
    const message = typeof payload.message === 'string' && payload.message.trim()
      ? payload.message.trim()
      : undefined
    const summary = typeof payload.summary === 'string' && payload.summary.trim()
      ? payload.summary.trim()
      : undefined
    return {
      kind: 'approval-needed',
      serverName,
      requestID,
      action,
      message,
      summary,
    }
  }

  if (payload.v === 1 && payload.kind === 'waiting') {
    const sessionID = typeof payload.sessionID === 'string' ? payload.sessionID : ''
    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : undefined
    return { kind: 'waiting', serverName, sessionID, title }
  }

  // Clear frames dismiss a previously posted notification (matched by session/request id) — they
  // are not notifications of their own.
  if (payload.v === 1 && payload.kind === 'waiting-clear') {
    const sessionID = typeof payload.sessionID === 'string' ? payload.sessionID : ''
    return sessionID ? { kind: 'waiting-clear', sessionID } : null
  }

  if (payload.v === 1 && payload.kind === 'permission-clear') {
    const requestID = typeof payload.requestID === 'string' ? payload.requestID : ''
    return requestID ? { kind: 'permission-clear', requestID } : null
  }

  // JSON that is not a v1 bridge payload — show it as-is.
  return { kind: 'generic', text }
}

const RECONNECT_DELAY_MS = 5000
const MAX_BUFFER_LENGTH = 4_194_304
const BUFFER_KEEP_TAIL = 65_536

export type SseStreamHandle = { close(): void }

/**
 * Consumes an SSE endpoint directly from app code via fetch + ReadableStream, reconnecting
 * automatically while open. Used by the JS monitor (non-Android platforms) to subscribe to the
 * ntfy topic's /sse stream; every parsed frame is handed to onFrame for the caller to map. After a
 * drop, the last seen message id — which ntfy v2 carries inside each JSON envelope rather than in
 * SSE id lines — is appended as a since= query parameter so missed messages are replayed. ntfy
 * answers browser subscriptions with permissive CORS headers, which covers the Capacitor web views
 * and dev browser.
 */
export function openSseStream(options: {
  url: string
  headers?: Record<string, string>
  onFrame: (frame: SseFrame) => void
}): SseStreamHandle {
  let closed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let lastEventId: string | null = null
  const controller = new AbortController()

  async function run(): Promise<void> {
    // ntfy v2 emits no SSE id lines — the message id lives in the JSON envelope, and reconnects
    // resume with a since=<id> query parameter.
    const forwardFrame = (frame: SseFrame): void => {
      try {
        const envelope = JSON.parse(frame.data) as { id?: unknown }
        if (typeof envelope.id === 'string' && envelope.id !== '') lastEventId = envelope.id
      } catch {
        // Non-JSON frame — nothing to track.
      }
      options.onFrame(frame)
    }

    while (!closed) {
      try {
        const headers: Record<string, string> = { Accept: 'text/event-stream', ...options.headers }
        const separator = options.url.includes('?') ? '&' : '?'
        const url = lastEventId !== null ? `${options.url}${separator}since=${encodeURIComponent(lastEventId)}` : options.url

        const response = await fetch(url, { headers, signal: controller.signal })
        if (!response.ok || !response.body) throw new Error('stream status ' + response.status)

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          if (buffer.length > MAX_BUFFER_LENGTH) buffer = buffer.slice(-BUFFER_KEEP_TAIL)
          buffer = parseSseChunk(buffer, forwardFrame)
        }
      } catch {
        // Aborted or connection dropped — reconnect below unless closed.
      }

      if (closed) return
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve()
        controller.signal.addEventListener('abort', onAbort, { once: true })
        reconnectTimer = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve()
        }, RECONNECT_DELAY_MS)
      })
    }
  }

  void run()

  return {
    close(): void {
      closed = true
      // Aborts the in-flight fetch and resolves any pending reconnect wait.
      controller.abort()
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
    },
  }
}
