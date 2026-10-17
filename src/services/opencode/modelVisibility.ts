import { Capacitor } from '@capacitor/core'
import type { ModelVisibilityEntry } from '@/types'
import { normalizeUrl } from './url'
import { buildBasicAuthHeader } from './auth'

/** Subset of the v2 `Model.Info` schema used by this client. */
export interface ModelInfo {
  id: string
  providerID: string
  name: string
  family?: string
  time?: { released?: number }
}

interface FetchModelsOptions {
  baseUrl: string
  username?: string
  password?: string
  timeoutMs?: number
}

/** GET /api/model → the `data` array of model info. */
export async function fetchServerModels(options: FetchModelsOptions): Promise<ModelInfo[]> {
  const { baseUrl, username, password, timeoutMs = 10000 } = options
  const url = `${normalizeUrl(baseUrl)}/api/model`
  const headers: Record<string, string> = {}

  if (username && password) {
    headers['Authorization'] = buildBasicAuthHeader(username, password)
  }

  let body: unknown

  if (Capacitor.isNativePlatform()) {
    const { CapacitorHttp } = await import('@capacitor/core')
    const response = await (CapacitorHttp as any).request({
      url,
      method: 'GET',
      headers,
      connectTimeout: timeoutMs,
      readTimeout: timeoutMs,
    })

    body = response.data
  } else {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, { headers, signal: controller.signal, mode: 'cors' })

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      body = await response.json()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  const data = (body as { data?: unknown } | null)?.data

  if (!Array.isArray(data)) return []

  return data.map((item: any) => ({
    id: String(item.id ?? ''),
    providerID: String(item.providerID ?? ''),
    name: String(item.name ?? item.modelID ?? item.id ?? ''),
    family: typeof item.family === 'string' ? item.family : undefined,
    time: typeof item.time?.released === 'number' ? { released: item.time.released } : undefined,
  })).filter((item: ModelInfo) => item.id && item.providerID)
}

/** Same window OpenCode's web UI uses to decide "recent enough" (luxon average month). */
const sixMonths = 6 * 30.436875 * 24 * 60 * 60 * 1000

function releasedAt(model: ModelInfo): number {
  const value = model.time?.released

  return typeof value === 'number' && Number.isFinite(value) ? value : NaN
}

/**
 * Models OpenCode's web UI shows by default (no user overrides): the most recent release per
 * provider+family within the last six months, plus any model without a parseable release date.
 */
export function computeDefaultVisible(models: ModelInfo[], nowMs: number = Date.now()): Set<string> {
  const latestByBucket = new Map<string, { key: string; released: number }>()

  for (const model of models) {
    const released = releasedAt(model)

    if (!Number.isFinite(released)) continue
    if (Math.abs(nowMs - released) >= sixMonths) continue

    const bucket = `${model.providerID}\u0000${String(model.family)}`
    const current = latestByBucket.get(bucket)

    if (!current || released > current.released) {
      latestByBucket.set(bucket, { key: modelKey(model.providerID, model.id), released })
    }
  }

  const visible = new Set<string>()

  for (const entry of latestByBucket.values()) {
    visible.add(entry.key)
  }

  for (const model of models) {
    if (!Number.isFinite(releasedAt(model))) {
      visible.add(modelKey(model.providerID, model.id))
    }
  }

  return visible
}

export function modelKey(providerID: string, modelID: string): string {
  return `${providerID}:${modelID}`
}

/**
 * Pure merge of our overrides into OpenCode's persisted model state (the JSON stored under the
 * `opencode.global.dat:model` localStorage key). Shipped as source text so it can be embedded in
 * the webview injection script and unit-tested here. Returns `next: null` when nothing changed.
 */
export const MERGE_STATE_SOURCE = `function mergeModelState(raw, overrides) {
  var state;

  if (raw !== null && raw !== undefined) {
    try {
      state = JSON.parse(raw);
    } catch (e) {
      state = null;
    }

    if (!state || typeof state !== 'object' || Array.isArray(state)) state = null;
  }

  if (!state) state = {};

  var user = Array.isArray(state.user) ? state.user : [];
  var changed = false;

  for (var i = 0; i < overrides.length; i++) {
    var o = overrides[i];

    if (!o || !o.providerID || !o.modelID) continue;

    var found = -1;

    for (var j = 0; j < user.length; j++) {
      if (user[j] && user[j].providerID === o.providerID && user[j].modelID === o.modelID) {
        found = j;
        break;
      }
    }

    if (found >= 0) {
      if (user[found].visibility !== o.visibility) {
        var updated = {};

        for (var k in user[found]) updated[k] = user[found][k];

        updated.visibility = o.visibility;
        user[found] = updated;
        changed = true;
      }
    } else {
      user.push({ providerID: o.providerID, modelID: o.modelID, visibility: o.visibility });
      changed = true;
    }
  }

  if (!changed) return { next: null, changed: false };

  state.user = user;

  return { next: JSON.stringify(state), changed: true };
}`

/** localStorage key OpenCode's web UI persists its model visibility state under. */
export const OPENCODE_MODEL_STORAGE_KEY = 'opencode.global.dat:model'

/**
 * Script injected into the OpenCode webview after page load. It merges this server's saved
 * overrides into OpenCode's own persisted state; when that actually changes storage it reloads
 * once so the in-memory app picks the values up (the second pass is a no-op, so this cannot loop).
 */
export function buildModelVisibilityScript(overrides: ModelVisibilityEntry[]): string {
  if (overrides.length === 0) return ''

  const payload = JSON.stringify(overrides.map((entry) => ({
    providerID: entry.providerID,
    modelID: entry.modelID,
    visibility: entry.visibility,
  })))

  return `(function(){
  var KEY='${OPENCODE_MODEL_STORAGE_KEY}';
  var OVERRIDES=${payload};
  ${MERGE_STATE_SOURCE}
  function pass(){
    try{
      var before=localStorage.getItem(KEY);
      var result=mergeModelState(before,OVERRIDES);
      if(result.changed){
        localStorage.setItem(KEY,result.next);
        return true;
      }
    }catch(e){}
    return false;
  }
  pass();
  setTimeout(function(){if(pass()){location.reload()}},1500);
})()`
}
