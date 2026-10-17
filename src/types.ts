export interface ModelVisibilityEntry {
  providerID: string
  modelID: string
  visibility: 'show' | 'hide'
}

export interface ServerProfile {
  id: string
  name: string
  baseUrl: string
  authEnabled: boolean
  username: string
  allowInsecureHttp: boolean
  lastStatus: ServerStatus
  lastConnectedAt: string | null
  modelVisibility?: ModelVisibilityEntry[]
}

export type ServerStatus =
  | 'unknown'
  | 'checking'
  | 'connected'
  | 'auth_required'
  | 'wrong_credentials'
  | 'unreachable'

export type ConnectionState = ServerStatus | 'idle' | 'reconnecting' | 'disconnected'

export interface HealthCheckResult {
  reachable: boolean
  status: ServerStatus
  statusCode?: number
}

export interface ConnectionConfig {
  healthCheckTimeoutMs: number
  healthPollIntervalMs: number
  exponentialReconnect: boolean
}
