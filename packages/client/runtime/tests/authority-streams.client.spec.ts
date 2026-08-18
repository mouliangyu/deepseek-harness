import { describe, expect, it, vi } from 'vitest'
import { AuthorityRegistry } from '@deepseek-ai/dsh-client-connection/client'
import type { HostFrame, IApiClient, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-client-connection/client'
import { AuthorityApiRouter } from '../src/client/authority-router.ts'
import { AuthorityStreams } from '../src/client/authority-streams.ts'

function api(): IApiClient {
  const waitForAbort = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  const stream = <T>(frame: T, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<T>> => ({
    async *[Symbol.asyncIterator]() {
      onOpen?.()
      yield { rpcId: 'remote-rpc', payload: frame } as RpcRequest<T>
      await waitForAbort(signal)
    },
  })
  return {
    events: {
      mux: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => stream({ type: 'mux' } as unknown as MuxFrame, signal, onOpen),
      host: (_payload: unknown, signal: AbortSignal, onOpen?: () => void) => stream({ type: 'host' } as unknown as HostFrame, signal, onOpen),
    },
  } as unknown as IApiClient
}

describe('AuthorityStreams', () => {
  it('fans in both official event streams and stops them with the registry', async () => {
    const registry = new AuthorityRegistry()
    registry.register({ id: 'remote-a', kind: 'test', connect: async () => ({
      api: api(), state: 'ready' as const, subscribe: () => () => undefined, close: async () => undefined,
    }) })
    const connection = await registry.connect('remote-a')
    const router = new AuthorityApiRouter({} as IApiClient, registry)
    const mux: RpcRequest<MuxFrame>[] = []
    const host: RpcRequest<HostFrame>[] = []
    const onConnected = vi.fn()
    const streams = new AuthorityStreams(registry, router, {
      onMuxEnvelope: (envelope) => { mux.push(envelope) },
      onHostEnvelope: (envelope) => { host.push(envelope) },
      onConnected,
    })

    streams.start()
    await vi.waitFor(() => expect(onConnected).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(mux).toHaveLength(1))
    await vi.waitFor(() => expect(host).toHaveLength(1))
    expect(mux[0]?.payload).toEqual({ type: 'mux' })
    expect(host[0]?.payload).toEqual({ type: 'host' })
    expect(connection.api).toBeDefined()
    streams.stop()
    expect(registry.get('remote-a')).toBe(connection)
  })
})
