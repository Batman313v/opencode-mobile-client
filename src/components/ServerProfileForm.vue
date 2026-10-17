<template>
  <div class="min-h-dvh flex flex-col">
    <header class="flex items-center gap-3 px-4 pt-4">
      <Button variant="ghost" size="icon" @click="goBack" :aria-label="t('common.back')">
        <ArrowLeft class="h-4 w-4" />
      </Button>
      <h1 class="text-lg font-semibold">{{ isEdit ? t('form.editTitle') : t('form.addTitle') }}</h1>
    </header>

    <form novalidate class="flex-1 p-4 flex flex-col overflow-y-auto pb-6" @submit.prevent="handleSubmit">
      <div class="flex-1 flex flex-col justify-center gap-4">
      <Card>
        <CardContent class="flex flex-col gap-4">
          <div class="flex flex-col gap-1.5">
            <Label for="name" class="text-center justify-center">{{ t('form.name') }}</Label>
            <Input id="name" v-model="form.name" :placeholder="t('form.namePlaceholder')" required />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="baseUrl" class="text-center justify-center">{{ t('form.url') }}</Label>
            <Input id="baseUrl" v-model="form.baseUrl" placeholder="100.x.y.z:4096" inputmode="url" autocomplete="off" autocapitalize="none" spellcheck="false" dir="ltr" required />
            <p v-if="!isEdit && isNative" class="text-xs text-muted-foreground">{{ t('form.pairAddressHint') }}</p>
            <p v-if="urlWarning" class="text-xs text-muted-foreground">{{ urlWarning }}</p>
            <p v-if="urlError" class="text-xs text-destructive">{{ urlError }}</p>
          </div>
          <template v-if="!isEdit && isNative">
            <Button type="button" variant="outline" size="sm" :disabled="pairingBusy || saving || scanning" @click="scanQrCode">
              <QrCode class="h-4 w-4" />
              {{ pairingBusy ? t('form.pairingBusy') : t('form.scanQr') }}
            </Button>
            <p class="text-xs text-muted-foreground">{{ t('form.pairingHint') }}</p>
          </template>
        </CardContent>
        <CardFooter class="flex-col items-stretch gap-4">
          <div class="flex items-center gap-2">
            <Switch id="auth" v-model="form.authEnabled" />
            <Label for="auth">{{ t('form.authentication') }}</Label>
          </div>
          <template v-if="form.authEnabled">
            <div class="flex flex-col gap-1.5">
              <Input id="username" v-model="form.username" placeholder="username" />
            </div>
            <div class="flex flex-col gap-1.5">
              <div class="flex gap-1 items-center">
                <Input id="password" :type="showPassword ? 'text' : 'password'" v-model="form.password" placeholder="password" class="flex-1" />
                <Button v-if="form.password" type="button" variant="ghost" size="icon" @click="form.password = ''">&times;</Button>
                <Button type="button" variant="outline" size="xs" @click="showPassword = !showPassword">{{ showPassword ? t('form.hide') : t('form.show') }}</Button>
              </div>
            </div>
          </template>
        </CardFooter>
      </Card>

      <Alert v-if="formError" variant="destructive">
        <AlertDescription>{{ formError }}</AlertDescription>
      </Alert>
      </div>

      <Button type="submit" class="w-full" size="lg" :disabled="saving">
        {{ saving ? t('form.saving') : (isEdit ? t('form.saveChanges') : t('form.addTitle')) }}
      </Button>
    </form>
  </div>

  <!-- The scanner plugin puts the camera preview BEHIND a transparent webview, so while scanning
       this overlay is the only thing painted: dimmed bars top and bottom, clear window in between. -->
  <Teleport to="body">
    <div v-if="scanning" class="fixed inset-0 z-[9999] flex select-none flex-col text-white">
      <div class="flex items-center justify-between gap-3 bg-black/80 px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)]">
        <span class="text-base font-semibold">{{ t('form.scanQr') }}</span>
        <Button variant="secondary" size="sm" @click="cancelScan">{{ t('common.cancel') }}</Button>
      </div>
      <div class="relative flex-1">
        <div class="absolute left-[10%] right-[10%] top-1/2 h-[46dvh] -translate-y-1/2 rounded-3xl border-2 border-white/40" />
      </div>
      <div class="bg-black/80 px-6 pb-[max(env(safe-area-inset-bottom),1.25rem)] pt-3 text-center">
        <p class="text-sm leading-snug text-white/85">{{ t('form.scanHint') }}</p>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ArrowLeft, QrCode } from '@lucide/vue'
import { Capacitor } from '@capacitor/core'
import { BarcodeScanner, SupportedFormat } from '@capacitor-community/barcode-scanner'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useServerStore } from '@/stores/serverStore'
import { normalizeUrl, stripScheme, validateUrl } from '@/services/opencode/url'
import { isDemoModeCredentials } from '@/services/opencode/demoMode'
import { pairingAddress, pairingCode, parsePairingInput, redeemPairing } from '@/services/opencode/pairing'
import type { ServerProfile } from '@/types'
import { useI18n } from '@/i18n'

const router = useRouter()
const route = useRoute()
const serverStore = useServerStore()
const { t } = useI18n()

const isEdit = computed(() => route.path.includes('/edit'))
const profileId = computed(() => route.params.id as string)

const form = ref({
  name: serverStore.profiles.length === 0 ? `Server#1` : '',
  // Scheme-free "ip:port"; normalizeUrl turns it into a full URL on save.
  baseUrl: '192.168.1.xxx:4096',
  authEnabled: false,
  username: 'opencode',
  password: '',
  allowInsecureHttp: true,
})

const showPassword = ref(false)
const saving = ref(false)
const formError = ref('')
const urlError = ref('')
const urlWarning = ref('')

const isNative = Capacitor.isNativePlatform()
// The single address box doubles as the pairing target: opencode pair's QR may only advertise
// 127.0.0.1, so its code is redeemed at whatever address (e.g. Tailscale IP) the user entered here.
const pairingBusy = ref(false)
// The last redeemed code and its token: a code is single-use, so retrying the same link reuses it.
const lastRedemption = ref<{ code: string; url: string; token: string } | null>(null)

function preferredAddress(): string | undefined {
  return pairingAddress(form.value.baseUrl)
}

const scanning = ref(false)

async function scanQrCode(): Promise<void> {
  try {
    const permission = await BarcodeScanner.checkPermission({ force: true })

    if (!permission.granted) return // Denied: nothing more to do from here.

    // The plugin renders the camera preview behind a transparent webview, so hide all page
    // content (html.qr-scanning in base.css) and show only the scanner overlay while scanning.
    scanning.value = true
    document.documentElement.classList.add('qr-scanning')

    const result = await BarcodeScanner.startScan({ targetedFormats: [SupportedFormat.QR_CODE] })

    if (result.hasContent && result.content) void applyPairing(result.content)
  } catch {
    // The user cancelled the scanner.
  } finally {
    scanning.value = false
    document.documentElement.classList.remove('qr-scanning')
  }
}

async function cancelScan(): Promise<void> {
  try {
    await BarcodeScanner.stopScan({ resolveScan: true })
  } catch {
    // The scan had already ended.
  }
}

onBeforeUnmount(() => {
  if (scanning.value) void cancelScan()
})

async function applyPairing(raw: string): Promise<void> {
  formError.value = ''
  const parsed = parsePairingInput(raw)
  const code = parsed?.code ?? pairingCode(raw)
  const preferred = preferredAddress()

  // A bare code carries no address of its own, so it can only be redeemed at a supplied one.
  if (!code || (!parsed && !preferred)) {
    formError.value = t('form.pairInvalid')
    return
  }

  // The same code again (e.g. re-saving after a failed attempt): the code is spent, reuse its token.
  if (lastRedemption.value && lastRedemption.value.code === code) {
    applyPairingResult(lastRedemption.value.url, lastRedemption.value.token)
    return
  }

  pairingBusy.value = true

  try {
    const result = await redeemPairing({ urls: parsed?.urls ?? [], code }, preferred)

    if (result.type !== 'paired') {
      formError.value = t(result.type === 'expired' ? 'form.pairExpired' : 'form.pairUnreachable')
      return
    }

    lastRedemption.value = { code, url: result.url, token: result.token }
    applyPairingResult(result.url, result.token)
  } finally {
    pairingBusy.value = false
  }
}

function applyPairingResult(url: string, token: string): void {
  // The box shows a scheme-free address; normalization happens on save.
  form.value.baseUrl = stripScheme(url)
  form.value.authEnabled = true
  // The official OpenCode client authenticates as "opencode"; the pairing token is its password.
  form.value.username = 'opencode'
  form.value.password = token
}

function isDemoCredentialsInForm(): boolean {
  return form.value.authEnabled && isDemoModeCredentials({
    username: form.value.username,
    password: form.value.password,
  })
}

watch(() => form.value.baseUrl, () => {
  urlError.value = ''; urlWarning.value = ''
  if (isDemoCredentialsInForm()) return
  const result = validateUrl(normalizeUrl(form.value.baseUrl))
  if (!result.valid) urlError.value = result.error ?? t('form.invalidUrl')
  else if (result.error) urlWarning.value = result.error
})

watch(() => [form.value.authEnabled, form.value.username, form.value.password], () => {
  urlError.value = ''; urlWarning.value = ''
  if (isDemoCredentialsInForm()) return
  const result = validateUrl(normalizeUrl(form.value.baseUrl))
  if (!result.valid) urlError.value = result.error ?? t('form.invalidUrl')
  else if (result.error) urlWarning.value = result.error
})

onMounted(async () => {
  await serverStore.load()

  if (isEdit.value) {
    const profile = serverStore.profiles.find((p: ServerProfile) => p.id === profileId.value)
    if (profile) {
      // The box shows a scheme-free address; normalization happens on save.
      form.value.name = profile.name; form.value.baseUrl = stripScheme(profile.baseUrl)
      form.value.authEnabled = profile.authEnabled; form.value.username = profile.username
      form.value.allowInsecureHttp = profile.allowInsecureHttp
      if (profile.authEnabled) {
        const pw = await serverStore.getPassword(profile.id)
        if (pw) form.value.password = pw
      }
    } else { goBack() }
  } else if (serverStore.profiles.length > 0) {
    form.value.name = `Server#${serverStore.profiles.length + 1}`
  }
})

async function handleSubmit(): Promise<void> {
  formError.value = ''

  if (!form.value.name.trim()) { formError.value = t('form.nameRequired'); return }
  const demoCredentials = isDemoCredentialsInForm()
  if (!demoCredentials) {
    const urlResult = validateUrl(normalizeUrl(form.value.baseUrl))
    if (!urlResult.valid) { formError.value = urlResult.error ?? t('form.invalidUrl'); return }
  }

  saving.value = true
  try {
    const data = {
      name: form.value.name.trim(),
      baseUrl: normalizeUrl(form.value.baseUrl),
      authEnabled: form.value.authEnabled,
      username: form.value.authEnabled ? form.value.username || 'opencode' : 'opencode',
      allowInsecureHttp: form.value.allowInsecureHttp || true,
      lastStatus: 'unknown' as const, lastConnectedAt: null,
    }
    if (isEdit.value) {
      await serverStore.update(profileId.value, data)
      if (form.value.authEnabled && form.value.password) await serverStore.setPassword(profileId.value, form.value.password)
      else if (!form.value.authEnabled) await serverStore.deletePassword(profileId.value)
    } else {
      const profile = await serverStore.add(data)
      if (form.value.authEnabled && form.value.password) await serverStore.setPassword(profile.id, form.value.password)
    }
    goBack()
  } catch (err: any) { formError.value = err?.message ?? t('form.saveFailed') }
  finally { saving.value = false }
}

function goBack(): void { router.push('/') }
</script>
