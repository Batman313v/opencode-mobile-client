import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapNtfyFrame, openSseStream, parseSseChunk, type SseFrame } from '@/services/opencode/events'

describe('parseSseChunk', () => {
  it('parses a complete frame and returns an empty tail', () => {
    const frames: Array<{ event?: string; id?: string; data: string }> = []
    const rest = parseSseChunk('event: message\nid: 7\ndata: {"a":1}\n\n', f => frames.push(f))

    expect(rest).toBe('')
    expect(frames).toEqual([{ event: 'message', id: '7', data: '{"a":1}' }])
  })

  it('keeps an incomplete frame in the returned tail', () => {
    const frames: Array<{ event?: string; id?: string; data: string }> = []
    const rest = parseSseChunk('event: x\ndata: par', f => frames.push(f))

    expect(frames).toEqual([])
    expect(rest).toBe('event: x\ndata: par')
  })

  it('parses multiple frames from one chunk and keeps the trailing partial frame', () => {
    const frames: Array<{ event?: string; id?: string; data: string }> = []
    const rest = parseSseChunk(
      'data: one\n\nevent: b\ndata: two\n\ndata: part',
      f => frames.push(f),
    )

    expect(frames).toEqual([
      { data: 'one' },
      { event: 'b', data: 'two' },
    ])
    expect(rest).toBe('data: part')
  })

  it('handles CRLF line endings and multi-line data fields', () => {
    const frames: Array<{ event?: string; id?: string; data: string }> = []
    parseSseChunk('event: e\r\ndata: line1\r\ndata: line2\r\n\r\n', f => frames.push(f))

    expect(frames).toEqual([{ event: 'e', data: 'line1\nline2' }])
  })

  it('ignores comment lines and empty frames', () => {
    const frames: Array<{ event?: string; id?: string; data: string }> = []
    parseSseChunk(': keep-alive\ndata: x\n\n\n', f => frames.push(f))

    expect(frames).toEqual([{ data: 'x' }])
  })
})

/** Wraps a body in the ntfy SSE message envelope ({ event: message, id, data: {message: ...} }). */
function ntfyFrame(body: string): SseFrame {
  return {
    event: 'message',
    id: 'msg_1',
    data: JSON.stringify({ id: 'msg_1', time: 1700000000, event: 'message', topic: 'opencode-mobile', message: body, priority: 3 }),
  }
}

describe('mapNtfyFrame', () => {
  it('maps an idle bridge payload to a completion notification with the session title', () => {
    const frame = ntfyFrame(JSON.stringify({ v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_1', title: 'Fix login bug' }))

    expect(mapNtfyFrame(frame)).toEqual({ kind: 'session-complete', sessionTitle: 'Fix login bug' })
  })

  it('omits the title when absent', () => {
    const frame = ntfyFrame(JSON.stringify({ v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_1' }))

    expect(mapNtfyFrame(frame)).toEqual({ kind: 'session-complete' })
  })

  it('carries the project name from an idle bridge payload', () => {
    const frame = ntfyFrame(JSON.stringify({ v: 1, kind: 'idle', serverName: 'Alpha', sessionID: 'ses_1', project: 'opencode-mobile-client', title: 'Fix login bug' }))

    expect(mapNtfyFrame(frame)).toEqual({ kind: 'session-complete', project: 'opencode-mobile-client', sessionTitle: 'Fix login bug' })
  })

  it('maps a permission bridge payload to an approval notification', () => {
    const frame = ntfyFrame(JSON.stringify({
      v: 1,
      kind: 'permission',
      serverName: 'Alpha',
      requestID: 'per_1',
      sessionID: 'ses_1',
      action: 'bash',
      resources: ['ls'],
      message: 'Run a shell command',
    }))

    expect(mapNtfyFrame(frame)).toEqual({
      kind: 'approval-needed',
      serverName: 'Alpha',
      requestID: 'per_1',
      action: 'bash',
      message: 'Run a shell command',
    })
  })

  it('carries the LLM summary through to the approval notification when present', () => {
    const frame = ntfyFrame(JSON.stringify({
      v: 1, kind: 'permission', serverName: 'Alpha', requestID: 'per_1', sessionID: 'ses_1',
      action: 'bash', message: 'Run a shell command', summary: 'Delete the temporary test file',
    }))

    expect(mapNtfyFrame(frame)).toEqual({
      kind: 'approval-needed',
      serverName: 'Alpha',
      requestID: 'per_1',
      action: 'bash',
      message: 'Run a shell command',
      summary: 'Delete the temporary test file',
    })
  })

  it('maps a waiting bridge payload to a waiting notification with the question title', () => {
    const frame = ntfyFrame(JSON.stringify({
      v: 1, kind: 'waiting', serverName: 'Alpha', sessionID: 'ses_1', title: 'Which database should I use?',
    }))

    expect(mapNtfyFrame(frame)).toEqual({ kind: 'waiting', serverName: 'Alpha', sessionID: 'ses_1', title: 'Which database should I use?' })
  })

  it('maps clear frames so the monitor can dismiss the matching pending notification', () => {
    const waitingClear = ntfyFrame(JSON.stringify({ v: 1, kind: 'waiting-clear', serverName: 'Alpha', sessionID: 'ses_1' }))
    expect(mapNtfyFrame(waitingClear)).toEqual({ kind: 'waiting-clear', sessionID: 'ses_1' })

    const permissionClear = ntfyFrame(JSON.stringify({ v: 1, kind: 'permission-clear', serverName: 'Alpha', requestID: 'per_1', sessionID: 'ses_1' }))
    expect(mapNtfyFrame(permissionClear)).toEqual({ kind: 'permission-clear', requestID: 'per_1' })
  })

  it('drops clear frames without an id to match on', () => {
    expect(mapNtfyFrame(ntfyFrame(JSON.stringify({ v: 1, kind: 'waiting-clear', serverName: 'Alpha' })))).toBeNull()
    expect(mapNtfyFrame(ntfyFrame(JSON.stringify({ v: 1, kind: 'permission-clear', serverName: 'Alpha' })))).toBeNull()
  })

  it('maps plain-text and non-bridge JSON bodies to generic notifications', () => {
    expect(mapNtfyFrame(ntfyFrame('hello from another tool'))).toEqual({ kind: 'generic', text: 'hello from another tool' })
    expect(mapNtfyFrame(ntfyFrame('{"foo":1}'))).toEqual({ kind: 'generic', text: '{"foo":1}' })
  })

  it('ignores the subscribe-open event, empty bodies and malformed envelopes', () => {
    expect(mapNtfyFrame({ event: 'open', data: '{}' })).toBeNull()
    expect(mapNtfyFrame(ntfyFrame('   '))).toBeNull()
    expect(mapNtfyFrame({ event: 'message', id: 'msg_2', data: 'not json' })).toBeNull()
  })
})

describe('openSseStream', () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Fetch stub that serves a fresh stream body per call from queued SSE chunks. */
  function makeFetchStub(chunksByCall: string[][]) {
    const encoder = new TextEncoder()
    const calls: Array<{ url: string; init?: RequestInit }> = []

    const stub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const callIndex = calls.length
      calls.push({ url: String(input), init })
      const queue = (chunksByCall[callIndex] ?? []).map(chunk => encoder.encode(chunk))
      return Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read(): Promise<{ done: boolean; value?: Uint8Array }> {
              const next = queue.shift()
              if (next === undefined) return Promise.resolve({ done: true })
              return Promise.resolve({ done: false, value: next })
            },
          }),
        },
      })
    })

    vi.stubGlobal('fetch', stub)
    return { calls }
  }

  it('forwards parsed frames across chunk boundaries in the ntfy wire format', async () => {
    const harness = makeFetchStub([
      [
        'event: message\nid: 1\ndata: {"message":"one"}\n\nevent: mess',
        'age\nid: 2\ndata: {"message":"two"}\n\n',
      ],
    ])
    const frames: SseFrame[] = []
    const handle = openSseStream({ url: 'https://ntfy.example/opencode-mobile', onFrame: frame => frames.push(frame) })

    await vi.advanceTimersByTimeAsync(0)

    expect(harness.calls).toHaveLength(1)
    const headers = (harness.calls[0].init?.headers ?? {}) as Record<string, string>
    expect(headers.Accept).toBe('text/event-stream')
    // The second message is split across chunks 1–2; every parsed frame is forwarded for mapping.
    expect(frames.map(frame => frame.data)).toEqual(['{"message":"one"}', '{"message":"two"}'])

    handle.close()
  })

  it('sends the bearer token header, reconnects after the stream ends, and stops once closed', async () => {
    const harness = makeFetchStub([['event: message\nid: 1\ndata: {"message":"one"}\n\n'], []])
    const handle = openSseStream({
      url: 'https://ntfy.example/opencode-mobile',
      headers: { Authorization: 'Bearer tok' },
      onFrame: () => {},
    })

    await vi.advanceTimersByTimeAsync(0) // first connection drains and schedules a reconnect
    await vi.advanceTimersByTimeAsync(5000) // reconnect fires; the second stream ends immediately

    expect(harness.calls).toHaveLength(2)
    for (const call of harness.calls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>
      expect(call.url).toBe('https://ntfy.example/opencode-mobile')
      expect(headers.Authorization).toBe('Bearer tok')
    }

    handle.close()
    await vi.advanceTimersByTimeAsync(60_000) // no further reconnects after close
    expect(harness.calls).toHaveLength(2)
  })

  it('resumes with a since= query parameter after a drop so missed messages are replayed', async () => {
    const harness = makeFetchStub([
      [
        'event: message\ndata: {"id":"abc123","event":"message","topic":"opencode-mobile","message":"one"}\n\n' +
          'event: message\ndata: {"id":"def456","event":"message","topic":"opencode-mobile","message":"two"}\n\n',
      ],
      [],
    ])
    const handle = openSseStream({ url: 'https://ntfy.example/opencode-mobile/sse', onFrame: () => {} })

    await vi.advanceTimersByTimeAsync(0) // first stream delivers ids abc123 and def456, then ends
    await vi.advanceTimersByTimeAsync(5000) // reconnect fires

    expect(harness.calls).toHaveLength(2)
    expect(harness.calls[1].url).toBe('https://ntfy.example/opencode-mobile/sse?since=def456')
    const headers = (harness.calls[1].init?.headers ?? {}) as Record<string, string>
    expect(headers['Last-Event-ID']).toBeUndefined()

    handle.close()
  })
})
