import { describe, it, expect } from 'vitest'
import {
  normalizeUrl,
  stripScheme,
  validateUrl,
  sanitizeUrlForDisplay,
  buildWebviewUrl,
  buildWebviewUrlSanitized,
} from '@/services/opencode/url'

describe('normalizeUrl', () => {
  it('adds http:// if no protocol', () => {
    expect(normalizeUrl('192.168.1.100:4096')).toBe('http://192.168.1.100:4096')
  })

  it('keeps https:// if present', () => {
    expect(normalizeUrl('https://opencode.example.com')).toBe('https://opencode.example.com')
  })

  it('keeps http:// if present', () => {
    expect(normalizeUrl('http://localhost:4096')).toBe('http://localhost:4096')
  })

  it('removes trailing slashes', () => {
    expect(normalizeUrl('http://192.168.1.100:4096///')).toBe('http://192.168.1.100:4096')
  })

  it('trims whitespace', () => {
    expect(normalizeUrl('  http://localhost:4096  ')).toBe('http://localhost:4096')
  })

  it('adds the default port 4096 when a bare host has none', () => {
    expect(normalizeUrl('100.98.238.5')).toBe('http://100.98.238.5:4096')
  })

  it('keeps an explicit port and leaves https hosts without a port alone', () => {
    expect(normalizeUrl('10.0.0.5:9999')).toBe('http://10.0.0.5:9999')
    expect(normalizeUrl('https://opencode.example.com/')).toBe('https://opencode.example.com')
  })
})

describe('stripScheme', () => {
  it('removes the http and https prefixes, keeping host and port', () => {
    expect(stripScheme('http://100.98.238.5:4096')).toBe('100.98.238.5:4096')
    expect(stripScheme('https://myserver.ts.net:8443')).toBe('myserver.ts.net:8443')
  })

  it('leaves scheme-free values untouched', () => {
    expect(stripScheme('192.168.1.50:4096')).toBe('192.168.1.50:4096')
  })
})

describe('validateUrl', () => {
  it('accepts valid http URL', () => {
    const result = validateUrl('http://192.168.1.100:4096')
    expect(result.valid).toBe(true)
  })

  it('accepts valid https URL', () => {
    const result = validateUrl('https://opencode.example.com')
    expect(result.valid).toBe(true)
  })

  it('rejects empty URL', () => {
    const result = validateUrl('')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('required')
  })

  it('rejects missing protocol', () => {
    const result = validateUrl('192.168.1.100')
    expect(result.valid).toBe(false)
  })

  it('rejects embedded username in URL', () => {
    const result = validateUrl('http://user@host:4096')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('credentials')
  })

  it('rejects embedded username:password in URL', () => {
    const result = validateUrl('http://user:pass@host:4096')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('credentials')
  })

  it('rejects invalid format', () => {
    const result = validateUrl('not a url')
    expect(result.valid).toBe(false)
  })

  it('warns about non-LAN HTTP', () => {
    const result = validateUrl('http://example.com:4096')
    expect(result.valid).toBe(true)
    expect(result.error).toContain('not secure')
  })

  it('accepts LAN HTTP without warning', () => {
    const result = validateUrl('http://192.168.1.100:4096')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('accepts localhost HTTP', () => {
    const result = validateUrl('http://localhost:4096')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('accepts Tailscale CGNAT HTTP without warning', () => {
    const result = validateUrl('http://100.64.12.34:4096')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('accepts local mDNS HTTP without warning', () => {
    const result = validateUrl('http://opencode.local:4096')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

describe('sanitizeUrlForDisplay', () => {
  it('strips username from URL', () => {
    const result = sanitizeUrlForDisplay('http://user@host:4096/path')
    expect(result).not.toContain('user@')
    expect(result).toContain('host')
  })

  it('strips username:password from URL', () => {
    const result = sanitizeUrlForDisplay('http://user:secret@host:4096/path')
    expect(result).not.toContain('user')
    expect(result).not.toContain('secret')
    expect(result).toContain('host')
  })

  it('keeps URL without credentials unchanged', () => {
    const result = sanitizeUrlForDisplay('http://192.168.1.100:4096')
    expect(result).toBe('http://192.168.1.100:4096')
  })

  it('handles invalid URLs gracefully', () => {
    const result = sanitizeUrlForDisplay('not-a-url')
    expect(result).toBeTruthy()
  })

  it('trailing slash removed', () => {
    const result = sanitizeUrlForDisplay('http://192.168.1.100:4096/')
    expect(result).toBe('http://192.168.1.100:4096')
  })
})

describe('buildWebviewUrl', () => {
  it('builds plain URL when no auth', () => {
    const url = buildWebviewUrl('http://192.168.1.100:4096')
    expect(url).toBe('http://192.168.1.100:4096/')
  })

  it('embeds credentials when auth provided', () => {
    const url = buildWebviewUrl('http://192.168.1.100:4096', 'opencode', 'secret123')
    expect(url).toContain('opencode')
    expect(url).toContain('secret123')
    expect(url).toContain('@')
    expect(url).toBe('http://opencode:secret123@192.168.1.100:4096/')
  })

  it('encodes special characters in credentials', () => {
    const url = buildWebviewUrl('http://host:4096', 'user name', 'pass word')
    expect(url).toContain('user%20name')
    expect(url).toContain('pass%20word')
  })
})

describe('buildWebviewUrlSanitized', () => {
  it('hides credentials in output', () => {
    const result = buildWebviewUrlSanitized('http://host:4096', 'opencode', 'secret')
    expect(result).not.toContain('secret')
    expect(result).not.toContain('opencode@')
    expect(result).toContain('host')
  })
})
