<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useServerStore } from '@/stores/serverStore'
import { applyNotificationState, ensureNativeNotificationsOptedIn } from '@/services/platform/nativeNotifications'

const serverStore = useServerStore()

onMounted(async () => {
  await serverStore.load()
  await ensureNativeNotificationsOptedIn()
  void applyNotificationState()
})

// The app root never unmounts, so this keeps the background event streams in sync with the
// configured servers (add / edit / remove) for the lifetime of the process.
watch(() => serverStore.revision, () => { void applyNotificationState() })
</script>

<style>
/* Global styles are in styles/base.css */
</style>
