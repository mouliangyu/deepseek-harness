import { describe, expect, it, vi } from 'vitest'
import { AuthorityRegistry, type AuthorityConnection } from '../src/client/authority.ts'

function connection(state: AuthorityConnection['state'] = 'ready', retainListener = false): AuthorityConnection & {
  closeSpy: ReturnType<typeof vi.fn>
  emit: (next: AuthorityConnection['state']) => void
} {
  const listeners = new Set<(next: AuthorityConnection['state']) => void>()
  let current = state
  const closeSpy = vi.fn(async () => { current = 'closed' })
  return {
    api: {} as never,
    closeSpy,
    get state() { return current },
    subscribe(listener) { listeners.add(listener); return () => { if (!retainListener) listeners.delete(listener) } },
    emit(next) { current = next; for (const listener of listeners) listener(next) },
    close: closeSpy,
  }
}

describe('AuthorityRegistry', () => {
  it('registers providers and exposes lifecycle state without probing health', async () => {
    const registry = new AuthorityRegistry()
    const listener = vi.fn()
    const unsubscribe = registry.subscribe(listener)
    const remote = connection()
    const provider = { id: 'remote-a', kind: 'ssh', connect: vi.fn(async () => remote) }
    const dispose = registry.register(provider)
    expect(registry.getSnapshot()).toEqual({ ids: ['remote-a'], states: { 'remote-a': 'closed' } })
    expect(registry.getSnapshot()).toBe(registry.getSnapshot())

    await expect(registry.connect('remote-a')).resolves.toBe(remote)
    const readySnapshot = registry.getSnapshot()
    await expect(registry.connect('remote-a')).resolves.toBe(remote)
    expect(registry.getSnapshot()).toBe(readySnapshot)
    expect(provider.connect).toHaveBeenCalledOnce()
    expect(registry.get('remote-a')).toBe(remote)
    expect(registry.getSnapshot().states['remote-a']).toBe('ready')
    remote.emit('degraded')
    expect(registry.getSnapshot().states['remote-a']).toBe('degraded')

    await registry.disconnect('remote-a')
    expect(remote.closeSpy).toHaveBeenCalledOnce()
    expect(registry.getSnapshot().states['remote-a']).toBe('closed')
    await dispose()
    await dispose()
    expect(registry.getSnapshot().ids).toEqual([])
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    registry.register({ id: 'unused', kind: 'local', connect: async () => connection() })
    expect(listener).toHaveBeenCalledTimes(6)
  })

  it('rejects duplicate and unknown authorities', async () => {
    const registry = new AuthorityRegistry()
    const provider = { id: 'local', kind: 'local', connect: vi.fn(async () => connection()) }
    registry.register(provider)
    expect(() => registry.register(provider)).toThrow('authority already registered: local')
    await expect(registry.connect('missing')).rejects.toThrow('unknown authority provider: missing')
  })

  it('coalesces concurrent connection attempts', async () => {
    const registry = new AuthorityRegistry()
    const remote = connection()
    let resolveConnection!: (value: AuthorityConnection) => void
    const provider = {
      id: 'remote-a',
      kind: 'ssh',
      connect: vi.fn(() => new Promise<AuthorityConnection>((resolve) => { resolveConnection = resolve })),
    }
    registry.register(provider)

    const first = registry.connect('remote-a')
    const second = registry.connect('remote-a')
    expect(provider.connect).toHaveBeenCalledOnce()
    resolveConnection(remote)

    await expect(first).resolves.toBe(remote)
    await expect(second).resolves.toBe(remote)
  })

  it('reports failed attempts and ignores stale provider state', async () => {
    const registry = new AuthorityRegistry()
    registry.register({ id: 'failed', kind: 'ssh', connect: async () => { throw new Error('offline') } })

    await expect(registry.connect('failed')).rejects.toThrow('offline')
    expect(registry.getSnapshot().states.failed).toBe('failed')
    await registry.disconnect('failed')

    const remote = connection('ready', true)
    registry.register({ id: 'remote-a', kind: 'ssh', connect: async () => remote })
    await registry.connect('remote-a')
    await registry.disconnect('remote-a')
    remote.emit('degraded')
    expect(registry.getSnapshot().states['remote-a']).toBe('closed')
  })

  it('disposes every connected authority', async () => {
    const registry = new AuthorityRegistry()
    const first = connection()
    const second = connection()
    registry.register({ id: 'first', kind: 'local', connect: async () => first })
    registry.register({ id: 'second', kind: 'ssh', connect: async () => second })
    await Promise.all([registry.connect('first'), registry.connect('second')])

    await registry.dispose()

    expect(first.closeSpy).toHaveBeenCalledOnce()
    expect(second.closeSpy).toHaveBeenCalledOnce()
  })

  it('closes a connection that finishes after its provider is unregistered', async () => {
    const registry = new AuthorityRegistry()
    const remote = connection()
    let resolveConnection!: (value: AuthorityConnection) => void
    const dispose = registry.register({
      id: 'remote-a',
      kind: 'ssh',
      connect: () => new Promise<AuthorityConnection>((resolve) => { resolveConnection = resolve }),
    })

    const attempt = registry.connect('remote-a')
    const disposing = dispose()
    resolveConnection(remote)

    await expect(attempt).rejects.toThrow('authority provider was unregistered while connecting: remote-a')
    await disposing
    expect(remote.closeSpy).toHaveBeenCalledOnce()
    expect(registry.getSnapshot()).toEqual({ ids: [], states: {} })
  })
})
