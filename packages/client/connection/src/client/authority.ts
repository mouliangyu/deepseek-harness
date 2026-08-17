/** Generic multi-authority connection registry for client providers. */

import type { IApiClient } from './api.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Registered client authorities and their provider-owned connections. */
    authorityRegistry: AuthorityRegistry
  }
}

/** Minimal lifecycle state understood by core; providers may expose richer state separately. */
export type AuthorityState = 'connecting' | 'ready' | 'degraded' | 'failed' | 'closed'

/** A connected provider authority carrying the official API client. */
export interface AuthorityConnection {
  /** Official DSH wire client; request and frame payloads are not translated. */
  readonly api: IApiClient
  /** Current lifecycle state. */
  readonly state: AuthorityState
  /**
   * Subscribe to lifecycle changes; providers own any health-specific details.
   * @param listener - receives each provider-reported state.
   * @returns the unsubscriber.
   */
  subscribe(listener: (state: AuthorityState) => void): () => void
  /** @returns a promise that settles after the provider-owned transport closes. */
  close(): Promise<void>
}

/** Provider that creates one official API authority. */
export interface AuthorityProvider {
  /** Stable authority id used for routing and namespacing. */
  readonly id: string
  /** Provider kind, such as `local`, `ssh`, `container`, or `stdio`. */
  readonly kind: string
  /**
   * Establish the provider-owned transport.
   * @param signal - optional cancellation for this connection attempt.
   * @returns the connected official API authority.
   */
  connect(signal?: AbortSignal): Promise<AuthorityConnection>
}

/** Immutable registry snapshot exposed to UI and runtime consumers. */
export interface AuthoritySnapshot {
  readonly ids: readonly string[]
  readonly states: Readonly<Record<string, AuthorityState>>
}

/**
 * Core-owned provider registry. It does not probe health or retry transports;
 * those policies remain provider-owned. Core only coordinates registration,
 * connection readiness, routing lookup, and teardown.
 */
export class AuthorityRegistry {
  private readonly providers = new Map<string, AuthorityProvider>()
  private readonly connections = new Map<string, {
    connection: AuthorityConnection
    unsubscribe: () => void
  }>()
  private readonly pending = new Map<string, Promise<AuthorityConnection>>()
  private readonly states = new Map<string, AuthorityState>()
  private readonly listeners = new Set<() => void>()

  /**
   * Register a provider.
   * @param provider - provider with a registry-unique id.
   * @returns an async disposer that removes the provider and closes its connection.
   * @throws when the id is already registered.
   */
  register(provider: AuthorityProvider): () => Promise<void> {
    if (this.providers.has(provider.id)) throw new Error(`authority already registered: ${provider.id}`)
    this.providers.set(provider.id, provider)
    this.states.set(provider.id, 'closed')
    this.emit()
    return async () => {
      if (this.providers.get(provider.id) !== provider) return
      this.providers.delete(provider.id)
      this.states.delete(provider.id)
      this.emit()
      await this.disconnect(provider.id)
    }
  }

  /**
   * Connect one provider and retain its official API authority.
   * @param id - registered provider id.
   * @param signal - optional cancellation for a new connection attempt.
   * @returns the existing, pending, or newly connected authority.
   * @throws when the id is unknown or the provider rejects the attempt.
   */
  async connect(id: string, signal?: AbortSignal): Promise<AuthorityConnection> {
    const provider = this.providers.get(id)
    if (provider === undefined) throw new Error(`unknown authority provider: ${id}`)
    const current = this.connections.get(id)
    if (current !== undefined) return current.connection
    const pending = this.pending.get(id)
    if (pending !== undefined) return pending
    this.states.set(id, 'connecting')
    this.emit()
    const attempt = provider.connect(signal).then((connection) => {
      if (this.providers.get(id) !== provider) {
        void connection.close()
        throw new Error(`authority provider was unregistered while connecting: ${id}`)
      }
      this.states.set(id, connection.state)
      const unsubscribe = connection.subscribe((state) => {
        if (this.connections.get(id)?.connection !== connection) return
        this.states.set(id, state)
        this.emit()
      })
      this.connections.set(id, { connection, unsubscribe })
      this.emit()
      return connection
    }).catch((error) => {
      if (this.providers.get(id) === provider) {
        this.states.set(id, 'failed')
        this.emit()
      }
      throw error
    }).finally(() => { this.pending.delete(id) })
    this.pending.set(id, attempt)
    return attempt
  }

  /**
   * Disconnect one provider-owned authority.
   * @param id - registered provider id.
   * @returns a promise that settles after its transport closes.
   */
  async disconnect(id: string): Promise<void> {
    const pending = this.pending.get(id)
    if (pending !== undefined) {
      this.pending.delete(id)
      await pending.catch(() => undefined)
    }
    const record = this.connections.get(id)
    if (record === undefined) return
    this.connections.delete(id)
    record.unsubscribe()
    this.states.set(id, 'closed')
    this.emit()
    await record.connection.close()
  }

  /**
   * Return a connected authority for request routing.
   * @param id - registered provider id.
   * @returns the connection, or undefined while disconnected.
   */
  get(id: string): AuthorityConnection | undefined { return this.connections.get(id)?.connection }

  /**
   * Read an immutable registry snapshot.
   * @returns the current provider ids and lifecycle states.
   */
  getSnapshot(): AuthoritySnapshot {
    const states: Record<string, AuthorityState> = {}
    for (const [id, state] of this.states) states[id] = state
    return { ids: [...this.providers.keys()], states }
  }

  /**
   * Subscribe to provider or connection state changes.
   * @param listener - notified after a snapshot change.
   * @returns the unsubscriber.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Close every provider-owned authority.
   * @returns a promise that settles after every provider-owned authority closes.
   */
  async dispose(): Promise<void> {
    await Promise.all([...this.connections.keys()].map(id => this.disconnect(id)))
  }

  private emit(): void { for (const listener of this.listeners) listener() }
}
