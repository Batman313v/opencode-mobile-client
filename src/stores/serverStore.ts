import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ServerProfile } from '@/types'
import { profileStorage } from '@/services/storage/profileStorage'
import { getSecretStorage } from '@/services/storage'
import { checkServerHealth } from '@/services/opencode/health'

export const useServerStore = defineStore('server', () => {
  const profiles = ref<ServerProfile[]>([])
  const loading = ref(false)
  const reachable = ref<Record<string, boolean>>({})
  /** Bumped on every structural change (load/add/update/remove) so app-level watchers can react. */
  const revision = ref(0)

  const sortedProfiles = computed(() =>
    [...profiles.value].sort((a: ServerProfile, b: ServerProfile) => a.name.localeCompare(b.name))
  )

  async function load(): Promise<void> {
    loading.value = true
    try {
      const next = await profileStorage.loadProfiles()
      // Only bump when the content actually changed — load() runs on every screen visit.
      if (JSON.stringify(next) !== JSON.stringify(profiles.value)) {
        profiles.value = next
        revision.value++
      }
    } finally {
      loading.value = false
    }
  }

  async function save(): Promise<void> {
    await profileStorage.saveProfiles(profiles.value)
  }

  async function add(data: Omit<ServerProfile, 'id'>): Promise<ServerProfile> {
    const profile = await profileStorage.createProfile(data)
    profiles.value.push(profile)
    revision.value++
    return profile
  }

  async function update(id: string, data: Partial<ServerProfile>): Promise<ServerProfile | undefined> {
    const updated = await profileStorage.updateProfile(id, data)
    if (updated) {
      const index = profiles.value.findIndex((p: ServerProfile) => p.id === id)
      if (index !== -1) {
        profiles.value[index] = updated
        revision.value++
      }
    }
    return updated
  }

  async function remove(id: string): Promise<boolean> {
    const secretStorage = getSecretStorage()
    await secretStorage.deletePassword(id)
    const result = await profileStorage.deleteProfile(id)
    if (result) {
      const index = profiles.value.findIndex((p: ServerProfile) => p.id === id)
      if (index !== -1) {
        profiles.value.splice(index, 1)
      }
      delete reachable.value[id]
      revision.value++
    }
    return result
  }

  async function getPassword(profileId: string): Promise<string | null> {
    const secretStorage = getSecretStorage()
    return secretStorage.getPassword(profileId)
  }

  async function setPassword(profileId: string, password: string): Promise<void> {
    const secretStorage = getSecretStorage()
    await secretStorage.setPassword(profileId, password)
    revision.value++
  }

  async function deletePassword(profileId: string): Promise<void> {
    const secretStorage = getSecretStorage()
    await secretStorage.deletePassword(profileId)
  }

  async function checkAllServers(): Promise<void> {
    const healthResults = await Promise.allSettled(
      profiles.value.map(async (profile) => {
        const password = profile.authEnabled ? await getPassword(profile.id) : null
        return checkServerHealth({
          baseUrl: profile.baseUrl,
          username: profile.authEnabled ? profile.username : undefined,
          password: profile.authEnabled && password ? password : undefined,
          timeoutMs: 3500,
        })
      })
    )

    let changed = false
    for (let i = 0; i < healthResults.length; i++) {
      const profile = profiles.value[i]
      if (!profile) continue

      const result = healthResults[i]
      if (result.status === 'fulfilled') {
        const r = result.value.reachable
        if (reachable.value[profile.id] !== r) {
          reachable.value[profile.id] = r
          changed = true
        }
        const status = result.value.status
        if (profile.lastStatus !== status) {
          profile.lastStatus = status
          changed = true
        }
      } else if (reachable.value[profile.id] !== false) {
        reachable.value[profile.id] = false
        if (profile.lastStatus !== 'unreachable') {
          profile.lastStatus = 'unreachable'
          changed = true
        }
      }
    }

    if (changed) {
      await profileStorage.saveProfiles(profiles.value)
    }
  }

  return {
    profiles,
    loading,
    sortedProfiles,
    reachable,
    revision,
    load,
    save,
    add,
    update,
    remove,
    getPassword,
    setPassword,
    deletePassword,
    checkAllServers,
  }
})
