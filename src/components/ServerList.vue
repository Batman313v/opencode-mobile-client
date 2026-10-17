<template>
  <div class="min-h-dvh flex flex-col">
    <header class="flex items-center gap-3 px-4 pt-4 mb-5">
      <h1 class="text-lg font-semibold flex-1">OpenCode Mobile &lt;Client&gt;</h1>
      <Button variant="ghost" size="icon" @click="addServer" :aria-label="t('common.add')">
        <Plus class="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon" @click="openSettings" :aria-label="t('common.settings')">
        <Settings class="h-4 w-4" />
      </Button>
    </header>

    <div v-if="serverStore.loading" class="flex-1 p-3 flex flex-col gap-2">
      <Card v-for="n in 3" :key="n" size="sm">
        <CardHeader>
          <Skeleton class="h-4 w-1/2 mb-2" />
          <Skeleton class="h-3 w-3/4" />
        </CardHeader>
        <CardFooter>
          <div class="flex w-full items-center gap-1">
            <Skeleton class="size-8 rounded-md" />
            <Skeleton class="size-8 rounded-md" />
            <span class="flex-1" aria-hidden="true" />
            <Skeleton class="size-8 rounded-md" />
          </div>
        </CardFooter>
      </Card>
    </div>

    <div v-else-if="serverStore.profiles.length === 0" class="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground text-sm">
      <p>{{ t('servers.empty') }}</p>
      <Button @click="addServer">{{ t('servers.addFirst') }}</Button>
    </div>

    <div v-else class="flex-1 p-3 overflow-y-auto flex flex-col gap-2 pb-4">
      <Card v-for="profile in serverStore.sortedProfiles" :key="profile.id" size="sm">
        <CardHeader>
          <div class="flex items-center gap-2">
            <CardTitle class="text-sm">{{ profile.name }}</CardTitle>
            <StatusDot :status="profileStatus(profile)" />
          </div>
        </CardHeader>
        <CardFooter class="gap-1">
          <Button variant="ghost" size="icon" class="size-8 text-destructive" :aria-label="t('common.delete')" :title="t('common.delete')" @click="confirmDelete(profile.id)">
            <Trash2 class="h-4 w-4" />
          </Button>
          <Button
            variant="ghost" size="icon" class="size-8"
            :aria-label="t('common.settings')" :title="t('common.settings')"
            :aria-expanded="menuOpenId === profile.id ? 'true' : 'false'"
            @click="toggleMenu(profile.id)"
          >
            <Settings class="h-4 w-4" />
          </Button>
          <template v-if="menuOpenId === profile.id">
            <Button variant="ghost" size="icon" class="size-8" :aria-label="t('servers.models')" :title="t('servers.models')" @click="openModels(profile.id)">
              <Boxes class="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" class="size-8" :aria-label="t('common.edit')" :title="t('common.edit')" @click="editServer(profile.id)">
              <Pencil class="h-4 w-4" />
            </Button>
          </template>
          <span class="flex-1" aria-hidden="true" />
          <Button variant="ghost" size="icon" class="size-8" :aria-label="t('servers.open')" :title="t('servers.open')" @click="connectTo(profile.id)">
            <Play class="fill-current h-4 w-4" />
          </Button>
        </CardFooter>
      </Card>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Boxes, Pencil, Play, Plus, Settings, Trash2 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useServerStore } from '@/stores/serverStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { configureSystemBars } from '@/services/platform/systemBars'
import { useServerHealthPoll } from '@/composables/useServerHealthPoll'
import type { ServerProfile } from '@/types'
import StatusDot from './StatusDot.vue'
import { useI18n } from '@/i18n'

const poll = useServerHealthPoll()

const router = useRouter()
const serverStore = useServerStore()
const connectionStore = useConnectionStore()
const { t } = useI18n()

// At most one card has its settings menu open at a time; it reveals Models + Edit.
const menuOpenId = ref<string | null>(null)

onMounted(async () => {
  await serverStore.load()
  poll.pollNow()
  configureSystemBars()
})

function profileStatus(profile: ServerProfile): string {
  if (profile.id === connectionStore.lastWebviewServerId) return 'connected'
  if (profile.lastStatus === 'auth_required') return 'auth_required'
  if (profile.lastStatus === 'wrong_credentials') return 'wrong_credentials'
  const r = serverStore.reachable[profile.id]
  if (r === true) return 'online'
  if (r === false) return 'offline'
  return 'unknown'
}

function addServer(): void { router.push('/servers/new') }
function openSettings(): void { router.push('/settings') }
function editServer(id: string): void { menuOpenId.value = null; router.push(`/servers/${id}/edit`) }
function openModels(id: string): void { menuOpenId.value = null; router.push(`/servers/${id}/models`) }
function connectTo(id: string): void { router.push(`/connect/${id}`) }

function toggleMenu(id: string): void { menuOpenId.value = menuOpenId.value === id ? null : id }

async function confirmDelete(id: string): Promise<void> {
  const profile = serverStore.profiles.find((p: ServerProfile) => p.id === id)
  if (!profile) return
  const confirmed = window.confirm?.(t('servers.deleteConfirm', { name: profile.name })) ?? false
  if (confirmed) await serverStore.remove(id)
}
</script>
