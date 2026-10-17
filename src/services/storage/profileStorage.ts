import { Preferences } from '@capacitor/preferences'
import type { ServerProfile } from '@/types'

const PROFILES_KEY = 'opencode_server_profiles'

function generateId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

export interface ProfileStorageAdapter {
  loadProfiles(): Promise<ServerProfile[]>
  saveProfiles(profiles: ServerProfile[]): Promise<void>
  getProfile(id: string): Promise<ServerProfile | undefined>
  createProfile(data: Omit<ServerProfile, 'id'>): Promise<ServerProfile>
  updateProfile(id: string, data: Partial<ServerProfile>): Promise<ServerProfile | undefined>
  deleteProfile(id: string): Promise<boolean>
}

export const profileStorage: ProfileStorageAdapter = {
  async loadProfiles(): Promise<ServerProfile[]> {
    const { value } = await Preferences.get({ key: PROFILES_KEY })
    if (!value) return []
    try {
      return JSON.parse(value) as ServerProfile[]
    } catch {
      return []
    }
  },

  async saveProfiles(profiles: ServerProfile[]): Promise<void> {
    await Preferences.set({ key: PROFILES_KEY, value: JSON.stringify(profiles) })
  },

  async getProfile(id: string): Promise<ServerProfile | undefined> {
    const profiles = await this.loadProfiles()
    return profiles.find((p) => p.id === id)
  },

  async createProfile(data: Omit<ServerProfile, 'id'>): Promise<ServerProfile> {
    const profiles = await this.loadProfiles()
    const profile: ServerProfile = { ...data, id: generateId() }
    profiles.push(profile)
    await this.saveProfiles(profiles)
    return profile
  },

  async updateProfile(id: string, data: Partial<ServerProfile>): Promise<ServerProfile | undefined> {
    const profiles = await this.loadProfiles()
    const index = profiles.findIndex((p) => p.id === id)
    if (index === -1) return undefined
    profiles[index] = { ...profiles[index], ...data }
    await this.saveProfiles(profiles)
    return profiles[index]
  },

  async deleteProfile(id: string): Promise<boolean> {
    const profiles = await this.loadProfiles()
    const index = profiles.findIndex((p) => p.id === id)
    if (index === -1) return false
    profiles.splice(index, 1)
    await this.saveProfiles(profiles)
    return true
  },
}
