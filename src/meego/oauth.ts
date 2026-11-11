import type { OrcaWorkerApi } from 'orca/worker'
import type { AuthorizationChallenge } from '../protocol'
import { currentFetch } from './fetch-provider'

const SESSION_KEY = 'meego_oauth_session'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const DEFAULT_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 8_000

export function oauthOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash) return null
    switch (url.hostname) {
      case 'project.feishu.cn': return url.origin
      case 'meegle.com':
      case 'project.meegle.com':
      case 'project.larksuite.com': return 'https://project.larksuite.com'
      default: return null
    }
  } catch {
    return null
  }
}

type ErrorCode = 'consent_required' | 'oauth_cancelled' | 'oauth_denied' | 'oauth_network' |
  'oauth_response' | 'oauth_storage' | 'oauth_unsupported'

export class MeegoOAuthError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'MeegoOAuthError'
  }
}

interface Session {
  origin: string
  clientId: string
  accessToken: string
  refreshToken: string
  expiresAt: number | null
}

type PollResult =
  | { state: 'waiting'; intervalMs: number }
  | { state: 'authorized' }
  | { state: 'expired' }

interface DeviceGrant {
  prompt: AuthorizationChallenge
  clientId: string
  deviceCode: string
  tokenEndpoint: string
  intervalMs: number
  nextPollAt: number
}

interface DeviceFlow {
  origin: string
  controller: AbortController
  grant: DeviceGrant | null
  start: Promise<AuthorizationChallenge>
  poll: Promise<PollResult> | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function milliseconds(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value * 1_000 : 0
}

function malformed(): MeegoOAuthError {
  return new MeegoOAuthError('oauth_response', '飞书项目返回了无法识别的授权响应，请稍后重试。')
}

function authRequired(): MeegoOAuthError {
  return new MeegoOAuthError('consent_required', '飞书项目连接已失效，请重新授权。')
}

function trustedUrl(value: unknown, origin: string): URL {
  try {
    const url = new URL(text(value))
    if (url.origin === origin && !url.username && !url.password && !url.hash) return url
  } catch {
    // Provider error messages and payloads may contain authorization data.
  }
  throw malformed()
}

async function request(url: string, signal: AbortSignal, body?: URLSearchParams | Record<string, unknown>) {
  const form = body instanceof URLSearchParams
  const init: RequestInit = {
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    redirect: 'error'
  }
  if (body !== undefined) {
    init.method = 'POST'
    init.headers = { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }
    init.body = form ? body : JSON.stringify(body)
  }
  let response
  let content
  try {
    response = await currentFetch()(url, init)
    content = await response.text()
  } catch {
    throw new MeegoOAuthError('oauth_network', '无法访问飞书项目授权服务，请检查网络后重试。')
  }
  if (response.status === 429 || response.status >= 500) {
    throw new MeegoOAuthError('oauth_network', '飞书项目授权服务暂时不可用，请稍后重试。')
  }
  if (content.length > 32_768) throw malformed()
  let envelope: Record<string, unknown>
  try {
    envelope = record(JSON.parse(content))
  } catch {
    if (response.status === 401) return { ok: false, status: 401, data: {}, error: '' }
    throw malformed()
  }
  const data = envelope.data === undefined ? envelope : record(envelope.data)
  const code = envelope.code
  return {
    ok: response.ok && (code === undefined || code === 0 || code === '0'),
    status: response.status,
    data,
    error: text(envelope.error) || text(data.error)
  }
}

async function discover(origin: string, signal: AbortSignal) {
  const response = await request(`${origin}/.well-known/oauth-authorization-server`, signal)
  const metadata = response.data
  if (!response.ok || metadata.issuer !== origin) throw malformed()
  return {
    authorization: trustedUrl(metadata.authorization_endpoint, origin),
    registration: trustedUrl(metadata.registration_endpoint, origin).href,
    device: trustedUrl(metadata.device_authorization_endpoint, origin).href,
    token: trustedUrl(metadata.token_endpoint, origin).href
  }
}

export class MeegoOAuth {
  private flow: DeviceFlow | null = null
  private writes: Promise<void> = Promise.resolve()
  private storedSession: Promise<Session | null> | null = null
  private revision = 0
  private refresh: { revision: number; controller: AbortController; task: Promise<string> } | null = null

  constructor(
    private readonly orca: Pick<OrcaWorkerApi, 'secrets'>,
    private readonly now: () => number = Date.now
  ) {}

  pending(baseUrl: string): AuthorizationChallenge | undefined {
    const flow = this.flow
    const now = this.now()
    if (flow === null || flow.origin !== oauthOrigin(baseUrl) || flow.grant === null || flow.grant.prompt.expiresAt <= now) {
      return undefined
    }
    return { ...flow.grant.prompt, intervalMs: Math.max(0, flow.grant.nextPollAt - now) }
  }

  async start(baseUrl: string): Promise<AuthorizationChallenge> {
    const origin = oauthOrigin(baseUrl)
    if (origin === null) {
      throw new MeegoOAuthError('oauth_unsupported', '这个地址无法使用个人授权，请检查飞书项目地址。')
    }
    if (this.flow?.origin === origin && (this.flow.grant === null || this.flow.grant.prompt.expiresAt > this.now())) {
      return await this.flow.start
    }
    this.cancel()
    const controller = new AbortController()
    const flow: DeviceFlow = {
      origin,
      controller,
      grant: null,
      poll: null,
      start: this.begin(origin, controller.signal).then((grant) => {
        if (this.flow !== flow) throw new MeegoOAuthError('oauth_cancelled', '授权已取消。')
        flow.grant = grant
        return grant.prompt
      }).catch((error: unknown) => {
        if (this.flow !== flow) throw new MeegoOAuthError('oauth_cancelled', '授权已取消。')
        this.flow = null
        throw error
      })
    }
    this.flow = flow
    return await flow.start
  }

  private async begin(origin: string, signal: AbortSignal): Promise<DeviceGrant> {
    const endpoints = await discover(origin, signal)
    const registration = await request(endpoints.registration, signal, {
      client_name: 'Orca Meego',
      grant_types: [DEVICE_GRANT, 'refresh_token'],
      token_endpoint_auth_method: 'none'
    })
    const clientId = text(registration.data.client_id)
    if (!registration.ok || clientId === '') throw malformed()
    const device = await request(endpoints.device, signal, new URLSearchParams({ client_id: clientId }))
    const deviceCode = text(device.data.device_code)
    const userCode = text(device.data.user_code)
    const expiresIn = milliseconds(device.data.expires_in)
    if (!device.ok || deviceCode === '' || userCode === '' || expiresIn === 0) throw malformed()
    const verification = trustedUrl(device.data.verification_uri_complete || device.data.verification_uri, origin)
    if (verification.pathname !== endpoints.authorization.pathname) throw malformed()
    // The official CLI converts the protocol's query parameter to the browser page's name.
    if (verification.searchParams.has('user_code')) {
      verification.searchParams.delete('user_code')
      verification.searchParams.set('usercode', userCode)
    }
    const intervalMs = Math.max(DEFAULT_INTERVAL_MS, milliseconds(device.data.interval))
    const now = this.now()
    return {
      prompt: { url: verification.href, userCode, expiresAt: now + expiresIn, intervalMs },
      clientId,
      deviceCode,
      tokenEndpoint: endpoints.token,
      intervalMs,
      nextPollAt: now + intervalMs
    }
  }

  async poll(): Promise<PollResult> {
    const flow = this.flow
    if (flow === null) return { state: 'expired' }
    const grant = flow.grant
    if (grant === null) return { state: 'waiting', intervalMs: DEFAULT_INTERVAL_MS }
    const now = this.now()
    if (grant.prompt.expiresAt <= now) {
      this.cancel()
      return { state: 'expired' }
    }
    if (flow.poll !== null) return await flow.poll
    if (grant.nextPollAt > now) return { state: 'waiting', intervalMs: grant.nextPollAt - now }
    grant.nextPollAt = now + grant.intervalMs
    flow.poll = this.pollOnce(flow, grant)
    try {
      return await flow.poll
    } finally {
      flow.poll = null
    }
  }

  private async pollOnce(flow: DeviceFlow, grant: DeviceGrant): Promise<PollResult> {
    try {
      const response = await request(grant.tokenEndpoint, flow.controller.signal, new URLSearchParams({
        grant_type: DEVICE_GRANT,
        device_code: grant.deviceCode,
        client_id: grant.clientId
      }))
      if (this.flow !== flow) return { state: 'expired' }
      switch (response.error) {
        case 'slow_down':
        case 'authorization_pending':
          if (response.error === 'slow_down') grant.intervalMs += DEFAULT_INTERVAL_MS
          grant.nextPollAt = this.now() + grant.intervalMs
          return { state: 'waiting', intervalMs: grant.intervalMs }
        case 'expired_token':
        case 'invalid_grant':
          this.cancel()
          return { state: 'expired' }
        case 'access_denied':
          throw new MeegoOAuthError('oauth_denied', '飞书项目授权未获同意，可以重新发起连接。')
      }
      if (!response.ok || response.error !== '') throw malformed()
      const session = this.toSession(flow.origin, grant.clientId, response.data)
      return await this.write(async () => {
        const previous = await this.session()
        if (this.flow !== flow) return { state: 'expired' }
        await this.saveSession(session)
        if (this.flow !== flow) {
          await this.saveSession(previous)
          return { state: 'expired' }
        }
        this.flow = null
        this.revision += 1
        this.refresh?.controller.abort()
        return { state: 'authorized' }
      })
    } catch (error) {
      if (this.flow !== flow) return { state: 'expired' }
      if (error instanceof MeegoOAuthError && error.code !== 'oauth_network') this.cancel()
      throw error
    }
  }

  cancel(): void {
    this.flow?.controller.abort()
    this.flow = null
  }

  async disconnect(): Promise<void> {
    this.cancel()
    this.revision += 1
    this.refresh?.controller.abort()
    await this.write(() => this.saveSession(null))
  }

  async invalidate(baseUrl: string, rejectedToken: string): Promise<void> {
    const origin = oauthOrigin(baseUrl)
    if (origin === null) return
    await this.write(async () => {
      const session = await this.session()
      if (session?.origin !== origin || session.accessToken !== rejectedToken) return
      await this.saveSession(null)
      this.revision += 1
      this.refresh?.controller.abort()
    })
  }

  async sessionId(baseUrl: string): Promise<string | null> {
    const origin = oauthOrigin(baseUrl)
    if (origin === null) return null
    await this.writes
    const session = await this.session()
    return session?.origin === origin ? session.clientId : null
  }

  async connected(baseUrl: string): Promise<boolean> {
    return await this.sessionId(baseUrl) !== null
  }

  async token(baseUrl: string, rejectedToken?: string): Promise<string> {
    const origin = oauthOrigin(baseUrl)
    const revision = this.revision
    await this.writes
    const session = await this.session()
    if (session === null || session.origin !== origin || revision !== this.revision) throw authRequired()
    if (this.refresh?.revision === revision) return await this.refresh.task
    if ((session.expiresAt === null || this.now() < session.expiresAt) && session.accessToken !== rejectedToken) {
      return session.accessToken
    }
    const controller = new AbortController()
    const refresh = { revision, controller, task: this.refreshToken(session, revision, controller.signal) }
    this.refresh = refresh
    try {
      return await refresh.task
    } finally {
      if (this.refresh === refresh) this.refresh = null
    }
  }

  private async refreshToken(session: Session, revision: number, signal: AbortSignal): Promise<string> {
    let replacement: Session | null = null
    if (session.refreshToken !== '') {
      const endpoints = await discover(session.origin, signal)
      const response = await request(endpoints.token, signal, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: session.clientId
      }))
      const invalid = response.status === 401 || ['invalid_grant', 'invalid_client', 'invalid_token'].includes(response.error)
      if (!invalid) {
        if (!response.ok || response.error !== '') throw malformed()
        replacement = this.toSession(session.origin, session.clientId, response.data, session.refreshToken)
      }
    }
    return await this.write(async () => {
      if (this.revision !== revision) throw authRequired()
      await this.saveSession(replacement)
      if (replacement === null || this.revision !== revision) throw authRequired()
      return replacement.accessToken
    })
  }

  private toSession(origin: string, clientId: string, data: Record<string, unknown>, fallbackRefresh = ''): Session {
    const accessToken = text(data.access_token)
    if (accessToken === '') throw malformed()
    const expiresIn = milliseconds(data.expires_in)
    return {
      origin,
      clientId,
      accessToken,
      refreshToken: text(data.refresh_token) || fallbackRefresh,
      expiresAt: expiresIn === 0 ? null : this.now() + expiresIn
    }
  }

  private write<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(operation)
    this.writes = result.then(() => undefined, () => undefined)
    return result
  }

  private session(): Promise<Session | null> {
    this.storedSession ??= this.readSession().catch((error: unknown) => {
      this.storedSession = null
      throw error
    })
    return this.storedSession
  }

  private async readSession(): Promise<Session | null> {
    let raw
    try {
      raw = await this.orca.secrets.get(SESSION_KEY)
    } catch {
      throw new MeegoOAuthError('oauth_storage', '无法读取本机的飞书项目凭据。')
    }
    if (raw === null) return null
    try {
      const data = record(JSON.parse(raw))
      if (typeof data.origin === 'string' && oauthOrigin(data.origin) === data.origin &&
          typeof data.clientId === 'string' && data.clientId !== '' &&
          typeof data.accessToken === 'string' && data.accessToken !== '' &&
          typeof data.refreshToken === 'string' &&
          (data.expiresAt === null || (typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)))) {
        return {
          origin: data.origin, clientId: data.clientId, accessToken: data.accessToken,
          refreshToken: data.refreshToken, expiresAt: data.expiresAt
        }
      }
    } catch {
      // A malformed local record should return to the connection screen.
    }
    return null
  }

  private async saveSession(session: Session | null): Promise<void> {
    try {
      if (session === null) await this.orca.secrets.delete(SESSION_KEY)
      else await this.orca.secrets.set(SESSION_KEY, JSON.stringify(session))
      this.storedSession = Promise.resolve(session)
    } catch {
      throw new MeegoOAuthError('oauth_storage', '无法更新本机的飞书项目凭据。')
    }
  }
}
