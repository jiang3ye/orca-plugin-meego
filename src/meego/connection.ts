import type { OrcaWorkerApi } from 'orca/worker'
import type { AuthorizationStatus, MeegoSpace, MeegoStatus, WorkItemSource } from '../protocol'
import { MeegoClient } from './client'
import { loadMeegoConfig, missingConfigItems, type MeegoConfig } from './config'
import { MeegoMcpClient } from './mcp-client'
import { MeegoOAuth, oauthOrigin } from './oauth'
import { storageJson } from './storage-json'

const ACCOUNT_KEY = 'meego.account'
const MAX_CLIENTS = 8

interface Account {
  baseUrl: string
  sessionId: string
  user: { key: string; name: string }
  space: MeegoSpace | null
}

export class RequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RequestError'
  }
}

export type ProjectClient = { config: MeegoConfig; client: MeegoClient | MeegoMcpClient }

export class MeegoConnection {
  readonly oauth: MeegoOAuth
  private readonly clients = new Map<string, MeegoClient | MeegoMcpClient>()
  private readonly spaces = new Map<string, MeegoSpace>()
  private directory: { baseUrl: string; sessionId: string; client: MeegoMcpClient } | null = null
  private accountLoad: Promise<Account> | null = null
  private pollRequest: Promise<AuthorizationStatus> | null = null
  private generation = 0

  constructor(private readonly orca: OrcaWorkerApi) {
    this.oauth = new MeegoOAuth(orca)
  }

  async status(): Promise<MeegoStatus> {
    const legacy = await loadMeegoConfig(this.orca)
    const baseUrl = oauthOrigin(legacy.baseUrl)
    const sessionId = baseUrl === null ? null : await this.oauth.sessionId(baseUrl)
    if (baseUrl !== null && sessionId !== null) {
      const account = await this.getAccount(baseUrl, legacy, sessionId)
      const authorization = this.oauth.pending(baseUrl)
      return {
        configured: account.space !== null,
        baseUrl,
        projectKey: account.space?.key ?? '',
        userKey: account.user.key,
        defaultAgent: legacy.agentCommand,
        missing: [],
        ...(authorization ? { authorization } : {}),
        connection: account.space === null
          ? { state: 'choose_space', accountName: account.user.name }
          : { state: 'connected', accountName: account.user.name, spaceName: account.space.name }
      }
    }
    const missing = missingConfigItems(legacy)
    const prior = await this.orca.storage.get(ACCOUNT_KEY)
    const configured = missing.length === 0 && prior === null
    const authorization = this.oauth.pending(legacy.baseUrl)
    return {
      configured,
      baseUrl: legacy.baseUrl,
      projectKey: configured ? legacy.projectKey : '',
      userKey: configured ? legacy.userKey : '',
      defaultAgent: legacy.agentCommand,
      missing,
      ...(authorization ? { authorization } : {}),
      ...(configured ? {} : { connection: { state: 'disconnected' as const } })
    }
  }

  async begin() {
    const { baseUrl } = await loadMeegoConfig(this.orca)
    return this.oauth.start(baseUrl)
  }

  async poll() {
    if (this.pollRequest) return this.pollRequest
    const request = this.oauth.poll().then(async (result) => {
      if (result.state === 'authorized') {
        await this.rememberOAuthMode()
        this.clearClients()
      }
      return result
    })
    this.pollRequest = request
    try {
      return await request
    } finally {
      this.pollRequest = null
    }
  }

  async disconnect(): Promise<void> {
    await this.rememberOAuthMode()
    await this.oauth.disconnect()
    this.clearClients()
  }

  async useLegacy(): Promise<void> {
    await this.disconnect()
    await this.orca.storage.delete(ACCOUNT_KEY)
  }

  async listSpaces(search?: string, page?: number) {
    const { account, config } = await this.requireAccount()
    const generation = this.generation
    const pageNumber = Number.isSafeInteger(page) ? Math.max(1, page ?? 1) : 1
    const result = await this.spaceDirectory(config, account).listSpaces(search, pageNumber)
    await this.rememberSpaces(account, generation, result.spaces)
    return result
  }

  async findSpaceBySlug(slug: string, expectedUserKey?: string): Promise<MeegoSpace | null> {
    const { account, config } = await this.requireAccount()
    this.checkActor(account.user.key, expectedUserKey)
    const generation = this.generation
    const space = await this.spaceDirectory(config, account).findSpaceBySlug(slug)
    await this.rememberSpaces(account, generation, space ? [space] : [])
    return space
  }

  async selectSpace(key: string): Promise<void> {
    const { account } = await this.requireAccount()
    const space = this.spaces.get(key)
    if (space === undefined) throw new RequestError('space_unavailable', '请从当前账号可访问的空间中选择。')
    await this.orca.storage.set(ACCOUNT_KEY, storageJson({ ...account, space }))
  }

  async project(source?: WorkItemSource, expectedUserKey?: string): Promise<ProjectClient> {
    const config = await loadMeegoConfig(this.orca)
    const baseUrl = oauthOrigin(config.baseUrl)
    const sessionId = baseUrl === null ? null : await this.oauth.sessionId(baseUrl)
    if (baseUrl !== null && sessionId !== null) {
      if (source !== undefined && source.baseUrl !== baseUrl) throw this.sourceMismatch()
      const account = await this.getAccount(baseUrl, config, sessionId)
      this.checkActor(account.user.key, expectedUserKey)
      const key = source?.projectKey ?? account.space?.key
      if (!key) throw new RequestError('space_required', '请先选择飞书项目空间。')
      const space = key === account.space?.key ? account.space : this.spaces.get(key)
      const project = { ...config, baseUrl, projectKey: key, userKey: account.user.key, spaceSlug: space?.slug, spaceName: space?.name, webUrlTemplate: '' }
      const scope = JSON.stringify(['oauth', baseUrl, sessionId, key])
      return { config: project, client: this.client(scope, () => this.mcp(project, sessionId)) }
    }
    if (await this.orca.storage.get(ACCOUNT_KEY) !== null) {
      throw new RequestError('consent_required', '飞书项目授权已断开，请重新连接。')
    }
    this.checkActor(config.userKey, expectedUserKey)
    return this.legacy(config, source)
  }

  async legacyProject(): Promise<ProjectClient> {
    return this.legacy(await loadMeegoConfig(this.orca))
  }

  private legacy(config: MeegoConfig, source?: WorkItemSource): ProjectClient {
    const missing = missingConfigItems(config)
    if (missing.length > 0) throw new RequestError('not_configured', `请先连接飞书项目，或在高级连接中补全 ${missing.map((item) => item.label).join('、')}。`)
    if (source !== undefined && (source.baseUrl !== config.baseUrl || source.projectKey !== config.projectKey)) {
      throw this.sourceMismatch()
    }
    const scope = JSON.stringify([this.generation, 'legacy', config.baseUrl, config.projectKey, config.userKey, config.pluginId, config.pluginSecret])
    return { config, client: this.client(scope, () => new MeegoClient({ config })) }
  }

  private client(scope: string, create: () => MeegoClient | MeegoMcpClient) {
    const existing = this.clients.get(scope)
    if (existing) this.clients.delete(scope)
    const client = existing ?? create()
    this.clients.set(scope, client)
    if (this.clients.size > MAX_CLIENTS) {
      const oldest = this.clients.keys().next().value
      if (oldest !== undefined) this.clients.delete(oldest)
    }
    return client
  }

  private mcp(config: MeegoConfig, sessionId: string) {
    return new MeegoMcpClient({
      config,
      token: async (rejected) => {
        if (await this.oauth.sessionId(config.baseUrl) !== sessionId) throw this.sessionChanged()
        const token = await this.oauth.token(config.baseUrl, rejected)
        if (await this.oauth.sessionId(config.baseUrl) !== sessionId) throw this.sessionChanged()
        return token
      },
      invalidate: (rejected) => this.oauth.invalidate(config.baseUrl, rejected)
    })
  }

  private spaceDirectory(config: MeegoConfig, account: Account): MeegoMcpClient {
    const { baseUrl, sessionId } = account
    if (this.directory?.baseUrl !== baseUrl || this.directory.sessionId !== sessionId) {
      this.directory = { baseUrl, sessionId, client: this.mcp({ ...config, baseUrl }, sessionId) }
    }
    return this.directory.client
  }

  private async rememberSpaces(account: Account, generation: number, spaces: MeegoSpace[]): Promise<void> {
    const sessionId = await this.oauth.sessionId(account.baseUrl)
    if (generation !== this.generation || sessionId !== account.sessionId) throw this.sessionChanged()
    for (const space of spaces) this.spaces.set(space.key, space)
  }

  private async requireAccount() {
    const config = await loadMeegoConfig(this.orca)
    const baseUrl = oauthOrigin(config.baseUrl)
    const sessionId = baseUrl === null ? null : await this.oauth.sessionId(baseUrl)
    if (baseUrl === null || sessionId === null) {
      throw new RequestError('consent_required', '请先连接飞书项目账号。')
    }
    return { config, account: await this.getAccount(baseUrl, config, sessionId) }
  }

  private async getAccount(baseUrl: string, config: MeegoConfig, sessionId: string): Promise<Account> {
    const stored = await this.orca.storage.get(ACCOUNT_KEY) as Account | null
    if (stored?.baseUrl === baseUrl && stored.sessionId === sessionId) return stored
    if (this.accountLoad !== null) return this.accountLoad
    const generation = this.generation
    const client = this.mcp({ ...config, baseUrl }, sessionId)
    const pending = (async () => {
      const user = await client.currentUser()
      const space = stored?.baseUrl === baseUrl && stored.user.key === user.key ? stored.space : null
      if (this.generation !== generation || await this.oauth.sessionId(baseUrl) !== sessionId) throw this.sessionChanged()
      const account = { baseUrl, sessionId, user, space }
      await this.orca.storage.set(ACCOUNT_KEY, storageJson(account))
      return account
    })()
    this.accountLoad = pending
    try {
      return await pending
    } finally {
      if (this.accountLoad === pending) this.accountLoad = null
    }
  }

  private clearClients(): void {
    this.generation += 1
    this.clients.clear()
    this.spaces.clear()
    this.directory = null
    this.accountLoad = null
  }

  private async rememberOAuthMode(): Promise<void> {
    if (await this.orca.storage.get(ACCOUNT_KEY) === null) {
      await this.orca.storage.set(ACCOUNT_KEY, { mode: 'oauth' })
    }
  }

  private checkActor(userKey: string, expectedUserKey: string | undefined): void {
    if (expectedUserKey !== undefined && expectedUserKey !== userKey) throw this.sessionChanged()
  }

  private sourceMismatch(): RequestError {
    return new RequestError('source_mismatch', '这条工作项来自其他飞书项目连接，请切换到对应的连接后重试。')
  }

  private sessionChanged(): RequestError {
    return new RequestError('consent_required', '连接状态已变化，请刷新后重试。')
  }
}
