/** Authority-aware routing over official DSH API clients. */

import type {
  AuthorityRegistry, HostFrame, IApiClient, MuxFrame, RpcRequest,
} from '@deepseek-ai/dsh-client-connection/client'

const PREFIX = '@authority/'
const ID_KEYS = new Set([
  'sessionId', 'parentSessionId', 'childSessionId', 'beforeSessionId',
  'workspaceId', 'beforeWorkspaceId',
])
const ID_ARRAY_KEYS = new Set(['sessionIds', 'archivedSessionIds', 'workspaceIds'])

interface AuthorityRef { authorityId: string; remoteId: string }

/**
 * Encode an authority-owned id for the shared client object model.
 * @param authority - provider id registered with the authority registry.
 * @param remoteId - opaque id used by that authority on the wire.
 * @returns an id that retains the input id's nominal type.
 */
export function authorityId<T extends string>(authority: string, remoteId: T): T {
  return `${PREFIX}${encodeURIComponent(authority)}/${encodeURIComponent(remoteId)}` as T
}

/**
 * Decode a shared id into its authority and wire id.
 * @param value - possible namespaced id.
 * @returns the decoded owner and wire id, or undefined for a local id.
 */
export function parseAuthorityId(value: string): AuthorityRef | undefined {
  if (!value.startsWith(PREFIX)) return undefined
  const [authority, remoteId, extra] = value.slice(PREFIX.length).split('/')
  if (authority === undefined || remoteId === undefined || extra !== undefined) return undefined
  return { authorityId: decodeURIComponent(authority), remoteId: decodeURIComponent(remoteId) }
}

/**
 * Return the authority label carried by a shared id.
 * @param value - local or namespaced id.
 * @returns the provider id, or undefined for a local id.
 */
export function authorityOf(value: string): string | undefined {
  return parseAuthorityId(value)?.authorityId
}

/** Official API router with local baseline aggregation and remote id isolation. */
export class AuthorityApiRouter {
  /** Routed API surface consumed by the ordinary Session and Workspace runtimes. */
  readonly api: IApiClient
  private directoryAuthority: string | undefined
  private configAuthority: string | undefined
  private readonly rpcAuthorities = new Map<string, string>()

  /**
   * @param local - primary page authority.
   * @param registry - additional authority providers.
   */
  constructor(private readonly local: IApiClient, private readonly registry: AuthorityRegistry) {
    const domain = (name: keyof Omit<IApiClient, 'respond' | 'events'>): object => new Proxy({}, {
      get: (_target, method: string) => (payload: unknown, signal?: AbortSignal) => this.call(name, method, payload, signal),
    })
    this.api = {
      sessions: domain('sessions'), subagents: domain('subagents'), host: domain('host'),
      workspace: domain('workspace'), skills: domain('skills'), agentPresets: domain('agentPresets'),
      goals: domain('goals'), settings: domain('settings'), credentials: domain('credentials'), llm: domain('llm'),
      events: local.events,
      respond: async (message, signal) => {
        const authority = this.rpcAuthorities.get(String(message.rpcId))
        if (authority === undefined) return this.local.respond(message, signal)
        const connection = this.registry.get(authority)
        if (connection === undefined) throw new Error(`authority is not connected: ${authority}`)
        return connection.api.respond(message, signal)
      },
    } as IApiClient
  }

  /**
   * Select the authority used by directory and Workspace creation operations.
   * @param authority - connected provider id; undefined selects the primary Host.
   */
  setDirectoryAuthority(authority: string | undefined): void {
    this.directoryAuthority = authority
  }

  /**
   * Select the authority used by settings, credentials, and model requests.
   * @param authority - connected provider id; undefined selects the primary Host.
   */
  setConfigAuthority(authority: string | undefined): void {
    this.configAuthority = authority
  }

  /**
   * Return the currently selected configuration authority.
   * @returns the connected provider id, or undefined for the primary Host.
   */
  getConfigAuthority(): string | undefined {
    return this.configAuthority
  }

  /**
   * Namespace an additional authority's mux frame.
   * @param authority - frame owner.
   * @param envelope - official mux envelope.
   * @returns the client object model envelope.
   */
  transformMux(authority: string, envelope: RpcRequest<MuxFrame>): RpcRequest<MuxFrame> {
    this.rpcAuthorities.set(String(envelope.rpcId), authority)
    return this.transformEnvelope(authority, envelope)
  }

  /**
   * Namespace an additional authority's Host frame.
   * @param authority - frame owner.
   * @param envelope - official Host envelope.
   * @returns the client object model envelope.
   */
  transformHost(authority: string, envelope: RpcRequest<HostFrame>): RpcRequest<HostFrame> {
    this.rpcAuthorities.set(String(envelope.rpcId), authority)
    return this.transformEnvelope(authority, envelope)
  }

  private transformEnvelope<F>(authority: string, envelope: RpcRequest<F>): RpcRequest<F> {
    return { ...envelope, payload: mapIds(envelope.payload, id => authorityId(authority, id)) }
  }

  private connected(): Array<[string, IApiClient]> {
    return this.registry.getSnapshot().ids.flatMap((id) => {
      const connection = this.registry.get(id)
      return connection === undefined ? [] : [[id, connection.api]]
    })
  }

  private async call(
    domain: keyof Omit<IApiClient, 'respond' | 'events'>,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (domain === 'sessions' && (method === 'list' || method === 'search')) {
      return this.aggregate(domain, method, payload, signal)
    }
    if (domain === 'workspace' && method === 'list') return this.aggregate(domain, method, payload, signal)
    const routed = findAuthority(payload)
    const directoryAuthority = (domain === 'host' && method !== 'describe')
      || (domain === 'workspace' && method === 'create')
      ? this.directoryAuthority
      : undefined
    const configAuthority = domain === 'settings' || domain === 'credentials' || domain === 'llm'
      ? this.configAuthority
      : undefined
    const target = routed?.authorityId ?? directoryAuthority ?? configAuthority
    const api = target === undefined ? this.local : this.registry.get(target)?.api
    if (api === undefined) throw new Error(`authority is not connected: ${target ?? 'unknown'}`)
    const request = routed === undefined && target === undefined ? payload : mapIds(payload, unwrapId)
    const response = await invoke(api, domain, method, request, signal)
    return target === undefined
      ? response
      : mapIds(response, id => authorityId(target, id), responseIdKeys(domain, method))
  }

  private async aggregate(
    domain: 'sessions' | 'workspace',
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const calls: Array<Promise<{ authority?: string; response: unknown }>> = [
      invoke(this.local, domain, method, payload, signal).then(response => ({ response })),
      ...this.connected().map(([authority, api]) => invoke(api, domain, method, payload, signal)
        .then(response => ({ authority, response }))),
    ]
    const settled = await Promise.allSettled(calls)
    const successes = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (successes.length === 0) {
      throw settled[0]?.status === 'rejected' ? settled[0].reason : new Error('no authority response')
    }
    const base = structuredClone(successes[0]?.response) as Record<string, unknown>
    const result = base.result as { ok: boolean; value?: Record<string, unknown> }
    if (!result.ok || result.value === undefined) return base
    const values = successes.flatMap(({ authority, response }) => {
      const candidate = response as { result: { ok: boolean; value?: Record<string, unknown> } }
      if (!candidate.result.ok || candidate.result.value === undefined) return []
      return [authority === undefined
        ? candidate.result.value
        : mapIds(candidate.result.value, id => authorityId(authority, id), responseIdKeys(domain, method))]
    })
    result.value.items = values.flatMap(value => Array.isArray(value.items) ? value.items : [])
    if (domain === 'workspace') {
      result.value.archivedSessionIds = values.flatMap(value => Array.isArray(value.archivedSessionIds)
        ? value.archivedSessionIds
        : [])
    }
    if (domain === 'sessions' && method === 'search') {
      result.value.hasMore = values.some(value => value.hasMore === true)
    }
    return base
  }
}

function responseIdKeys(domain: string, method: string): ReadonlySet<string> {
  return domain === 'subagents' && method === 'list' ? new Set([...ID_KEYS, 'id']) : ID_KEYS
}

function findAuthority(value: unknown): AuthorityRef | undefined {
  if (typeof value === 'string') return parseAuthorityId(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAuthority(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (value === null || typeof value !== 'object') return undefined
  for (const [key, item] of Object.entries(value)) {
    if ((ID_KEYS.has(key) && typeof item === 'string')
      || (ID_ARRAY_KEYS.has(key) && Array.isArray(item))) {
      const found = findAuthority(item)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function unwrapId(value: string): string {
  return parseAuthorityId(value)?.remoteId ?? value
}

function mapIds<T>(
  value: T,
  map: (id: string) => string,
  scalarKeys: ReadonlySet<string> = ID_KEYS,
): T {
  if (Array.isArray(value)) return value.map(item => mapIds(item, map, scalarKeys)) as T
  if (value === null || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (scalarKeys.has(key) && typeof item === 'string') output[key] = map(item)
    else if (ID_ARRAY_KEYS.has(key) && Array.isArray(item)) {
      output[key] = item.map(id => typeof id === 'string' ? map(id) : id)
    } else output[key] = mapIds(item, map, scalarKeys)
  }
  return output as T
}

function invoke(
  api: IApiClient,
  domain: keyof Omit<IApiClient, 'respond' | 'events'>,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const methods = api[domain] as unknown as Record<
    string,
    (payload: unknown, signal?: AbortSignal) => Promise<unknown>
  >
  const operation = methods[method]
  if (operation === undefined) throw new Error(`unknown API method: ${String(domain)}.${method}`)
  return operation(payload, signal)
}
