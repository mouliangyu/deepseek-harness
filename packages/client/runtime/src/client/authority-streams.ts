/** Additional authority event-stream delivery for the shared client runtime. */

import type {
  AuthorityRegistry, HostFrame, IApiClient, MuxFrame, RpcRequest,
} from '@deepseek-ai/dsh-client-connection/client'
import type { AuthorityApiRouter } from './authority-router.ts'

/** Consumers of namespaced authority frames. */
export interface AuthorityStreamSinks {
  /** @param envelope - namespaced mux frame. */
  onMuxEnvelope(envelope: RpcRequest<MuxFrame>): void
  /** @param envelope - namespaced Host frame. */
  onHostEnvelope(envelope: RpcRequest<HostFrame>): void
  /** An authority opened both official event streams. */
  onConnected(): void
}

/** Tracks official event streams for each connected additional authority. */
export class AuthorityStreams {
  private readonly active = new Map<string, { api: IApiClient; abort: AbortController }>()
  private unsubscribe: (() => void) | undefined

  /**
   * @param registry - additional authority providers.
   * @param router - frame id namespace owner.
   * @param sinks - runtime frame consumers.
   */
  constructor(
    private readonly registry: AuthorityRegistry,
    private readonly router: AuthorityApiRouter,
    private readonly sinks: AuthorityStreamSinks,
  ) {}

  /** Start following registry membership and connections. */
  start(): void {
    this.unsubscribe = this.registry.subscribe(() => { this.reconcile() })
    this.reconcile()
  }

  /** Abort every authority stream and stop following the registry. */
  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const stream of this.active.values()) stream.abort.abort()
    this.active.clear()
  }

  private reconcile(): void {
    const present = new Set(this.registry.getSnapshot().ids)
    for (const [id, stream] of this.active) {
      const connection = this.registry.get(id)
      if (present.has(id) && connection?.api === stream.api) continue
      stream.abort.abort()
      this.active.delete(id)
    }
    for (const id of present) {
      if (this.active.has(id)) continue
      const connection = this.registry.get(id)
      if (connection === undefined) continue
      const abort = new AbortController()
      const api = connection.api
      this.active.set(id, { api, abort })
      void this.pump(id, api, abort.signal)
    }
  }

  private async pump(id: string, api: IApiClient, signal: AbortSignal): Promise<void> {
    let muxOpen = false
    let hostOpen = false
    let announced = false
    const opened = (): void => {
      if (!announced && muxOpen && hostOpen) {
        announced = true
        this.sinks.onConnected()
      }
    }
    const mux = this.consume(api.events.mux({}, signal, () => {
      muxOpen = true
      opened()
    }), (envelope) => { this.sinks.onMuxEnvelope(this.router.transformMux(id, envelope)) })
    const host = this.consume(api.events.host({}, signal, () => {
      hostOpen = true
      opened()
    }), (envelope) => { this.sinks.onHostEnvelope(this.router.transformHost(id, envelope)) })
    await Promise.all([mux, host])
  }

  private async consume<F>(
    stream: AsyncIterable<RpcRequest<F>>,
    sink: (envelope: RpcRequest<F>) => void,
  ): Promise<void> {
    try {
      for await (const envelope of stream) sink(envelope)
    } catch (error) {
      console.warn('[client-runtime] authority stream ended:', error)
    }
  }
}
