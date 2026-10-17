import { describe, it, expect, beforeEach, vi } from 'vitest'
import { profileStorage } from '@/services/storage/profileStorage'

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
  },
}))

import { Preferences } from '@capacitor/preferences'

function createProfile(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'test-1',
    name: overrides.name ?? 'Test Server',
    baseUrl: 'http://192.168.1.100:4096',
    authEnabled: false,
    username: 'opencode',
    allowInsecureHttp: true,
    lastStatus: 'unknown' as const,
    lastConnectedAt: null,
    ...overrides,
  }
}

describe('profileStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('loadProfiles', () => {
    it('returns empty array when no profiles stored', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: null })
      const profiles = await profileStorage.loadProfiles()
      expect(profiles).toEqual([])
    })

    it('parses stored JSON profiles', async () => {
      const data = [createProfile(), createProfile({ id: 'test-2', name: 'Server 2' })]
      vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(data) })
      const profiles = await profileStorage.loadProfiles()
      expect(profiles).toHaveLength(2)
      expect(profiles[0].name).toBe('Test Server')
      expect(profiles[1].name).toBe('Server 2')
    })

    it('returns empty array on parse error', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: 'invalid-json' })
      const profiles = await profileStorage.loadProfiles()
      expect(profiles).toEqual([])
    })
  })

  describe('createProfile', () => {
    it('creates a profile with generated id', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: '[]' })
      const profile = await profileStorage.createProfile(createProfile({ id: undefined }))
      expect(profile.id).toBeDefined()
      expect(profile.id).not.toBe('test-1')
      expect(profile.name).toBe('Test Server')
    })

  })

  describe('updateProfile', () => {
    it('updates profile fields', async () => {
      const existing = [createProfile()]
      vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(existing) })
      const updated = await profileStorage.updateProfile('test-1', { name: 'Updated Name' })
      expect(updated?.name).toBe('Updated Name')
    })

    it('returns undefined for non-existent id', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: '[]' })
      const updated = await profileStorage.updateProfile('non-existent', { name: 'Test' })
      expect(updated).toBeUndefined()
    })
  })

  describe('deleteProfile', () => {
    it('deletes existing profile', async () => {
      const existing = [createProfile(), createProfile({ id: 'other' })]
      vi.mocked(Preferences.get).mockResolvedValue({ value: JSON.stringify(existing) })
      const result = await profileStorage.deleteProfile('test-1')
      expect(result).toBe(true)

      const savedJson = vi.mocked(Preferences.set).mock.calls[0][0].value
      const saved = JSON.parse(savedJson)
      expect(saved).toHaveLength(1)
      expect(saved[0].id).toBe('other')
    })

    it('returns false for non-existent', async () => {
      vi.mocked(Preferences.get).mockResolvedValue({ value: '[]' })
      const result = await profileStorage.deleteProfile('non-existent')
      expect(result).toBe(false)
    })
  })

})
