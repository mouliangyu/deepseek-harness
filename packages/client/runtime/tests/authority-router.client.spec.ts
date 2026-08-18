import { describe, expect, it, vi } from 'vitest'
import { AuthorityRegistry } from '@deepseek-ai/dsh-client-connection/client'
import type { IApiClient, MuxFrame, RpcRequest } from '@deepseek-ai/dsh-api-remotes/client'
import { AuthorityApiRouter, authorityId, authorityOf, parseAuthorityId } from '../src/client/authority-router.ts'

function api(overrides: Partial<IApiClient>): IApiClient {
  return overrides as IApiClient
}

async function registry(remote: IApiClient): Promise<AuthorityRegistry> {
  const result = new AuthorityRegistry()
  result.register({
    id: 'remote-a',
    kind: 'test',
    connect: async () => ({
      api: remote,
      state: 'ready',
      subscribe: () => () => undefined,
      close: async () => undefined,
    }),
  })
  await result.connect('remote-a')
  return result
}

describe('AuthorityApiRouter', () => {
  it('encodes and decodes authority ids', () => {
    const id = authorityId('remote/a', 'session/1')
    expect(id).toBe('@authority/remote%2Fa/session%2F1')
    expect(parseAuthorityId(id)).toEqual({ authorityId: 'remote/a', remoteId: 'session/1' })
    expect(authorityOf(id)).toBe('remote/a')
    expect(parseAuthorityId('local')).toBeUndefined()
    expect(parseAuthorityId('@authority/only-one-part')).toBeUndefined()
    expect(parseAuthorityId('@authority/a/b/c')).toBeUndefined()
  })

  it('routes session-scoped calls with raw wire ids', async () => {
    const localModels = vi.fn()
    const remoteModels = vi.fn(async () => ({
      rpcId: 'remote',
      result: { ok: true, value: { current: {}, groups: [], failures: [], routable: true } },
    }))
    const router = new AuthorityApiRouter(
      api({ sessions: { models: localModels } as never }),
      await registry(api({ sessions: { models: remoteModels } as never })),
    )

    await router.api.sessions.models({ sessionId: authorityId('remote-a', 'session-1') as never })

    expect(localModels).not.toHaveBeenCalled()
    expect(remoteModels).toHaveBeenCalledWith({ sessionId: 'session-1' }, undefined)
  })

  it('namespaces aggregate results and routes responses by frame rpcId', async () => {
    const localList = vi.fn(async () => ({ rpcId: 'local', result: { ok: true, value: { items: [] } } }))
    const remoteList = vi.fn(async () => ({
      rpcId: 'remote',
      result: { ok: true, value: { items: [{ sessionId: 'session-1' }] } },
    }))
    const localRespond = vi.fn()
    const remoteRespond = vi.fn(async () => ({ accepted: true as const }))
    const remote = api({ sessions: { list: remoteList } as never, respond: remoteRespond })
    const router = new AuthorityApiRouter(
      api({ sessions: { list: localList } as never, respond: localRespond }),
      await registry(remote),
    )

    const listed = await router.api.sessions.list({})
    router.transformMux('remote-a', {
      rpcId: 'question-1',
      payload: { type: 'question/requested', sessionId: 'session-1', questions: [] },
    } as unknown as RpcRequest<MuxFrame>)
    await router.api.respond({
      type: 'client-response',
      rpcId: 'question-1',
      result: { ok: true, value: {} },
    } as never)

    expect(listed.result).toEqual({
      ok: true,
      value: { items: [{ sessionId: authorityId('remote-a', 'session-1') }] },
    })
    expect(remoteRespond).toHaveBeenCalledOnce()
    expect(localRespond).not.toHaveBeenCalled()
  })
})
