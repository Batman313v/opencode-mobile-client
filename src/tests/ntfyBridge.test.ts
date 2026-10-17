import { describe, expect, it, vi } from 'vitest'
import type { OpencodeEvent, PluginContext } from '@opencode/plugin'
import { asciiHeader, createHttpRuntime, createNtfyBridge, defaultSharedState, joinNtfyEndpoint, parseNtfyBridgeConfig, parseReplyFrame, projectNameFromDirectory, setDebugLogPath, type BridgeRuntime, type BridgeSharedState, type NtfyBridge, type NtfyBridgePayload, type NtfyReplyFrame } from '@/opencode-plugin/ntfy-bridge'

// Keep unit tests from appending to the real runtime debug log.
setDebugLogPath(null)

function event(type: string, data: unknown): OpencodeEvent {
  return { id: 'evt_1', type, data }
}

const CONFIG = { ntfyServer: 'https://notify.example', topic: 'opencode-mobile', replyTopic: 'opencode-mobile-replies', serverName: 'Alpha' }

/** Fake runtime with a recording publish; the empty subscription is never iterated in these tests. */
function makeRuntime(titleResult: string | null = 'Fix login bug', directory: string | null = null) {
  const publish = vi.fn(async (_payload: NtfyBridgePayload, _title: string, _priority: 'default' | 'high', _tags: string) => undefined)
  const generateText = vi.fn(async (_prompt: string) => 'Generated summary')
  const runtime: BridgeRuntime = {
    subscribe: () => (async function* (): AsyncIterable<OpencodeEvent> {})(),
    getSessionInfo: vi.fn(async (_sessionID: string) => ({ title: titleResult ?? undefined, directory: directory ?? undefined })),
    publish,
    subscribeReplies: () => (async function* (): AsyncIterable<NtfyReplyFrame> {})(),
    ownsRequest: async (_frame: NtfyReplyFrame) => true,
    applyReply: async (_frame: NtfyReplyFrame) => undefined,
    generateText,
  }
  return {
    publish,
    runtime,
    getSessionInfo: runtime.getSessionInfo as ReturnType<typeof vi.fn>,
    generateText: runtime.generateText as ReturnType<typeof vi.fn>,
  }
}

/** Fresh process-wide dedup state per test — bridges must not share globalThis state across cases. */
function freshShared(): BridgeSharedState {
  return { runningBySession: new Set<string>(), pendingRequests: new Set<string>(), waitingBySession: new Set<string>() }
}

describe('defaultSharedState', () => {
  const KEY = Symbol.for('opencode.ntfy-bridge.shared-state')

  it('adopts state left by an older revision and fills in missing fields', () => {
    // Simulates a hot reload: the previous revision's state object survives in globalThis without
    // the newer waitingBySession field.
    const legacy = { runningBySession: new Set<string>(), pendingRequests: new Set<string>() }
    Object.assign(globalThis, { [KEY]: legacy })
    try {
      const state = defaultSharedState()
      expect(state).toBe(legacy)
      expect(state.waitingBySession).toBeInstanceOf(Set)
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[KEY]
    }
  })
})

describe('projectNameFromDirectory', () => {
  it('returns the last path segment for Windows and POSIX paths', () => {
    expect(projectNameFromDirectory('D:\\Work Projects\\opencode-mobile-client')).toBe('opencode-mobile-client')
    expect(projectNameFromDirectory('/home/dev/projects/brain')).toBe('brain')
  })

  it('ignores trailing separators and returns undefined for empty input', () => {
    expect(projectNameFromDirectory('D:\\Work Projects\\opencode-mobile-client\\')).toBe('opencode-mobile-client')
    expect(projectNameFromDirectory('')).toBeUndefined()
  })
})

describe('parseNtfyBridgeConfig', () => {
  it('parses a valid config and falls back to the machine name when serverName is absent', () => {
    const raw = JSON.stringify({ ntfyServer: 'https://notify.example', topic: 'opencode-mobile' })

    expect(parseNtfyBridgeConfig(raw, 'fallback-host')).toEqual({ ...CONFIG, serverName: 'fallback-host' })
  })

  it('uses and trims an explicit serverName', () => {
    const raw = JSON.stringify({ ntfyServer: 'https://notify.example', topic: 'opencode-mobile', serverName: '  Home Server  ' })

    expect(parseNtfyBridgeConfig(raw, 'fallback-host')?.serverName).toBe('Home Server')
  })

  it('rejects malformed JSON and missing or invalid required fields', () => {
    const base = { ntfyServer: 'https://notify.example', topic: 'opencode-mobile' }

    expect(parseNtfyBridgeConfig('not json')).toBeNull()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, ntfyServer: undefined }))).toBeNull()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, replyTopic: 'bad topic!' }))).toBeNull()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, topic: 'bad topic!' }))).toBeNull()
    expect(parseNtfyBridgeConfig(JSON.stringify(null))).toBeNull()
  })

  it('parses a valid summary endpoint and trims its parts', () => {
    const raw = JSON.stringify({
      ntfyServer: 'https://notify.example', topic: 'opencode-mobile',
      summary: { endpoint: 'https://llm.example/v1/chat/completions', apiKey: '  sk-abc  ', model: ' brain/liquid-350m ' },
    })

    expect(parseNtfyBridgeConfig(raw, 'fallback-host')?.summary).toEqual({
      endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'sk-abc', model: 'brain/liquid-350m',
    })
  })

  it('ignores a summary endpoint that is missing or has empty parts', () => {
    const base = { ntfyServer: 'https://notify.example', topic: 'opencode-mobile' }
    const full = { endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'sk-abc', model: 'brain/liquid-350m' }

    expect(parseNtfyBridgeConfig(JSON.stringify(base), 'h')?.summary).toBeUndefined()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, summary: { ...full, apiKey: '' } }), 'h')?.summary).toBeUndefined()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, summary: { ...full, endpoint: 'not-a-url' } }), 'h')?.summary).toBeUndefined()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, summary: { ...full, model: '  ' } }), 'h')?.summary).toBeUndefined()
    expect(parseNtfyBridgeConfig(JSON.stringify({ ...base, summary: 'llm.example' }), 'h')?.summary).toBeUndefined()
  })
})

describe('joinNtfyEndpoint', () => {
  it('joins server and topic, stripping trailing slashes from the server URL', () => {
    expect(joinNtfyEndpoint('https://notify.example///', 'opencode-mobile')).toBe('https://notify.example/opencode-mobile')
  })
})

describe('createNtfyBridge', () => {
  it('publishes a completion notification only when an observed execution succeeds, with the session title', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('session.execution.started', { sessionID: 'ses_1' }))
    expect(publish).not.toHaveBeenCalled()

    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_1' }))
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      { v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_1', title: 'Fix login bug' },
      'Alpha — Fix login bug',
      'default',
      'white_check_mark',
    )
  })

  it('names the project from the session own location, not the context that published', async () => {
    // The bridge publishing here represents any context — the project must come from where the
    // session runs (its location directory), so the race winner no longer matters.
    const { publish, runtime } = makeRuntime('Fix login bug', 'D:\\Work Projects\\opencode-mobile-client')
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('session.execution.started', { sessionID: 'ses_1' }))
    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_1' }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      { v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_1', project: 'opencode-mobile-client', title: 'Fix login bug' },
      'opencode-mobile-client — Fix login bug',
      'default',
      'white_check_mark',
    )
  })

  it('publishes once per completed execution when a session runs multiple turns', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('session.execution.started', { sessionID: 'ses_1' }))
    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_1' }))
    await bridge.handle(event('session.execution.started', { sessionID: 'ses_1' }))
    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_1' }))

    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('skips executions that were never observed starting and ignores unrelated events', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_1' })) // no matching started
    await bridge.handle(event('message.updated', { sessionID: 'ses_1' }))
    await bridge.handle(event('session.execution.started', {})) // no sessionID

    expect(publish).not.toHaveBeenCalled()
  })

  it('omits the title and falls back to the server name heading when the session has none', async () => {
    const { publish, runtime } = makeRuntime(null) // null sentinel → no title available
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('session.execution.started', { sessionID: 'ses_2' }))
    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_2' }))

    expect(publish).toHaveBeenCalledTimes(1)
    // No title available → payload omits it and the heading falls back to the server name.
    expect(publish).toHaveBeenCalledWith({ v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_2' }, 'Alpha — session finished', 'default', 'white_check_mark')
  })

  it('truncates long session titles to the display limit', async () => {
    const { publish, runtime } = makeRuntime(`x`.repeat(200))
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('session.execution.started', { sessionID: 'ses_1' }))
    await bridge.handle(event('session.execution.succeeded', { sessionID: 'ses_1' }))

    const payload = vi.mocked(publish).mock.calls[0]?.[0] as { title?: string }
    expect(payload.title?.length).toBe(120)
    expect(payload.title?.endsWith('...')).toBe(true)
  })

  it('publishes a permission notification with request identifiers and high priority', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.asked', {
      id: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['ls -la'], message: 'Run a shell command',
    }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      {
        v: 1, kind: 'permission', serverName: 'Alpha',
        requestID: 'per_1', sessionID: 'ses_1', action: 'bash', resources: ['ls -la'], message: 'Run a shell command',
      },
      'Alpha: approval needed (bash)',
      'high',
      'warning',
    )
  })

  it('omits empty resources and blank messages from the permission payload', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.asked', { id: 'per_2', sessionID: 'ses_1', action: 'edit' }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(vi.mocked(publish).mock.calls[0]?.[0]).toEqual({
      v: 1, kind: 'permission', serverName: 'Alpha', requestID: 'per_2', sessionID: 'ses_1', action: 'edit',
    })
  })

  it('ignores permission events without a request id or session id', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.asked', { sessionID: 'ses_1', action: 'bash' }))
    await bridge.handle(event('permission.asked', { id: 'per_x', action: 'bash' }))

    expect(publish).not.toHaveBeenCalled()
  })

  it('adds an LLM summary to the permission payload when a summary endpoint is configured', async () => {
    const { publish, runtime, generateText } = makeRuntime()
    const config = {
      ...CONFIG,
      summary: { endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'sk-abc', model: 'brain/liquid-350m' },
    }
    const bridge = createNtfyBridge(config, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.asked', {
      id: 'per_s', sessionID: 'ses_1', action: 'bash', resources: ['Remove-Item C:\\temp\\x.txt'],
    }))

    expect(generateText).toHaveBeenCalledTimes(1)
    const [prompt] = vi.mocked(generateText).mock.calls[0]
    expect(prompt).toContain('Remove-Item C:\\temp\\x.txt')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(vi.mocked(publish).mock.calls[0]?.[0]).toMatchObject({
      kind: 'permission', requestID: 'per_s', summary: 'Generated summary',
    })
  })

  it('falls back to "action + first resource" when the summary endpoint call fails', async () => {
    const { publish, runtime, generateText } = makeRuntime()
    const config = {
      ...CONFIG,
      summary: { endpoint: 'https://llm.example/v1/chat/completions', apiKey: 'sk-abc', model: 'brain/liquid-350m' },
    }
    const bridge = createNtfyBridge(config, runtime, { sharedState: freshShared() })
    vi.mocked(generateText).mockRejectedValueOnce(new Error('model unavailable'))

    await bridge.handle(event('permission.asked', {
      id: 'per_f', sessionID: 'ses_1', action: 'bash', resources: ['ls -la'],
    }))

    expect(vi.mocked(publish).mock.calls[0]?.[0]).toMatchObject({ kind: 'permission', summary: 'bash ls -la' })
  })

  it('omits the summary entirely when no summary endpoint is configured', async () => {
    const { publish, runtime, generateText } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.asked', { id: 'per_n', sessionID: 'ses_1', action: 'edit' }))

    expect(generateText).not.toHaveBeenCalled()
    expect(vi.mocked(publish).mock.calls[0]?.[0]).not.toHaveProperty('summary')
  })

  it('publishes a permission-clear frame when a tracked request is settled', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.asked', { id: 'per_1', sessionID: 'ses_1', action: 'bash' }))
    await bridge.handle(event('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: { decision: 'once' } }))

    // 1 permission + 1 permission-clear
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith(
      { v: 1, kind: 'permission-clear', serverName: 'Alpha', requestID: 'per_1', sessionID: 'ses_1' },
      'Alpha: approval resolved',
      'default',
      'white_check_mark',
    )
  })

  it('does not publish a permission-clear for a request this process never announced', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('permission.replied', { sessionID: 'ses_1', requestID: 'per_unknown', reply: { decision: 'once' } }))

    expect(publish).not.toHaveBeenCalled()
  })

  it('announces the permission-clear once even when the same permission.replied reaches every context', async () => {
    const { publish, runtime } = makeRuntime()
    const shared = freshShared()
    // N contexts share one state: each gets its own bridge over the same sharedState.
    const bridges = Array.from({ length: 9 }, () => createNtfyBridge(CONFIG, runtime, { sharedState: shared }))
    const asked = event('permission.asked', { id: 'per_1', sessionID: 'ses_1', action: 'bash' })
    for (const b of bridges) await b.handle(asked)
    expect(publish).toHaveBeenCalledTimes(1)

    // A single permission.replied clears it exactly once across all contexts.
    const replied = event('permission.replied', { sessionID: 'ses_1', requestID: 'per_1', reply: { decision: 'once' } })
    for (const b of bridges) await b.handle(replied)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(shared.pendingRequests.has('per_1')).toBe(false)
  })

  it('publishes a waiting frame on form.created using the form title and session id', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('form.created', {
      form: { id: 'form_1', sessionID: 'ses_1', title: 'Which database should I use?', fields: [] },
    }))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      { v: 1, kind: 'waiting', serverName: 'Alpha', sessionID: 'ses_1', title: 'Which database should I use?' },
      'Alpha: waiting for input',
      'high',
      'hourglass',
    )
  })

  it('publishes a waiting-clear frame when a tracked form is answered or cancelled', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('form.created', { form: { id: 'form_1', sessionID: 'ses_1', title: 'Q1' } }))
    await bridge.handle(event('form.created', { form: { id: 'form_2', sessionID: 'ses_2', title: 'Q2' } }))
    await bridge.handle(event('form.replied', { id: 'form_1', sessionID: 'ses_1', answer: {} }))
    await bridge.handle(event('form.cancelled', { id: 'form_2', sessionID: 'ses_2' }))

    // 2 waiting + 2 waiting-clear
    expect(publish).toHaveBeenCalledTimes(4)
    expect(vi.mocked(publish).mock.calls[2]?.[0]).toEqual({ v: 1, kind: 'waiting-clear', serverName: 'Alpha', sessionID: 'ses_1' })
    expect(vi.mocked(publish).mock.calls[3]?.[0]).toEqual({ v: 1, kind: 'waiting-clear', serverName: 'Alpha', sessionID: 'ses_2' })
  })

  it('announces the waiting frame once even when the same form.created reaches every context', async () => {
    const { publish, runtime } = makeRuntime()
    const shared = freshShared()
    // N contexts share one state: each gets its own bridge over the same sharedState.
    const bridges = Array.from({ length: 9 }, () => createNtfyBridge(CONFIG, runtime, { sharedState: shared }))
    const created = event('form.created', { form: { id: 'form_1', sessionID: 'ses_1', title: 'Q?' } })
    for (const b of bridges) await b.handle(created)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(shared.waitingBySession.has('ses_1')).toBe(true)

    // A single form.replied clears it exactly once across all contexts.
    const replied = event('form.replied', { id: 'form_1', sessionID: 'ses_1' })
    for (const b of bridges) await b.handle(replied)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(shared.waitingBySession.has('ses_1')).toBe(false)
  })

  it('ignores form events that carry no session id', async () => {
    const { publish, runtime } = makeRuntime()
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: freshShared() })

    await bridge.handle(event('form.created', { form: { id: 'form_1', title: 'Q?' } }))
    await bridge.handle(event('form.replied', { id: 'form_1' }))

    expect(publish).not.toHaveBeenCalled()
  })
})

describe('asciiHeader', () => {
  it('maps typographic characters to ASCII and strips non-printables', () => {
    expect(asciiHeader('Tevin — session finished')).toBe('Tevin - session finished')
    expect(asciiHeader('it’s “quoted”…')).toBe("it's \"quoted\"...")
    expect(asciiHeader('café ☕ done')).toBe('caf done')
  })
})

describe('createHttpRuntime', () => {
  it('sanitizes non-ASCII titles so the publish never fails on header validation', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const runtime = createHttpRuntime({} as PluginContext, CONFIG)

      await runtime.publish(
        { v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_1' },
        'Alpha — session finished',
        'default',
        'white_check_mark',
      )

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
      expect((init?.headers as Record<string, string>)['Title']).toBe('Alpha - session finished')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('subscribes to approval replies on the reply topic SSE endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, body: null }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const runtime = createHttpRuntime({} as PluginContext, CONFIG)
      // The stubbed response has no body, so the stream completes right after subscribing.
      await runtime.subscribeReplies(new AbortController().signal)[Symbol.asyncIterator]().next()

      expect(fetchMock).toHaveBeenCalledWith(
        'https://notify.example/opencode-mobile-replies/sse',
        expect.objectContaining({ headers: { Accept: 'text/event-stream' } }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads the title and location directory from the session record', async () => {
    const ctx = {
      session: {
        get: vi.fn(async () => ({
          id: 'ses_1',
          title: 'Fix login bug',
          location: { directory: 'D:\\Work Projects\\opencode-mobile-client' },
        })),
      },
    } as unknown as PluginContext
    const runtime = createHttpRuntime(ctx, CONFIG)

    await expect(runtime.getSessionInfo('ses_1')).resolves.toEqual({
      title: 'Fix login bug',
      directory: 'D:\\Work Projects\\opencode-mobile-client',
    })
  })

  it('returns undefined fields when the session record has no title or location', async () => {
    const ctx = { session: { get: vi.fn(async () => ({ id: 'ses_1' })) } } as unknown as PluginContext
    const runtime = createHttpRuntime(ctx, CONFIG)

    await expect(runtime.getSessionInfo('ses_1')).resolves.toEqual({ title: undefined, directory: undefined })
  })

  it('rethrows when the session lookup fails', async () => {
    const ctx = { session: { get: vi.fn(async () => { throw new Error('session not found') }) } } as unknown as PluginContext
    const runtime = createHttpRuntime(ctx, CONFIG)

    await expect(runtime.getSessionInfo('ses_1')).rejects.toThrow('session not found')
  })
})

describe('multi-context fan-out dedup', () => {
  it('publishes a completion exactly once when every live context sees the same events', async () => {
    const shared = freshShared()
    const a = makeRuntime()
    const b = makeRuntime()
    const bridgeA = createNtfyBridge(CONFIG, a.runtime, { sharedState: shared })
    const bridgeB = createNtfyBridge(CONFIG, b.runtime, { sharedState: shared })

    await bridgeA.handle(event('session.execution.started', { sessionID: 'ses_9' }))
    await bridgeB.handle(event('session.execution.started', { sessionID: 'ses_9' }))
    await bridgeA.handle(event('session.execution.succeeded', { sessionID: 'ses_9' }))
    await bridgeB.handle(event('session.execution.succeeded', { sessionID: 'ses_9' }))

    expect(a.publish).toHaveBeenCalledTimes(1)
    expect(b.publish).not.toHaveBeenCalled()
  })

  it('announces a permission request exactly once across contexts, but allows new requests through', async () => {
    const shared = freshShared()
    const a = makeRuntime()
    const b = makeRuntime()
    const bridgeA = createNtfyBridge(CONFIG, a.runtime, { sharedState: shared })
    const bridgeB = createNtfyBridge(CONFIG, b.runtime, { sharedState: shared })

    await Promise.all([
      bridgeA.handle(event('permission.asked', { id: 'per_9', sessionID: 'ses_9', action: 'bash' })),
      bridgeB.handle(event('permission.asked', { id: 'per_9', sessionID: 'ses_9', action: 'bash' })),
    ])
    expect(a.publish.mock.calls.length + b.publish.mock.calls.length).toBe(1)

    await bridgeA.handle(event('permission.asked', { id: 'per_10', sessionID: 'ses_9', action: 'edit' }))
    expect(a.publish.mock.calls.length + b.publish.mock.calls.length).toBe(2)
  })
})

describe('parseReplyFrame', () => {
  it('parses a well-formed phone reply envelope and ignores anything else', () => {
    const good = JSON.stringify({ message: JSON.stringify({ sessionID: 'ses_1', requestID: 'per_1', decision: 'once' }) })
    expect([...parseReplyFrame(good)]).toEqual([{ sessionID: 'ses_1', requestID: 'per_1', decision: 'once' }])

    expect([...parseReplyFrame('not json')]).toEqual([])
    expect([...parseReplyFrame(JSON.stringify({}))]).toEqual([])
    expect([...parseReplyFrame(JSON.stringify({ message: 'plain text' }))]).toEqual([])
    const badDecision = JSON.stringify({ message: JSON.stringify({ sessionID: 'ses_1', requestID: 'per_1', decision: 'maybe' }) })
    expect([...parseReplyFrame(badDecision)]).toEqual([])
  })
})

describe('reply routing through the ntfy reply topic', () => {
  function makeReplyHarness(frames: NtfyReplyFrame[], owns = true) {
    const applyReply = vi.fn(async (_frame: NtfyReplyFrame) => undefined)
    const ownsRequest = vi.fn(async (_frame: NtfyReplyFrame) => owns)
    let firstSubscription = true
    const runtime: BridgeRuntime = {
      subscribe: () => (async function* (): AsyncIterable<OpencodeEvent> {})(),
      getSessionInfo: async () => ({}),
      publish: async () => undefined,
      subscribeReplies: () => {
        // One-shot stream: the first subscription carries the frames, reconnects come back empty.
        const batch = firstSubscription ? frames : []
        firstSubscription = false
        return (async function* (): AsyncIterable<NtfyReplyFrame> { for (const frame of batch) yield frame })()
      },
      ownsRequest,
      applyReply,
      generateText: async () => 'Generated summary',
    }
    return { runtime, applyReply, ownsRequest }
  }

  async function settle(bridge: NtfyBridge): Promise<void> {
    // Let the background reply loop consume its one-shot stream before stopping.
    await new Promise((resolve) => setTimeout(resolve, 20))
    bridge.stop()
  }

  it('applies an inbound reply only for requests this process announced', async () => {
    const shared = freshShared()
    const { runtime, applyReply } = makeReplyHarness([
      { sessionID: 'ses_1', requestID: 'per_known', decision: 'once' },
      { sessionID: 'ses_1', requestID: 'per_unknown', decision: 'reject' },
    ])
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: shared })
    await bridge.handle(event('permission.asked', { id: 'per_known', sessionID: 'ses_1', action: 'bash' }))

    bridge.start()
    await settle(bridge)

    expect(applyReply).toHaveBeenCalledTimes(1)
    expect(applyReply).toHaveBeenCalledWith({ sessionID: 'ses_1', requestID: 'per_known', decision: 'once' })
  })

  it('ignores replies for requests already settled through permission.replied', async () => {
    const shared = freshShared()
    const { runtime, applyReply } = makeReplyHarness([
      { sessionID: 'ses_1', requestID: 'per_known', decision: 'once' },
    ])
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: shared })
    await bridge.handle(event('permission.asked', { id: 'per_known', sessionID: 'ses_1', action: 'bash' }))
    await bridge.handle(event('permission.replied', { sessionID: 'ses_1', requestID: 'per_known', reply: { decision: 'once' } }))

    bridge.start()
    await settle(bridge)

    expect(applyReply).not.toHaveBeenCalled()
  })

  it('does not claim a reply this context does not own — the id stays pending for the owner', async () => {
    const shared = freshShared()
    const { runtime, applyReply, ownsRequest } = makeReplyHarness(
      [{ sessionID: 'ses_1', requestID: 'per_known', decision: 'once' }],
      false,
    )
    const bridge = createNtfyBridge(CONFIG, runtime, { sharedState: shared })
    await bridge.handle(event('permission.asked', { id: 'per_known', sessionID: 'ses_1', action: 'bash' }))

    bridge.start()
    await settle(bridge)

    expect(ownsRequest).toHaveBeenCalledTimes(1)
    expect(applyReply).not.toHaveBeenCalled()
    expect(shared.pendingRequests.has('per_known')).toBe(true)
  })
})
