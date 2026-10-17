import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MERGE_STATE_SOURCE,
  buildModelVisibilityScript,
  computeDefaultVisible,
  fetchServerModels,
  modelKey,
  type ModelInfo,
} from '@/services/opencode/modelVisibility'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-15T00:00:00Z')

describe('modelKey', () => {
  it('joins provider and model ids with a colon', () => {
    expect(modelKey('openai', 'gpt-4o')).toBe('openai:gpt-4o')
  })
})

describe('computeDefaultVisible', () => {
  it('shows the newest release per provider+family within six months and hides older siblings', () => {
    const models: ModelInfo[] = [
      { id: 'a-new', providerID: 'p', name: 'A New', family: 'fam-a', time: { released: NOW - 30 * DAY } },
      { id: 'a-old', providerID: 'p', name: 'A Old', family: 'fam-a', time: { released: NOW - 400 * DAY } },
      { id: 'b-new', providerID: 'p', name: 'B New', family: 'fam-b', time: { released: NOW - 10 * DAY } },
      { id: 'c-old-only', providerID: 'p', name: 'C Old', family: 'fam-c', time: { released: NOW - 700 * DAY } },
    ]

    expect(computeDefaultVisible(models, NOW)).toEqual(new Set(['p:a-new', 'p:b-new']))
  })

  it('shows models without a release date and hides families with only stale releases', () => {
    const models: ModelInfo[] = [
      { id: 'd-undated', providerID: 'q', name: 'D' },
      { id: 'e-old-only', providerID: 'q', name: 'E Old', family: 'fam-e', time: { released: NOW - 900 * DAY } },
    ]

    expect(computeDefaultVisible(models, NOW)).toEqual(new Set(['q:d-undated']))
  })

  it('keeps families separate across providers even when names match', () => {
    const models: ModelInfo[] = [
      { id: 'm1', providerID: 'p1', name: 'M', family: 'fam', time: { released: NOW - 5 * DAY } },
      { id: 'm2', providerID: 'p2', name: 'M', family: 'fam', time: { released: NOW - 6 * DAY } },
    ]

    expect(computeDefaultVisible(models, NOW)).toEqual(new Set(['p1:m1', 'p2:m2']))
  })
})

type VisibilityEntry = { providerID: string; modelID: string; visibility: 'show' | 'hide' }

/** The merge function ships as source text inside the webview script; load it here to test the exact code that runs. */
function loadMergeFn(): (raw: string | null, overrides: VisibilityEntry[]) => { next: string | null; changed: boolean } {
  // eslint-disable-next-line no-new-func -- deliberate: MERGE_STATE_SOURCE is plain JS meant for the webview runtime
  return new Function(`${MERGE_STATE_SOURCE}; return mergeModelState;`)() as ReturnType<typeof loadMergeFn>
}

describe('mergeModelState (injected script source)', () => {
  it('creates state from scratch when storage is empty', () => {
    const merge = loadMergeFn()
    const result = merge(null, [{ providerID: 'p', modelID: 'm1', visibility: 'hide' }])

    expect(result.changed).toBe(true)
    expect(JSON.parse(result.next!)).toEqual({ user: [{ providerID: 'p', modelID: 'm1', visibility: 'hide' }] })
  })

  it('is a no-op when every override is already stored with the same visibility', () => {
    const merge = loadMergeFn()
    const raw = JSON.stringify({ user: [{ providerID: 'p', modelID: 'm1', visibility: 'show' }], recent: ['x'] })

    expect(merge(raw, [{ providerID: 'p', modelID: 'm1', visibility: 'show' }])).toEqual({ next: null, changed: false })
  })

  it('updates conflicting entries and appends new ones while preserving the rest of the state', () => {
    const merge = loadMergeFn()
    const raw = JSON.stringify({
      user: [
        { providerID: 'p', modelID: 'm1', visibility: 'show' },
        { providerID: 'q', modelID: 'm2', visibility: 'hide' },
      ],
      recent: ['r'],
      variant: {},
    })

    const result = merge(raw, [
      { providerID: 'p', modelID: 'm1', visibility: 'hide' },
      { providerID: 'z', modelID: 'm9', visibility: 'show' },
    ])

    expect(result.changed).toBe(true)
    const state = JSON.parse(result.next!)
    expect(state.user).toEqual([
      { providerID: 'p', modelID: 'm1', visibility: 'hide' },
      { providerID: 'q', modelID: 'm2', visibility: 'hide' },
      { providerID: 'z', modelID: 'm9', visibility: 'show' },
    ])
    expect(state.recent).toEqual(['r'])
    expect(state.variant).toEqual({})
  })

  it('starts fresh when the stored value is corrupt', () => {
    const merge = loadMergeFn()

    const result = merge('{not json', [{ providerID: 'p', modelID: 'm1', visibility: 'show' }])

    expect(result.changed).toBe(true)
    expect(JSON.parse(result.next!)).toEqual({ user: [{ providerID: 'p', modelID: 'm1', visibility: 'show' }] })
  })
})

describe('buildModelVisibilityScript', () => {
  it('returns an empty string when there are no overrides', () => {
    expect(buildModelVisibilityScript([])).toBe('')
  })

  it('embeds the storage key, the override payload, and a one-shot reload', () => {
    const script = buildModelVisibilityScript([{ providerID: 'p', modelID: 'm1', visibility: 'hide' }])

    expect(script).toContain("'opencode.global.dat:model'")
    expect(script).toContain('"providerID":"p"')
    expect(script).toContain('location.reload()')
  })
})

describe('fetchServerModels', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps the /api/model data array and drops entries without an id or provider', async () => {
    const payload = {
      location: { directory: '/workspace' },
      data: [
        { id: 'm1', modelID: 'raw-1', providerID: 'p', name: 'Model One', family: 'fam', time: { released: 123 } },
        { id: '', providerID: 'p', name: 'Missing Id' },
      ],
    }
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => payload,
    }))

    vi.stubGlobal('fetch', fetchMock)

    const models = await fetchServerModels({ baseUrl: 'http://192.168.1.5:4096/' })

    expect(models).toEqual([{ id: 'm1', providerID: 'p', name: 'Model One', family: 'fam', time: { released: 123 } }])
    const [url, init] = fetchMock.mock.calls[0] ?? []
    expect(url).toBe('http://192.168.1.5:4096/api/model')
    expect(init?.headers).toEqual({})
  })

  it('sends a basic auth header when credentials are provided', async () => {
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ location: {}, data: [] }),
    }))

    vi.stubGlobal('fetch', fetchMock)

    await fetchServerModels({ baseUrl: 'http://server.local:4096', username: 'opencode', password: 's3cret' })

    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(init?.headers).toEqual({ Authorization: `Basic ${btoa('opencode:s3cret')}` })
  })

  it('throws on non-2xx responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
      ok: false,
      status: 500,
      json: async () => null,
    })))

    await expect(fetchServerModels({ baseUrl: 'http://server.local:4096' })).rejects.toThrow('HTTP 500')
  })

  it('returns an empty list when the response has no data array', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ location: {} }),
    })))

    await expect(fetchServerModels({ baseUrl: 'http://server.local:4096' })).resolves.toEqual([])
  })
})
