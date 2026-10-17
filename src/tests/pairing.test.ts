import { afterEach, describe, expect, it, vi } from 'vitest'
import { orderCandidates, pairingAddress, pairingCode, parsePairingInput, redeemPairing } from '@/services/opencode/pairing'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parsePairingInput', () => {
  it('reads the code and every address from an opencode pair QR payload', () => {
    const raw = JSON.stringify({
      code: 'abc_DEF-123',
      urls: ['http://192.168.1.2:49374', 'http://100.98.238.5:49374', 'http://192.168.1.2:49374'],
    })

    expect(parsePairingInput(raw)).toEqual({
      urls: ['http://192.168.1.2:49374', 'http://100.98.238.5:49374'],
      code: 'abc_DEF-123',
    })
  })

  it('reads a plain pairing link and strips the path to the server address', () => {
    expect(parsePairingInput(' http://192.168.1.2:49374/auth/connect/abc_DEF-123 ')).toEqual({
      urls: ['http://192.168.1.2:49374'],
      code: 'abc_DEF-123',
    })
  })

  it('rejects payloads with a missing or invalid code', () => {
    expect(parsePairingInput(JSON.stringify({ code: '', urls: ['http://a:1'] }))).toBeUndefined()
    expect(parsePairingInput(JSON.stringify({ code: 'bad code!', urls: ['http://a:1'] }))).toBeUndefined()
    expect(parsePairingInput(JSON.stringify({ urls: ['http://a:1'] }))).toBeUndefined()
    expect(parsePairingInput('{not json')).toBeUndefined()
  })

  it('rejects QR payloads where any address is not a clean http(s) server origin', () => {
    const base = { code: 'x_y' }

    expect(parsePairingInput(JSON.stringify({ ...base, urls: ['http://a:1', 'ftp://b:2'] }))).toBeUndefined()
    expect(parsePairingInput(JSON.stringify({ ...base, urls: ['http://user:pass@a:1'] }))).toBeUndefined()
    expect(parsePairingInput(JSON.stringify({ ...base, urls: [] }))).toBeUndefined()
  })

  it('rejects links without the /auth/connect/<code> path or with extra segments', () => {
    expect(parsePairingInput('http://192.168.1.2:4096/auth/connect/')).toBeUndefined()
    expect(parsePairingInput('http://192.168.1.2:4096/auth/connect/abc/extra')).toBeUndefined()
    expect(parsePairingInput('opencode-ios://auth/connect/abc')).toBeUndefined()
    expect(parsePairingInput('not a url')).toBeUndefined()
  })
})

describe('orderCandidates', () => {
  it('tries Tailscale addresses first and keeps the rest in order', () => {
    const urls = ['http://192.168.1.5:4096', 'http://100.98.238.126:4096', 'http://172.18.0.2:4096']

    expect(orderCandidates(urls)).toEqual([
      'http://100.98.238.126:4096',
      'http://192.168.1.5:4096',
      'http://172.18.0.2:4096',
    ])
  })

  it('leaves non-Tailscale lists untouched, including IPv6 and host names', () => {
    const urls = ['http://[::1]:4096', 'http://home.lan:4096', 'http://1.2.3.4:4096']

    expect(orderCandidates(urls)).toEqual(urls)
  })
})

describe('pairingCode', () => {
  it('extracts the code from a QR payload, a pairing link, or a bare code', () => {
    expect(pairingCode(JSON.stringify({ code: 'abc_DEF-123', urls: ['http://a:4096'] }))).toBe('abc_DEF-123')
    expect(pairingCode('http://127.0.0.1:4096/auth/connect/abc_DEF-123')).toBe('abc_DEF-123')
    expect(pairingCode('  abc_DEF-123 ')).toBe('abc_DEF-123')
  })

  it('rejects empty, malformed, or non-code input', () => {
    expect(pairingCode('')).toBeUndefined()
    expect(pairingCode('{bad json')).toBeUndefined()
    expect(pairingCode('not a code!')).toBeUndefined()
  })
})

describe('pairingAddress', () => {
  it('builds an origin from ip or hostname plus port, defaulting to port 4096', () => {
    expect(pairingAddress('100.98.238.5:4096')).toBe('http://100.98.238.5:4096')
    expect(pairingAddress('myserver.tailnet.ts.net')).toBe('http://myserver.tailnet.ts.net:4096')
    expect(pairingAddress('192.168.1.10')).toBe('http://192.168.1.10:4096')
  })

  it('keeps the scheme and explicit port of a full URL', () => {
    expect(pairingAddress('https://myserver.ts.net:8443/')).toBe('https://myserver.ts.net:8443')
    expect(pairingAddress('http://10.0.0.5:9999')).toBe('http://10.0.0.5:9999')
  })

  it('rejects empty or unparseable values', () => {
    expect(pairingAddress('')).toBeUndefined()
    expect(pairingAddress('   ')).toBeUndefined()
  })
})

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('redeemPairing', () => {
  it('pairs with the token a candidate returns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)

        if (url.includes('/auth/connect/')) return jsonResponse(200, { token: 'tok-1' })

        return new Response(null, { status: 200 })
      }),
    )

    await expect(redeemPairing({ urls: ['http://192.168.1.2:4096'], code: 'abc_DEF-123' })).resolves.toEqual({
      type: 'paired',
      url: 'http://192.168.1.2:4096',
      token: 'tok-1',
    })
  })

  it('falls back to the next address when an earlier one is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)

        if (url.includes('192.168.1.2')) throw new TypeError('Failed to fetch')

        return jsonResponse(200, { token: 'tok-2' })
      }),
    )

    await expect(
      redeemPairing({ urls: ['http://192.168.1.2:4096', 'http://100.98.238.5:4096'], code: 'abc' }),
    ).resolves.toEqual({ type: 'paired', url: 'http://100.98.238.5:4096', token: 'tok-2' })
  })

  it('reports expired when every address that answered rejected the code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)

        if (!url.includes('/auth/connect/')) throw new TypeError('Failed to fetch')

        return jsonResponse(401, { message: 'Pairing link expired or already used' })
      }),
    )

    await expect(redeemPairing({ urls: ['http://a.lan:4096', 'http://b.lan:4096'], code: 'abc' })).resolves.toEqual({
      type: 'expired',
    })
  })

  it('reports unreachable when no address answers at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input?: RequestInfo | URL) => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(redeemPairing({ urls: ['http://a.lan:4096'], code: 'abc' })).resolves.toEqual({ type: 'unreachable' })
  })

  it('keeps the Tailscale address when a nearer one spent the code first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)

        // The LAN attempt spent the single-use code first; the Tailscale attempt gets a 401.
        if (url.includes('/auth/connect/')) {
          return url.includes('192.168.1.5') ? jsonResponse(200, { token: 'tok-3' }) : jsonResponse(401, { message: 'used' })
        }

        // The follow-up health check on the Tailscale address accepts the token.
        return new Response(null, { status: 200 })
      }),
    )

    await expect(
      redeemPairing({ urls: ['http://192.168.1.5:4096', 'http://100.98.238.126:4096'], code: 'abc' }),
    ).resolves.toEqual({ type: 'paired', url: 'http://100.98.238.126:4096', token: 'tok-3' })
  })

  it('keeps the answering address when the preferred one never answers in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)

        if (url.includes('/auth/connect/') && !url.includes('100.98')) return jsonResponse(200, { token: 'tok-4' })
        if (url.includes('/auth/connect/')) throw new TypeError('Failed to fetch')

        // The preferred address never answered, so no health check may run.
        throw new Error('health check should not run when the preferred address never answers')
      }),
    )

    const result = redeemPairing({ urls: ['http://100.98.238.126:4096', 'http://192.168.1.5:4096'], code: 'abc' })

    await expect(result).resolves.toEqual({ type: 'paired', url: 'http://192.168.1.5:4096', token: 'tok-4' })
  })

  it('redeems a bare code at the user-supplied address when the QR only carries 127.0.0.1', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)

        if (!url.includes('/auth/connect/')) throw new Error('no health check expected')

        // Only the user-supplied Tailscale address answers; 127.0.0.1 is unreachable from this device.
        return url.includes('100.98.238.5') ? jsonResponse(200, { token: 'tok-5' }) : new Response(null, { status: 404 })
      }),
    )

    await expect(
      redeemPairing({ urls: ['http://127.0.0.1:4096'], code: 'abc' }, 'http://100.98.238.5:4096'),
    ).resolves.toEqual({ type: 'paired', url: 'http://100.98.238.5:4096', token: 'tok-5' })

    expect(calls).toContain('http://100.98.238.5:4096/auth/connect/abc')
  })

  it('tries the user-supplied address first and does not duplicate it from the QR payload', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input?: RequestInfo | URL) => {
        const url = String(input)
        calls.push(url)

        return url.includes('100.98.238.5') ? jsonResponse(200, { token: 'tok-6' }) : new Response(null, { status: 404 })
      }),
    )

    await expect(
      redeemPairing({ urls: ['http://192.168.1.5:4096', 'http://100.98.238.5:4096'], code: 'abc' }, 'http://100.98.238.5:4096'),
    ).resolves.toEqual({ type: 'paired', url: 'http://100.98.238.5:4096', token: 'tok-6' })

    expect(calls.filter((url) => url.includes('100.98.238.5'))).toEqual(['http://100.98.238.5:4096/auth/connect/abc'])
  })
})
