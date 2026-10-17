import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SseFrame } from '@/services/opencode/events'

type StreamOptions = {
  url: string
  headers?: Record<string, string>
  onFrame(frame: SseFrame): void
}

const { mockOpenStream } = vi.hoisted(() => ({ mockOpenStream: vi.fn() }))

vi.mock('@/services/opencode/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/opencode/events')>()
  return { ...actual, openSseStream: (options: StreamOptions) => mockOpenStream(options) }
})

import type { NtfyNotification } from '@/services/opencode/events'
import { createNtfyTopicMonitor, type NtfySource } from '@/services/opencode/ntfyTopicMonitor'

type OpenedStream = { options: StreamOptions; close: ReturnType<typeof vi.fn> }

let opened: OpenedStream[] = []

function makeDeps(source: NtfySource | null) {
  const onNotification = vi.fn((_notification: NtfyNotification) => undefined)
  return {
    deps: {
      getSource: async () => source,
      onNotification,
    },
    onNotification,
  }
}

/** ntfy SSE envelope for a v1 bridge payload body. */
function ntfyFrame(body: string): SseFrame {
  return { event: 'message', id: 'msg_1', data: JSON.stringify({ id: 'msg_1', event: 'message', topic: 'opencode-mobile', message: body }) }
}

beforeEach(() => {
  opened = []
  vi.clearAllMocks()
  mockOpenStream.mockImplementation((options: StreamOptions) => {
    const close = vi.fn()
    opened.push({ options, close })
    return { close }
  })
})

describe('createNtfyTopicMonitor', () => {
  it('opens one stream to the configured endpoint with a bearer header when a token is set', async () => {
    const { deps } = makeDeps({ endpoint: 'https://ntfy.example/opencode-mobile', token: 'tok' })
    const monitor = createNtfyTopicMonitor(deps)

    await monitor.start()

    expect(mockOpenStream).toHaveBeenCalledTimes(1)
    expect(opened[0]?.options.url).toBe('https://ntfy.example/opencode-mobile')
    expect(opened[0]?.options.headers?.Authorization).toBe('Bearer tok')
  })

  it('opens no stream when there is no source', async () => {
    const { deps } = makeDeps(null)
    const monitor = createNtfyTopicMonitor(deps)

    await monitor.start()

    expect(mockOpenStream).not.toHaveBeenCalled()
  })

  it('reconciles on re-apply: closes the old stream and opens one for the new endpoint', async () => {
    let source: NtfySource | null = { endpoint: 'https://ntfy.example/old' }
    const { deps } = makeDeps(null)
    // getSource must read the latest value at reconcile time, not capture it.
    deps.getSource = async () => source

    const monitor = createNtfyTopicMonitor(deps)
    await monitor.start()
    expect(opened).toHaveLength(1)

    source = { endpoint: 'https://ntfy.example/new' }
    await monitor.start()

    expect(opened[0].close).toHaveBeenCalledTimes(1)
    const live = opened.filter(entry => entry.close.mock.calls.length === 0)
    expect(live).toHaveLength(1)
    expect(live[0]?.options.url).toBe('https://ntfy.example/new')
  })

  it('maps stream frames to notifications and drops unmappable ones', async () => {
    const { deps, onNotification } = makeDeps({ endpoint: 'https://ntfy.example/opencode-mobile' })
    const monitor = createNtfyTopicMonitor(deps)

    await monitor.start()
    const onFrame = opened[0]?.options.onFrame
    expect(onFrame).toBeTypeOf('function')

    // Idle bridge payload → session-complete.
    onFrame?.(ntfyFrame(JSON.stringify({ v: 1, kind: 'idle', serverName: 'Alpha', project: 'opencode-mobile-client', title: 'Fix login bug' })))
    expect(onNotification).toHaveBeenCalledWith({ kind: 'session-complete', project: 'opencode-mobile-client', sessionTitle: 'Fix login bug' })

    // Permission bridge payload → approval-needed.
    onFrame?.(ntfyFrame(JSON.stringify({ v: 1, kind: 'permission', serverName: 'Alpha', requestID: 'per_1', action: 'bash' })))
    expect(onNotification).toHaveBeenCalledWith({
      kind: 'approval-needed',
      serverName: 'Alpha',
      requestID: 'per_1',
      action: 'bash',
      message: undefined,
    })

    // The subscribe-open event and malformed envelopes are dropped.
    onFrame?.({ event: 'open', data: '{}' })
    onFrame?.({ event: 'message', data: 'not json' })
    expect(onNotification).toHaveBeenCalledTimes(2)
  })

  it('stop() closes the stream and start() reopens it afterwards', async () => {
    const { deps } = makeDeps({ endpoint: 'https://ntfy.example/opencode-mobile' })
    const monitor = createNtfyTopicMonitor(deps)

    await monitor.start()
    expect(monitor.isRunning()).toBe(true)

    monitor.stop()
    expect(opened[0].close).toHaveBeenCalledTimes(1)
    expect(monitor.isRunning()).toBe(false)

    await monitor.start()
    const live = opened.filter(entry => entry.close.mock.calls.length === 0)
    expect(live).toHaveLength(1)
  })
})
