/**
 * OpenCode → ntfy bridge plugin (OpenCode v2).
 *
 * Revision: 2026-10-17a
 *
 * Runs inside each OpenCode server process and publishes session events to an ntfy topic, so the
 * opencode-mobile-client app can receive them through a single native subscription — no per-server
 * SSE connections from the phone, which Android freezes while the app is backgrounded.
 *
 * Install (per machine): copy this file to `~/.config/opencode/plugins/ntfy-bridge.ts` — OpenCode
 * auto-discovers `.ts` files in that directory — and create a sibling config file:
 *
 *   ~/.config/opencode/plugins/ntfy-bridge.json
 *     {
 *       "serverName": "Home Server",              // optional, defaults to the machine hostname
 *       "ntfyServer": "https://notify.example.net",
 *       "topic":      "opencode-mobile",          // topic the app subscribes to for notifications
 *       "replyTopic": "opencode-mobile-replies",  // optional, defaults to "<topic>-replies"
 *       "summary": {                         // optional — summarizes what a permission request
 *         "endpoint": "https://llm.example.net/v1/chat/completions",              // will do (≤8 words) in the notification body
 *         "apiKey": "sk-...", "model": "brain/liquid-350m"                //
 *       }
 *     }
 *
 * Replies flow back through ntfy rather than a direct phone→server call: when you tap Approve/Deny
 * on the phone it publishes `{sessionID, requestID, decision}` to the reply topic. Every running
 * bridge subscribes to that topic. Within a process, OpenCode runs one plugin context per live
 * location and permission state is scoped per location, so the context whose location holds the
 * pending request applies the reply (via the in-process permission API) and the others ignore it.
 * This needs no knowledge of this server's address or port — which matters because `opencode serve`
 * binds an ephemeral port each start — and it stays correct with several servers per machine.
 *
 * If you sync `~/.config/opencode` across machines (git / Syncthing), exclude ntfy-bridge.json —
 * it is machine-specific. The plugin disables itself with a console warning when the config is
 * missing or invalid, so a misconfigured server never crashes OpenCode.
 *
 * Published messages are v1 JSON payloads (see NtfyBridgePayload) that the mobile app parses for
 * structured handling; anything else on the topic renders as a plain-text notification.
 */
import type { OpencodeEvent, PluginContext, SessionInfo } from "@opencode/plugin"
import { appendFile, readFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join as resolvePath } from "node:path"

/**
 * Debug log path for diagnosing the reply chain at runtime. The plugin's console output is not
 * captured by the OpenCode server, so the reply path writes its own trace here. Delete the file to
 * reset; it is appended to and never rotated.
 */
let debugLogPath: string | null = resolvePath(homedir(), '.local', 'share', 'opencode', 'log', 'ntfy-bridge-debug.log')

/** Point the debug log at another file, or disable it with null — the unit tests use this so they don't pollute the runtime log. */
export function setDebugLogPath(path: string | null): void {
  debugLogPath = path
}

/** Append one line to the debug log. Never throws — logging must not break the bridge. */
function debugLog(message: string): void {
  if (debugLogPath === null) return
  const line = `${new Date().toISOString()} ${message}\n`
  void appendFile(debugLogPath, line, 'utf8').catch(() => {
    /* ignore — a full disk or permission issue must not take down the bridge */
  })
}

// ---------------------------------------------------------------------------
// Wire contract with the mobile app (v1)
// ---------------------------------------------------------------------------

export interface NtfyIdlePayload {
  v: 1
  kind: 'idle'
  serverName: string
  sessionID: string
  /** Session title when the server has one — display-only. */
  title?: string
}

export interface NtfyPermissionPayload {
  v: 1
  kind: 'permission'
  serverName: string
  /** Identifies the request so the phone can publish a matching reply to the ntfy reply topic. */
  requestID: string
  sessionID: string
  action: string
  resources?: string[]
  message?: string
  /** Short (≤8 word) description of what the action will do — present when a summary model is set. */
  summary?: string
}

/** Posted when a session asks the user a question (a form) and is now blocked on their answer. */
export interface NtfyWaitingPayload {
  v: 1
  kind: 'waiting'
  serverName: string
  sessionID: string
  /** The question being asked (the form's title). */
  title?: string
}

/** Posted when a previously-waiting form is answered or cancelled — clears the waiting notification. */
export interface NtfyWaitingClearPayload {
  v: 1
  kind: 'waiting-clear'
  serverName: string
  sessionID: string
}

/** Posted when a pending permission request is settled (approved, denied, or handled elsewhere) — clears the approval notification. */
export interface NtfyPermissionClearPayload {
  v: 1
  kind: 'permission-clear'
  serverName: string
  requestID: string
  sessionID: string
}

export type NtfyBridgePayload =
  | NtfyIdlePayload
  | NtfyPermissionPayload
  | NtfyPermissionClearPayload
  | NtfyWaitingPayload
  | NtfyWaitingClearPayload

/** An approval/deny reply published by the phone to the ntfy reply topic. */
export interface NtfyReplyFrame {
  sessionID: string
  requestID: string
  decision: 'once' | 'always' | 'reject'
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const CONFIG_FILE_NAME = 'ntfy-bridge.json'

export interface NtfyBridgeConfig {
  ntfyServer: string
  topic: string
  /** Topic the phone publishes approval replies to; defaults to `<topic>-replies`. */
  replyTopic: string
  serverName?: string
  /**
   * Optional OpenAI-compatible chat endpoint used to summarize what a permission request will do
   * (≤8 words) for the notification body. The model is hosted by this endpoint's server (not
   * registered in OpenCode), so the plugin calls it directly. Absent → no LLM call; the phone
   * shows its usual message/action detail.
   */
  summary?: { endpoint: string; apiKey: string; model: string }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//.test(value)
}

const TOPIC_PATTERN = /^[A-Za-z0-9_-]+$/

/** Parses and validates the config file content. Returns null when any requirement fails. */
export function parseNtfyBridgeConfig(
  raw: string,
  fallbackServerName = hostname(),
): NtfyBridgeConfig | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  const record = parsed as Record<string, unknown>
  if (!isHttpUrl(record.ntfyServer)) return null
  const topic = typeof record.topic === 'string' ? record.topic.trim() : ''
  // ntfy topic charset — anything else would be rejected by the server anyway.
  if (!TOPIC_PATTERN.test(topic)) return null

  const rawReplyTopic = typeof record.replyTopic === 'string' ? record.replyTopic.trim() : ''
  if (rawReplyTopic && !TOPIC_PATTERN.test(rawReplyTopic)) return null

  const name = typeof record.serverName === 'string' && record.serverName.trim()
    ? record.serverName.trim()
    : fallbackServerName

  // Optional summary endpoint — all three parts must be present, otherwise it is ignored.
  const rawSummary = isRecord(record.summary) ? record.summary : null
  const summary =
    rawSummary !== null
    && isHttpUrl(rawSummary.endpoint)
    && typeof rawSummary.apiKey === 'string' && rawSummary.apiKey.trim() !== ''
    && typeof rawSummary.model === 'string' && rawSummary.model.trim() !== ''
      ? { endpoint: rawSummary.endpoint, apiKey: rawSummary.apiKey.trim(), model: rawSummary.model.trim() }
      : undefined

  // Replies come back over a dedicated topic so the app's notification subscription (the main
  // topic) never has to render other phones' reply frames.
  return {
    ntfyServer: record.ntfyServer,
    topic,
    replyTopic: rawReplyTopic || `${topic}-replies`,
    serverName: name,
    ...(summary ? { summary } : {}),
  }
}

/** Full subscribe/publish URL for the configured ntfy instance and topic. */
export function joinNtfyEndpoint(ntfyServer: string, topic: string): string {
  return `${ntfyServer.replace(/\/+$/, '')}/${topic}`
}

// ---------------------------------------------------------------------------
// Bridge core (pure — injectable runtime makes it unit-testable)
// ---------------------------------------------------------------------------

const RECONNECT_DELAY_MS = 3_000
const INFO_CACHE_TTL_MS = 5 * 60_000
const MAX_TITLE_LENGTH = 120
// A permission notification is high priority — cap the summary LLM call so it never delays the
// approval prompt by more than this.
const SUMMARY_TIMEOUT_MS = 5_000

export interface BridgeRuntime {
  /** Event subscription; must honor the abort signal. */
  subscribe(signal: AbortSignal): AsyncIterable<OpencodeEvent>
  /** The session's display title and the directory it runs in (its project). */
  getSessionInfo(sessionID: string): Promise<{ title?: string; directory?: string }>
  publish(payload: NtfyBridgePayload, title: string, priority: 'default' | 'high', tags: string): Promise<void>
  /** Streams approval replies published to the ntfy reply topic; must honor the abort signal. */
  subscribeReplies(signal: AbortSignal): AsyncIterable<NtfyReplyFrame>
  /**
   * True when this context's location holds the request as pending. OpenCode scopes permission
   * state per location, so only the context whose location owns the request can apply its reply —
   * every other context's ctx.permission.reply fails with "Permission request not found".
   */
  ownsRequest(frame: NtfyReplyFrame): Promise<boolean>
  /** Applies a reply in-process on this server (only meaningful for requests it announced). */
  applyReply(frame: NtfyReplyFrame): Promise<void>
  /** Generates short text using the configured summary endpoint (throws when none is set). */
  generateText(prompt: string): Promise<string>
}

export interface NtfyBridge {
  start(): void
  stop(): void
  /** Processes one bus event — exported so tests can drive transitions directly. */
  handle(event: OpencodeEvent): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function truncate(value: string, maxLength = MAX_TITLE_LENGTH): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 3).trimEnd()}...` : flat
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Settles with the promise's result, or rejects after ms — used to bound the summary LLM call. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('summary timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Builds the short description of a permission request. With a summary endpoint configured it asks
 * the model for an ≤8-word summary (bounded by a timeout); on any failure it falls back to the
 * deterministic "action + first resource" text. Returns undefined when no summary endpoint is set
 * so the phone keeps showing its usual message/action detail.
 */
async function resolvePermissionSummary(
  runtime: BridgeRuntime,
  config: NtfyBridgeConfig,
  action: string,
  resources: string[],
  message: string | undefined,
): Promise<string | undefined> {
  if (!config.summary) return undefined

  const fallback = resources.length > 0
    ? truncate(`${action || 'action'} ${resources[0]}`)
    : action || undefined
  const prompt = [
    'Summarize in at most 8 words what this tool action will do.',
    `Action: ${action || 'unknown'}.`,
    resources.length > 0 ? `Target: ${resources[0]}.` : '',
    message ? `Detail: ${message}.` : '',
    'Reply with only the summary, no preamble.',
  ].filter(Boolean).join(' ')

  try {
    const text = await withTimeout(runtime.generateText(prompt), SUMMARY_TIMEOUT_MS)
    const cleaned = text.replace(/\s+/g, ' ').trim()
    debugLog(`summary from model: ${cleaned ? truncate(cleaned) : '(empty — using fallback)'}`)
    return cleaned ? truncate(cleaned) : fallback
  } catch (error) {
    debugLog(`summary model failed (${error instanceof Error ? error.message : String(error)}) — using fallback: ${fallback}`)
    return fallback
  }
}

/**
 * Dedup state shared by every bridge instance in one server process. OpenCode runs a plugin
 * context per live session/client and each context's subscription receives the full global bus, so
 * without this every event would be published once per live context (N contexts → N duplicate
 * notifications). All contexts share one JS isolate, hence globalThis; tests pass an explicit
 * instance to stay isolated from it.
 */
export interface BridgeSharedState {
  /** Sessions with an execution in flight; deleting the id claims the publish exactly once. */
  runningBySession: Set<string>
  /**
   * Permission request ids currently awaiting a reply. Adding on `permission.asked` both announces
   * each request once (fan-out guard) and marks it as owned by this process, so an inbound reply is
   * acted on only here; the id is dropped on `permission.replied`, which also publishes the
   * permission-clear that dismisses the phone's approval notification, keeping the set bounded by
   * the number of concurrently pending requests.
   */
  pendingRequests: Set<string>
  /**
   * Sessions currently blocked on a user question (form). Adding on `form.created` announces the
   * "waiting for input" notification exactly once (fan-out guard); the id is dropped on
   * `form.replied` / `form.cancelled`, which also gates the matching clear so it is published once.
   */
  waitingBySession: Set<string>
}

const SHARED_STATE_KEY = Symbol.for('opencode.ntfy-bridge.shared-state')

export function defaultSharedState(): BridgeSharedState {
  const carrier = globalThis as Record<PropertyKey, unknown>
  const existing = carrier[SHARED_STATE_KEY] as BridgeSharedState | undefined
  if (!existing) {
    carrier[SHARED_STATE_KEY] = {
      runningBySession: new Set<string>(),
      pendingRequests: new Set<string>(),
      waitingBySession: new Set<string>(),
    }
    return carrier[SHARED_STATE_KEY] as BridgeSharedState
  }
  // Hot reloads re-run setup in the same isolate, so state created by an older revision survives
  // without newer fields — adopt it and fill in anything missing.
  if (!existing.waitingBySession) existing.waitingBySession = new Set<string>()
  return existing
}

export interface NtfyBridgeOptions {
  /** Override the process-wide dedup state (tests pass a fresh instance per case). */
  sharedState?: BridgeSharedState
}

export function createNtfyBridge(
  config: NtfyBridgeConfig,
  runtime: BridgeRuntime,
  options: NtfyBridgeOptions = {},
): NtfyBridge {
  const serverName = config.serverName ?? 'OpenCode'
  // Sessions with an execution in flight — succeeded after started means "work just finished".
  // (v2 servers emit session.execution.* lifecycle events; they do not emit session.status.)
  const shared = options.sharedState ?? defaultSharedState()
  const runningBySession = shared.runningBySession
  const pendingRequests = shared.pendingRequests
  const waitingBySession = shared.waitingBySession
  const infoCache = new Map<string, { at: number; title?: string; directory?: string }>()
  let controller: AbortController | null = null

  async function resolveSessionInfo(sessionID: string): Promise<{ title?: string; directory?: string }> {
    const cached = infoCache.get(sessionID)
    if (cached && Date.now() - cached.at < INFO_CACHE_TTL_MS) {
      return { title: cached.title, directory: cached.directory }
    }
    let title: string | undefined
    let directory: string | undefined
    try {
      const info = await runtime.getSessionInfo(sessionID)
      title = info.title
      directory = info.directory
    } catch {
      // Session may have been deleted between the event and the lookup — not fatal.
    }
    const trimmed = title?.replace(/\s+/g, ' ').trim() || undefined
    const result = { title: trimmed ? truncate(trimmed) : undefined, directory }
    infoCache.set(sessionID, { ...result, at: Date.now() })
    return result
  }

  async function handle(event: OpencodeEvent): Promise<void> {
    const data = isRecord(event.data) ? event.data : null
    const sessionID = typeof data?.sessionID === 'string' ? data.sessionID : ''

    if (event.type === 'session.execution.started') {
      if (!sessionID) return
      runningBySession.add(sessionID)
    } else if (event.type === 'session.execution.succeeded') {
      // An execution we never saw start (e.g. the bridge started mid-run) is not a completion — skip it.
      if (!sessionID) return
      const claimed = runningBySession.delete(sessionID)
      debugLog(`execution.succeeded sessionID=${sessionID} claimed=${claimed}`)
      if (!claimed) return

      // The project is the session's own location — the context that wins the fan-out race is
      // usually not the one the session runs in, so this context's directory would be the wrong name.
      const info = await resolveSessionInfo(sessionID)
      const project = info.directory ? projectNameFromDirectory(info.directory) : undefined
      debugLog(
        `idle publish sessionID=${sessionID} title=${info.title ?? 'none'} ` +
          `directory=${info.directory ?? 'none'} project=${project ?? 'none'}`,
      )
      await runtime.publish(
        { v: 1, kind: 'idle', serverName, sessionID, ...(project ? { project } : {}), ...(info.title ? { title: info.title } : {}) },
        // Plain-text fallback for non-app consumers — the app composes its own title/body from the payload.
        truncate(`${project ?? serverName} — ${info.title ?? 'session finished'}`),
        'default',
        'white_check_mark',
      )
    } else if (event.type === 'permission.asked') {
      if (!data) return
      const requestID = typeof data.id === 'string' ? data.id : ''
      if (!requestID || !sessionID) return
      // Fan-out guard + ownership claim: the same permission event reaches every live context — only
      // the first to add the id announces it, and that process owns the matching reply later.
      if (pendingRequests.has(requestID)) return
      pendingRequests.add(requestID)
      debugLog(`permission.asked claimed requestID=${requestID} sessionID=${sessionID} action=${String(data.action)}`)

      const action = typeof data.action === 'string' ? data.action : ''
      const resources = Array.isArray(data.resources)
        ? data.resources.filter((r): r is string => typeof r === 'string')
        : []
      const message = typeof data.message === 'string' && data.message.trim()
        ? truncate(data.message.trim())
        : undefined

      // Bounded by SUMMARY_TIMEOUT_MS — a slow or missing model never blocks the approval prompt.
      const summary = await resolvePermissionSummary(runtime, config, action, resources, message)

      await runtime.publish(
        {
          v: 1,
          kind: 'permission',
          serverName,
          requestID,
          sessionID,
          action,
          ...(resources.length > 0 ? { resources } : {}),
          ...(message ? { message } : {}),
          ...(summary ? { summary } : {}),
        },
        truncate(`${serverName}: approval needed (${action || 'action'})`),
        'high',
        'warning',
      )
    } else if (event.type === 'permission.replied') {
      // Settled (approved, denied, or handled elsewhere, e.g. in the CLI) — release the ownership
      // claim so a late or duplicate reply is ignored, and publish the clear exactly once (only the
      // context that had the id recorded) so the phone dismisses its approval notification.
      const requestID = typeof data?.requestID === 'string' ? data.requestID : ''
      if (!requestID) return
      if (!pendingRequests.delete(requestID)) return
      debugLog(`permission.replied cleared requestID=${requestID} sessionID=${sessionID}`)
      await runtime.publish(
        { v: 1, kind: 'permission-clear', serverName, requestID, sessionID },
        truncate(`${serverName}: approval resolved`),
        'default',
        'white_check_mark',
      )
    } else if (event.type === 'form.created') {
      // A form is the v2 way a session asks the user a question — it is now blocked on the answer.
      // Unlike the other events, the session id lives on the form, not at the top level of data.
      if (!data) return
      const form = isRecord(data.form) ? data.form : null
      const formSessionID = (form && typeof form.sessionID === 'string' ? form.sessionID : '') || sessionID
      if (!formSessionID) return
      // Fan-out guard: the same form.created reaches every live context — only the first to add the
      // session announces the "waiting for input" notification (one, not N).
      if (waitingBySession.has(formSessionID)) return
      waitingBySession.add(formSessionID)
      debugLog(`form.created claimed sessionID=${formSessionID}`)
      const title = form && typeof form.title === 'string' && form.title.trim()
        ? truncate(form.title.trim())
        : undefined
      await runtime.publish(
        { v: 1, kind: 'waiting', serverName, sessionID: formSessionID, ...(title ? { title } : {}) },
        truncate(`${serverName}: waiting for input`),
        'high',
        'hourglass',
      )
    } else if (event.type === 'form.replied' || event.type === 'form.cancelled') {
      // The question was answered or cancelled — clear the waiting notification for this session.
      // Derive the session id the same way form.created does; only the context that had it recorded
      // publishes the clear (fan-out guard) and the set stays bounded by open questions.
      if (!data) return
      const form = isRecord(data.form) ? data.form : null
      const formSessionID = (form && typeof form.sessionID === 'string' ? form.sessionID : '') || sessionID
      if (!formSessionID) return
      if (!waitingBySession.delete(formSessionID)) return
      debugLog(`form.${event.type} cleared sessionID=${formSessionID}`)
      await runtime.publish(
        { v: 1, kind: 'waiting-clear', serverName, sessionID: formSessionID },
        truncate(`${serverName}: input received`),
        'default',
        'white_check_mark',
      )
    }
  }

  async function replyLoop(): Promise<void> {
    while (controller && !controller.signal.aborted) {
      try {
        for await (const frame of runtime.subscribeReplies(controller.signal)) {
          debugLog(
            `reply frame received requestID=${frame.requestID} sessionID=${frame.sessionID} ` +
              `decision=${frame.decision} pendingBefore=${pendingRequests.size}`,
          )
          // Only the process that announced this request acts on its reply; delete() is the claim.
          if (!frame.requestID || !pendingRequests.has(frame.requestID)) {
            debugLog(`reply frame ignored (no pending match) requestID=${frame.requestID}`)
            continue
          }
          // Within this process, permission state is scoped per location: exactly one context's
          // ctx can resolve the request. Probe ownership before claiming so a non-owner never
          // steals the claim and fails the reply with "Permission request not found".
          let owns = false
          try {
            owns = await runtime.ownsRequest(frame)
          } catch {
            owns = false
          }
          if (!owns) {
            debugLog(
              `reply frame ignored (not owned by this context) requestID=${frame.requestID} ` +
                `sessionID=${frame.sessionID}`,
            )
            continue
          }
          if (!pendingRequests.delete(frame.requestID)) {
            debugLog(`reply frame ignored (no pending match) requestID=${frame.requestID}`)
            continue
          }
          debugLog(`reply frame claimed requestID=${frame.requestID} — applying`)
          try {
            await runtime.applyReply(frame)
            debugLog(`reply applied OK requestID=${frame.requestID} decision=${frame.decision}`)
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(
              `[ntfy-bridge] failed to apply reply ${frame.requestID}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            )
            debugLog(`reply FAILED requestID=${frame.requestID}: ${msg}`)
          }
        }
      } catch {
        // Stream error — fall through and reconnect below.
      }
      if (!controller || controller.signal.aborted) break
      await sleep(RECONNECT_DELAY_MS, controller.signal)
    }
  }

  async function loop(): Promise<void> {
    while (controller && !controller.signal.aborted) {
      try {
        for await (const event of runtime.subscribe(controller.signal)) {
          await handle(event)
        }
      } catch {
        // Stream error — fall through and reconnect below.
      }
      if (!controller || controller.signal.aborted) break
      await sleep(RECONNECT_DELAY_MS, controller.signal)
    }
  }

  return {
    start(): void {
      if (controller) return
      controller = new AbortController()
      void loop()
      void replyLoop()
    },
    stop(): void {
      controller?.abort()
      controller = null
      // runningBySession is process-wide state — other live contexts still rely on it.
      infoCache.clear()
    },
    handle,
  }
}

// ---------------------------------------------------------------------------
// Plugin wiring (runs inside the OpenCode server process)
// ---------------------------------------------------------------------------

const ASCII_HEADER_MAPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2013\u2014\u2212]/g, '-'], // en dash / em dash / minus sign
  [/[\u2018\u2019\u201a\u201b]/g, "'"], // curly single quotes
  [/[\u201c\u201d\u201e\u201f]/g, '"'], // curly double quotes
  [/\u2026/g, '...'], // ellipsis
]

/**
 * ntfy display headers are HTTP header values: undici rejects anything outside printable ASCII and
 * throws for the whole publish. Server names and session titles can carry non-ASCII text, so map
 * common typographic characters to their ASCII equivalents and strip the rest before sending.
 */
export function asciiHeader(value: string): string {
  let out = value
  for (const [pattern, replacement] of ASCII_HEADER_MAPS) out = out.replace(pattern, replacement)
  return out.replace(/[^\x20-\x7e]/g, '').replace(/\s{2,}/g, ' ').trim()
}

/**
 * Turns one ntfy SSE `data:` payload into a reply frame, or yields nothing. The phone publishes the
 * reply body as plain text, so it arrives JSON-encoded inside the envelope's `message` field — parse
 * twice. Anything that is not a well-formed `{sessionID, requestID, decision}` frame is ignored.
 */
export function* parseReplyFrame(raw: string): Generator<NtfyReplyFrame> {
  try {
    const envelope = JSON.parse(raw) as { message?: unknown }
    if (typeof envelope.message !== 'string') return
    const body = JSON.parse(envelope.message) as Record<string, unknown>
    const sessionID = typeof body.sessionID === 'string' ? body.sessionID : ''
    const requestID = typeof body.requestID === 'string' ? body.requestID : ''
    if (!sessionID || !requestID) return
    const decision = body.decision
    if (decision !== 'once' && decision !== 'always' && decision !== 'reject') return
    yield { sessionID, requestID, decision }
  } catch {
    // Not a reply frame we understand — ignore.
  }
}

/** Yields the `data:` payload of each ntfy v2 SSE event from an open stream. */
async function* sseData(response: Response): AsyncIterable<string> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // Pull complete lines out of the buffer; an incomplete trailing line waits for more data.
      let match: RegExpExecArray | null
      while ((match = /^([^\r\n]*)(?:\r\n|\n)/.exec(buffer)) !== null) {
        const line = match[1]
        buffer = buffer.slice(match[0].length)
        if (line.startsWith('data:')) {
          dataLines.push(line.length > 5 && line.charAt(5) === ' ' ? line.slice(6) : line.slice(5))
        } else if (line === '') {
          if (dataLines.length > 0) yield dataLines.join('\n')
          dataLines = []
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// Exported so tests can drive the real publish path with a stubbed fetch.
export function createHttpRuntime(ctx: PluginContext, config: NtfyBridgeConfig): BridgeRuntime {
  const endpoint = joinNtfyEndpoint(config.ntfyServer, config.topic)
  const replySseUrl = `${joinNtfyEndpoint(config.ntfyServer, config.replyTopic)}/sse`
  return {
    subscribe(signal) {
      return ctx.event.subscribe({ signal })
    },
    async getSessionInfo(sessionID) {
      let record: SessionInfo
      try {
        record = await ctx.session.get({ sessionID })
      } catch (err) {
        debugLog(`session.get ${sessionID} FAILED: ${String(err)}`)
        throw err
      }
      // The record's location names the project — the context that wins the fan-out race is
      // usually not the one the session runs in, so this context's own directory would be wrong.
      const directory =
        record.location && typeof record.location.directory === 'string' ? record.location.directory : undefined
      return {
        title: typeof record.title === 'string' ? record.title : undefined,
        directory,
      }
    },
    async publish(payload, title, priority, tags) {
      try {
        // ntfy publish API: POST the message body with display headers for other subscribers.
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            Title: asciiHeader(title),
            Priority: priority,
            Tags: tags,
            'Content-Type': 'text/plain; charset=utf-8',
          },
          body: JSON.stringify(payload),
        })
        if (!response.ok) {
          console.warn(`[ntfy-bridge] publish failed: HTTP ${response.status} from ${endpoint}`)
        }
      } catch (error) {
        console.warn(
          `[ntfy-bridge] publish failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    subscribeReplies(signal) {
      // Property holding a generator function — object-literal methods cannot combine the
      // `function*` syntax with a return-type annotation in every parser we build through.
      return (async function* stream(): AsyncIterable<NtfyReplyFrame> {
        let response: Response
        try {
          response = await fetch(replySseUrl, { signal, headers: { Accept: 'text/event-stream' } })
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') return // stop() — not an error to reconnect on.
          debugLog(`reply SSE fetch error: ${error instanceof Error ? error.message : String(error)}`)
          throw error
        }
        if (!response.ok || !response.body) {
          debugLog(`reply SSE not ok: HTTP ${response.status} for ${replySseUrl}`)
          return
        }
        debugLog(`reply SSE connected → ${replySseUrl}`)
        for await (const raw of sseData(response)) yield* parseReplyFrame(raw)
      })()
    },
    async ownsRequest(frame) {
      // ctx.permission.get resolves only when this context's location holds the pending request
      // for the frame's session — the ownership probe that keeps non-owners from claiming it.
      try {
        await ctx.permission.get({ sessionID: frame.sessionID, requestID: frame.requestID })
        return true
      } catch {
        return false
      }
    },
    async applyReply(frame) {
      // In-process reply: resolves the request on this server without any network round-trip.
      debugLog(`ctx.permission.reply → sessionID=${frame.sessionID} requestID=${frame.requestID} decision=${frame.decision}`)
      try {
        await ctx.permission.reply({ sessionID: frame.sessionID, requestID: frame.requestID, decision: frame.decision })
      } catch (error) {
        debugLog(`ctx.permission.reply THREW: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        throw error
      }
    },
    async generateText(prompt) {
      const summary = config.summary
      if (!summary) throw new Error('no summary endpoint configured')
      // Direct call to the model's OpenAI-compatible chat endpoint — the model is hosted there,
      // not registered in OpenCode, so ctx.generate.text cannot resolve it.
      const response = await fetch(summary.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${summary.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: summary.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 64,
          temperature: 0,
        }),
      })
      if (!response.ok) throw new Error(`summary endpoint HTTP ${response.status}`)
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
      const text = data.choices?.[0]?.message?.content
      if (typeof text !== 'string' || text.trim() === '') throw new Error('summary endpoint returned no content')
      return text
    },
  }
}

/** Last non-empty path segment of a directory — used as the human "project" name. */
export function projectNameFromDirectory(directory: string): string | undefined {
  const segments = directory.split(/[\\/]+/).filter((s) => s.trim() !== '')
  const last = segments[segments.length - 1]
  return last ? last.trim() : undefined
}

const plugin = {
  id: 'ntfy-bridge',
  async setup(ctx: PluginContext) {
    const configPath = resolvePath(homedir(), '.config', 'opencode', 'plugins', CONFIG_FILE_NAME)
    let raw: string
    try {
      raw = await readFile(configPath, 'utf8')
    } catch {
      console.warn(
        `[ntfy-bridge] no config found at ${configPath} — plugin disabled. ` +
          'Create it with ntfyServer and topic (see the plugin header for an example).',
      )
      return
    }

    const config = parseNtfyBridgeConfig(raw)
    if (!config) {
      console.warn(
        `[ntfy-bridge] invalid config at ${configPath} — plugin disabled. ` +
          'Required fields: ntfyServer (http(s) URL), topic.',
      )
      return
    }

    console.log(
      `[ntfy-bridge] active → ${joinNtfyEndpoint(config.ntfyServer, config.topic)} ` +
        `(server "${config.serverName}", replies on ${config.replyTopic})`,
    )
    debugLog(
      `setup active → ${joinNtfyEndpoint(config.ntfyServer, config.topic)} ` +
        `(server "${config.serverName}", replySse=${config.ntfyServer.replace(/\/+$/, '')}/${config.replyTopic}/sse, ` +
        `location=${ctx.location.directory} workspace=${ctx.location.workspaceID ?? 'none'})`,
    )
    const bridge = createNtfyBridge(config, createHttpRuntime(ctx, config))
    bridge.start()
    return () => bridge.stop()
  },
}

export default plugin
