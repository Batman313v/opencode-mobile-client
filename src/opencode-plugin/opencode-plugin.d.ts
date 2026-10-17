/**
 * Ambient type stub for `@opencode/plugin` (OpenCode v2 Promise plugin API).
 *
 * The real package is provided by the OpenCode host at runtime — plugins never install it as a
 * dependency. This declaration covers exactly the surface used by ntfy-bridge.ts so the file can
 * be type-checked in this repository without adding the host-only package to devDependencies.
 */
declare module "@opencode/plugin" {
  /** One envelope from the OpenCode v2 event bus (see `V2Event` in @opencode/client). */
  export interface OpencodeEvent {
    id: string
    created?: number
    metadata?: Record<string, unknown>
    type: string
    data: unknown
  }

  /** Subset of the session info record used by this plugin. */
  export interface SessionInfo {
    id: string
    title?: string
    /** Where the session runs — its project directory. */
    location?: { directory?: string }
  }

  /** The context handed to a plugin's `setup` (subset of the real Context). */
  export interface PluginContext {
    /** The location this context is bound to — permission state is scoped per location. */
    readonly location: {
      directory: string
      workspaceID?: string
      project: { id: string; directory: string; canonical?: string }
    }
    readonly event: {
      subscribe(options?: { signal?: AbortSignal; onActivity?: () => void }): AsyncIterable<OpencodeEvent>
    }
    readonly session: {
      /** Resolves with the session record itself (not wrapped in a data envelope). */
      get(input: { sessionID: string }): Promise<SessionInfo>
    }
    readonly permission: {
      /**
       * Resolves when this context's location holds the pending request for the session; rejects
       * with "Permission request not found" otherwise. Permission state is scoped per location,
       * so this doubles as an ownership probe for inbound replies.
       */
      get(input: { sessionID: string; requestID: string }): Promise<Record<string, unknown>>
      reply(input: {
        sessionID: string
        requestID: string
        decision: 'once' | 'always' | 'reject'
        message?: string
      }): Promise<void>
    }
    readonly generate: {
      text(input: {
        prompt: string
        model?: { id: string; providerID: string; variant?: string } | null
      }): Promise<{ data: { text: string } }>
    }
  }
}

// Minimal node built-in surface used by ntfy-bridge.ts. The app tsconfig intentionally excludes
// @types/node (browser code), so these ambient declarations keep the plugin type-checkable in this
// repository without pulling Node typings into the webview program — at runtime the OpenCode host
// provides the real modules.
declare module "node:fs/promises" {
  export function readFile(path: string, encoding: "utf8"): Promise<string>
  export function appendFile(path: string, data: string, encoding: "utf8"): Promise<void>
}

declare module "node:os" {
  export function homedir(): string
  export function hostname(): string
}

declare module "node:path" {
  export function join(...segments: string[]): string
}
