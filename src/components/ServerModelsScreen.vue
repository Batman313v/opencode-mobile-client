<template>
  <div class="min-h-dvh flex flex-col">
    <header class="flex items-center gap-3 px-4 pt-4 mb-3">
      <Button variant="ghost" size="icon" @click="goBack" :aria-label="t('common.back')">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <div class="flex-1 min-w-0">
        <h1 class="text-lg font-semibold">{{ t('servers.models') }}</h1>
        <p v-if="profile" class="text-xs text-muted-foreground truncate">{{ profile.name }}</p>
      </div>
    </header>

    <div v-if="loading" class="flex-1 flex flex-col items-center justify-center gap-4">
      <div class="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
      <p class="text-sm text-muted-foreground">{{ t('models.loading') }}</p>
    </div>

    <div v-else-if="errorText" class="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
      <p class="text-sm text-muted-foreground leading-relaxed">{{ errorText }}</p>
      <Button @click="loadModels">{{ t('common.retry') }}</Button>
    </div>

    <template v-else-if="profile">
      <div class="px-3 mb-2">
        <Input v-model="filter" :placeholder="t('models.filterPlaceholder')" class="h-9" />
      </div>

      <div v-if="groups.length === 0" class="flex-1 flex items-center justify-center text-sm text-muted-foreground p-6">
        {{ t('models.empty') }}
      </div>

      <div v-else class="flex-1 overflow-y-auto px-3 pb-4 flex flex-col gap-3">
        <section v-for="group in groups" :key="group.providerID">
          <h2 class="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">{{ group.providerID }}</h2>
          <div class="rounded-lg border divide-y">
            <div
              v-for="model in group.models"
              :key="modelKey(model.providerID, model.id)"
              class="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span class="text-sm">{{ model.name }}</span>
              <Switch
                :aria-label="model.name"
                :model-value="effectiveVisible(model)"
                @update:model-value="onToggleModel(model, $event)"
              />
            </div>
          </div>
        </section>

        <Button v-if="overrides.length > 0" variant="outline" size="sm" class="self-start mt-1" @click="clearOverrides">
          {{ t('models.clearOverrides') }}
        </Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useServerStore } from '@/stores/serverStore'
import { computeDefaultVisible, fetchServerModels, modelKey, type ModelInfo } from '@/services/opencode/modelVisibility'
import { configureSystemBars } from '@/services/platform/systemBars'
import type { ModelVisibilityEntry, ServerProfile } from '@/types'
import { useI18n } from '@/i18n'

const route = useRoute()
const router = useRouter()
const serverStore = useServerStore()
const { t } = useI18n()

const profileId = computed(() => route.params.id as string)
const profile = computed(() => serverStore.profiles.find((p: ServerProfile) => p.id === profileId.value))

const loading = ref(true)
const errorText = ref('')
const models = ref<ModelInfo[]>([])
const filter = ref('')

const overrides = computed<ModelVisibilityEntry[]>(() => profile.value?.modelVisibility ?? [])
const defaultVisibleSet = computed(() => computeDefaultVisible(models.value))

interface ModelGroup {
  providerID: string
  models: ModelInfo[]
}

const groups = computed<ModelGroup[]>(() => {
  const needle = filter.value.trim().toLowerCase()
  const filtered = needle
    ? models.value.filter((m) => m.name.toLowerCase().includes(needle) || m.providerID.toLowerCase().includes(needle))
    : models.value

  const byProvider = new Map<string, ModelInfo[]>()

  for (const model of filtered) {
    const list = byProvider.get(model.providerID) ?? []
    list.push(model)
    byProvider.set(model.providerID, list)
  }

  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([providerID, items]) => ({
      providerID,
      models: items.sort((a, b) => a.name.localeCompare(b.name)),
    }))
})

function overrideFor(model: ModelInfo): ModelVisibilityEntry | undefined {
  return overrides.value.find((entry) => entry.providerID === model.providerID && entry.modelID === model.id)
}

function effectiveVisible(model: ModelInfo): boolean {
  const override = overrideFor(model)

  if (override) return override.visibility === 'show'

  return defaultVisibleSet.value.has(modelKey(model.providerID, model.id))
}

function onToggleModel(model: ModelInfo, value: unknown): void {
  void toggleModel(model, Boolean(value))
}

async function toggleModel(model: ModelInfo, value: boolean): Promise<void> {
  const current = profile.value
  if (!current) return

  const isDefaultState = defaultVisibleSet.value.has(modelKey(model.providerID, model.id))
  const next = overrides.value.filter(
    (entry) => entry.providerID !== model.providerID || entry.modelID !== model.id,
  )

  if (value !== isDefaultState) {
    next.push({ providerID: model.providerID, modelID: model.id, visibility: value ? 'show' : 'hide' })
  }

  await serverStore.update(current.id, { modelVisibility: next })
}

async function clearOverrides(): Promise<void> {
  if (!profile.value) return
  await serverStore.update(profile.value.id, { modelVisibility: [] })
}

async function loadModels(): Promise<void> {
  const current = profile.value

  if (!current) {
    router.replace('/')
    return
  }

  loading.value = true
  errorText.value = ''

  try {
    const password = current.authEnabled ? await serverStore.getPassword(current.id) : null
    models.value = await fetchServerModels({
      baseUrl: current.baseUrl,
      username: current.authEnabled ? current.username : undefined,
      password: current.authEnabled && password ? password : undefined,
    })
  } catch {
    errorText.value = t('models.error')
  } finally {
    loading.value = false
  }
}

function goBack(): void {
  router.push('/')
}

onMounted(async () => {
  configureSystemBars()
  await serverStore.load()
  await loadModels()
})
</script>
