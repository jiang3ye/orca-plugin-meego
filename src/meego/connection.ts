import type { OrcaWorkerApi } from 'orca/worker'
import type { AuthorizationStatus, MeegoSpace, MeegoStatus, WorkItemSource } from '../protocol'
import { MeegoClient } from './client'
import { DEFAULT_BASE_URL, DEFAULT_WEB_URL_TEMPLATE, loadMeegoConfig, missingConfigItems, readMeegoSettingsScope, SECRET_KEYS, SETTING_KEYS, type MeegoConfig } from './config'
import { currentFetch } from './fetch-provider'
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

function removalPending(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'mode' in value && value.mode === 'removing'
}

export class RequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RequestError'
  }
}

export type ProjectClient = {
  config: MeegoConfig
  client: MeegoClient | MeegoMcpClient
  assertCurrent(settings?: Record<string, unknown>): void
}
export type ProjectScopeGuard = { run<T>(effect: () => Promise<T>): Promise<T> }

export class MeegoConnection {
  readonly oauth: MeegoOAuth
  private readonly clients = new Map<string, MeegoClient | MeegoMcpClient>()
  private readonly spaces = new Map<string, MeegoSpace>()
  private directory: { baseUrl: string; sessionId: string; client: MeegoMcpClient } | null = null
  private accountLoad: Promise<Account> | null = null
  private pollRequest: Promise<AuthorizationStatus> | null = null
  private generation = 0
  private changing = false
  private accountWrites: Promise<void> = Promise.resolve()

  constructor(private readonly orca: OrcaWorkerApi) {
    this.oauth = new MeegoOAuth(orca)
  }

  async status(): Promise<MeegoStatus> {
    this.assertIdle()
    const generation = this.generation
    const prior = await this.orca.storage.get(ACCOUNT_KEY)
    this.assertGeneration(generation)
    if (removalPending(prior)) {
      return {
        configured: false,
        baseUrl: DEFAULT_BASE_URL,
        projectKey: '',
        userKey: '',
        missing: [],
        hasSavedConnection: true,
        connection: { state: 'disconnected', removalPending: true }
      }
    }
    const legacy = await loadMeegoConfig(this.orca)
    const baseUrl = oauthOrigin(legacy.baseUrl)
    const sessionId = baseUrl === null ? null : await this.oauth.sessionId(baseUrl)
    if (baseUrl !== null && sessionId !== null) {
      const account = await this.getAccount(baseUrl, legacy, sessionId)
      this.assertGeneration(generation)
      const authorization = this.oauth.pending(baseUrl)
      return {
        configured: account.space !== null,
        baseUrl,
        projectKey: account.space?.key ?? '',
        userKey: account.user.key,
        defaultAgent: legacy.agentCommand,
        missing: [],
        hasSavedConnection: true,
        ...(authorization ? { authorization } : {}),
        connection: account.space === null
          ? { state: 'choose_space', accountName: account.user.name }
          : { state: 'connected', accountName: account.user.name, spaceName: account.space.name }
      }
    }
    const missing = missingConfigItems(legacy)
    this.assertGeneration(generation)
    const configured = missing.length === 0 && prior === null
    const authorization = this.oauth.pending(legacy.baseUrl)
    return {
      configured,
      baseUrl: legacy.baseUrl,
      projectKey: configured ? legacy.projectKey : '',
      userKey: configured ? legacy.userKey : '',
      defaultAgent: legacy.agentCommand,
      missing,
      hasSavedConnection: prior !== null || legacy.pluginId !== '' || legacy.pluginSecret !== '' || legacy.projectKey !== '' || legacy.userKey !== '' || legacy.baseUrl !== DEFAULT_BASE_URL || legacy.webUrlTemplate !== DEFAULT_WEB_URL_TEMPLATE,
      ...(authorization ? { authorization } : {}),
      ...(configured ? {} : { connection: { state: 'disconnected' as const } })
    }
  }

  async begin() {
    this.assertIdle()
    const generation = this.generation
    await this.assertRemovalFinished()
    const { baseUrl } = await loadMeegoConfig(this.orca)
    this.assertGeneration(generation)
    return this.oauth.start(baseUrl)
  }

  async poll() {
    this.assertIdle()
    if (this.pollRequest) return this.pollRequest
    const generation = this.generation
    const request = this.oauth.poll().then(async (result) => {
      if (generation !== this.generation) return { state: 'expired' as const }
      if (result.state === 'authorized') {
        await this.rememberOAuthMode()
        if (generation !== this.generation) return { state: 'expired' as const }
        this.clearClients()
      }
      return result
    })
    this.pollRequest = request
    try {
      return await request
    } finally {
      if (this.pollRequest === request) this.pollRequest = null
    }
  }

  async disconnect(): Promise<void> {
    await this.change(async () => {
      await this.rememberOAuthMode()
      await this.oauth.disconnect()
    })
  }

  async remove(): Promise<void> {
    await this.change(async () => {
      await this.writeAccount(() => this.orca.storage.set(ACCOUNT_KEY, { mode: 'removing' }))
      await this.oauth.disconnect()
      for (const key of Object.values(SECRET_KEYS)) await this.orca.secrets.delete(key)
      for (const [key, value] of [
        [SETTING_KEYS.baseUrl, DEFAULT_BASE_URL], [SETTING_KEYS.projectKey, ''],
        [SETTING_KEYS.userKey, ''], [SETTING_KEYS.webUrlTemplate, DEFAULT_WEB_URL_TEMPLATE]
      ]) await this.orca.settings.set(key, value)
      await this.writeAccount(() => this.orca.storage.delete(ACCOUNT_KEY))
    })
  }

  async saveCredentials(pluginId: string, pluginSecret: string): Promise<void> {
    await this.change(async () => {
      await this.assertRemovalFinished()
      const { baseUrl } = await loadMeegoConfig(this.orca)
      await this.orca.secrets.set(SECRET_KEYS.credentials, JSON.stringify({ baseUrl, pluginId, pluginSecret }))
    })
  }

  async useLegacy(expected: MeegoConfig): Promise<void> {
    await this.change(async () => {
      await this.assertRemovalFinished()
      const current = await loadMeegoConfig(this.orca)
      if ((['baseUrl', 'projectKey', 'userKey', 'pluginId', 'pluginSecret'] as const).some((key) => current[key] !== expected[key])) {
        throw this.sessionChanged()
      }
      await this.rememberOAuthMode()
      await this.oauth.disconnect()
      await this.writeAccount(() => this.orca.storage.delete(ACCOUNT_KEY))
    })
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
    const generation = this.generation
    const space = this.spaces.get(key)
    if (space === undefined) throw new RequestError('space_unavailable', '请从当前账号可访问的空间中选择。')
    await this.writeAccount(async () => {
      const sessionId = await this.oauth.sessionId(account.baseUrl)
      this.assertGeneration(generation)
      if (sessionId !== account.sessionId) throw this.sessionChanged()
      await this.orca.storage.set(ACCOUNT_KEY, storageJson({ ...account, space }))
    })
  }

  async project(source?: WorkItemSource, expectedUserKey?: string): Promise<ProjectClient> {
    this.assertIdle()
    const generation = this.generation
    if (removalPending(await this.orca.storage.get(ACCOUNT_KEY))) throw this.sessionChanged()
    const config = await loadMeegoConfig(this.orca)
    const baseUrl = oauthOrigin(config.baseUrl)
    const sessionId = baseUrl === null ? null : await this.oauth.sessionId(baseUrl)
    if (baseUrl !== null && sessionId !== null) {
      if (source !== undefined && source.baseUrl !== baseUrl) throw this.sourceMismatch()
      const account = await this.getAccount(baseUrl, config, sessionId)
      this.assertGeneration(generation)
      this.checkActor(account.user.key, expectedUserKey)
      const key = source?.projectKey ?? account.space?.key
      if (!key) throw new RequestError('space_required', '请先选择飞书项目空间。')
      const space = key === account.space?.key ? account.space : this.spaces.get(key)
      const project = { ...config, baseUrl, projectKey: key, userKey: account.user.key, spaceSlug: space?.slug, spaceName: space?.name, webUrlTemplate: '' }
      const scope = JSON.stringify(['oauth', baseUrl, sessionId, key])
      return this.bindProject(project, this.client(scope, () => this.mcp(project, sessionId)), generation, config)
    }
    if (await this.orca.storage.get(ACCOUNT_KEY) !== null) {
      throw new RequestError('consent_required', '飞书项目授权已断开，请重新连接。')
    }
    this.checkActor(config.userKey, expectedUserKey)
    this.assertGeneration(generation)
    return this.legacy(config, source)
  }

  async legacyProject(): Promise<ProjectClient> {
    this.assertIdle()
    const generation = this.generation
    await this.assertRemovalFinished()
    const config = await loadMeegoConfig(this.orca)
    this.assertGeneration(generation)
    return this.legacy(config)
  }

  guardProject(project: ProjectClient): ProjectScopeGuard {
    const source = { baseUrl: project.config.baseUrl, projectKey: project.config.projectKey }
    const userKey = project.config.userKey
    return { run: async (effect) => {
      project.assertCurrent()
      const current = await this.project(source, userKey)
      project.assertCurrent()
      if (current.client !== project.client) throw this.sessionChanged()
      project.assertCurrent(await this.orca.settings.get())
      return effect()
    } }
  }

  private bindProject(config: MeegoConfig, client: ProjectClient['client'], generation: number, nativeConfig = config): ProjectClient {
    const nativeScope = { baseUrl: nativeConfig.baseUrl, projectKey: nativeConfig.projectKey, userKey: nativeConfig.userKey }
    return { config, client, assertCurrent: (settings) => {
      this.assertGeneration(generation)
      if (settings) {
        const current = readMeegoSettingsScope(settings)
        if (current.baseUrl !== nativeScope.baseUrl || current.projectKey !== nativeScope.projectKey || current.userKey !== nativeScope.userKey) throw this.sessionChanged()
      }
    } }
  }

  private legacy(config: MeegoConfig, source?: WorkItemSource): ProjectClient {
    const missing = missingConfigItems(config)
    if (missing.length > 0) throw new RequestError('not_configured', `请先连接飞书项目，或在高级连接中补全 ${missing.map((item) => item.label).join('、')}。`)
    if (source !== undefined && (source.baseUrl !== config.baseUrl || source.projectKey !== config.projectKey)) {
      throw this.sourceMismatch()
    }
    const scope = JSON.stringify([this.generation, 'legacy', config.baseUrl, config.projectKey, config.userKey, config.pluginId, config.pluginSecret])
    return this.bindProject(config, this.client(scope, () => new MeegoClient({ config, fetchImpl: this.fetchForConnection() })), this.generation)
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
    const generation = this.generation
    return new MeegoMcpClient({
      config,
      fetchImpl: this.fetchForConnection(),
      token: async (rejected) => {
        this.assertGeneration(generation)
        if (await this.oauth.sessionId(config.baseUrl) !== sessionId) throw this.sessionChanged()
        this.assertGeneration(generation)
        const token = await this.oauth.token(config.baseUrl, rejected)
        if (await this.oauth.sessionId(config.baseUrl) !== sessionId) throw this.sessionChanged()
        this.assertGeneration(generation)
        return token
      },
      invalidate: async (rejected) => {
        if (generation === this.generation && !this.changing) await this.oauth.invalidate(config.baseUrl, rejected)
      }
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
    this.assertIdle()
    const generation = this.generation
    if (removalPending(await this.orca.storage.get(ACCOUNT_KEY))) throw this.sessionChanged()
    const config = await loadMeegoConfig(this.orca)
    const baseUrl = oauthOrigin(config.baseUrl)
    const sessionId = baseUrl === null ? null : await this.oauth.sessionId(baseUrl)
    if (baseUrl === null || sessionId === null) {
      throw new RequestError('consent_required', '请先连接飞书项目账号。')
    }
    const account = await this.getAccount(baseUrl, config, sessionId)
    this.assertGeneration(generation)
    return { config, account }
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
      const account = { baseUrl, sessionId, user, space }
      await this.writeAccount(async () => {
        if (await this.oauth.sessionId(baseUrl) !== sessionId) throw this.sessionChanged()
        this.assertGeneration(generation)
        await this.orca.storage.set(ACCOUNT_KEY, storageJson(account))
      })
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
    this.pollRequest = null
  }

  private async rememberOAuthMode(): Promise<void> {
    await this.writeAccount(async () => {
      const stored = await this.orca.storage.get(ACCOUNT_KEY)
      if (stored === null) await this.orca.storage.set(ACCOUNT_KEY, { mode: 'oauth' })
    })
  }

  private writeAccount(operation: () => Promise<void>): Promise<void> {
    const task = this.accountWrites.then(operation)
    this.accountWrites = task.catch(() => {})
    return task
  }

  private async change(operation: () => Promise<void>): Promise<void> {
    this.assertIdle()
    this.changing = true
    this.clearClients()
    this.oauth.cancel()
    try {
      await operation()
    } finally {
      this.changing = false
    }
  }

  private assertIdle(): void {
    if (this.changing) throw new RequestError('connection_busy', '连接正在更新，请稍后重试。')
  }

  private async assertRemovalFinished(): Promise<void> {
    if (removalPending(await this.orca.storage.get(ACCOUNT_KEY))) {
      throw new RequestError('connection_cleanup_required', '上次连接移除尚未完成，请先重试移除。')
    }
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation || this.changing) throw this.sessionChanged()
  }

  private fetchForConnection() {
    const generation = this.generation
    const fetch = currentFetch()
    return (url: string, init?: RequestInit) => {
      this.assertGeneration(generation)
      return fetch(url, init)
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
