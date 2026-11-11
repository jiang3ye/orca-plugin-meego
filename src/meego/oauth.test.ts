import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from '../worker'
import type { FetchLike } from './client'
import { setFetch } from './fetch-provider'
import { MeegoOAuth, oauthOrigin } from './oauth'

const ORIGIN = 'https://project.feishu.cn'
const METADATA = {
  issuer: ORIGIN,
  authorization_endpoint: `${ORIGIN}/b/auth/mcp`,
  registration_endpoint: `${ORIGIN}/mcp_server/oauth/register`,
  device_authorization_endpoint: `${ORIGIN}/goapi/v5/mcp_server/oauth/device_code`,
  token_endpoint: `${ORIGIN}/mcp_server/oauth/token`
}
const DEVICE = {
  device_code: 'private-device-code',
  user_code: 'USER-CODE',
  verification_uri: METADATA.authorization_endpoint,
  verification_uri_complete: `${METADATA.authorization_endpoint}?mode=device&user_code=USER-CODE`,
  expires_in: 30,
  interval: 5
}
const GRANTED = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 60 }

function reply(body: unknown): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }
}

function fakeOAuth(tokenResponse: (body: URLSearchParams) => Promise<unknown> | unknown) {
  const storage = new Map<string, string>()
  const orca = {
    secrets: {
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: string) => { storage.set(key, value) },
      delete: async (key: string) => { storage.delete(key) }
    }
  }
  let now = 10_000
  let registerCalls = 0
  let tokenCalls = 0
  setFetch(async (url, init) => {
    assert.equal(init?.redirect, 'error')
    if (url.endsWith('/.well-known/oauth-authorization-server')) return reply(METADATA)
    if (url === METADATA.registration_endpoint) {
      registerCalls += 1
      assert.equal(JSON.parse(String(init?.body)).token_endpoint_auth_method, 'none')
      return reply({ client_id: `client-${registerCalls}`, client_secret: 'unused-secret' })
    }
    if (url === METADATA.device_authorization_endpoint) return reply({ code: 0, data: DEVICE })
    if (url === METADATA.token_endpoint) {
      tokenCalls += 1
      return reply(await tokenResponse(new URLSearchParams(String(init?.body))))
    }
    throw new Error('Unexpected OAuth endpoint')
  })
  return {
    oauth: new MeegoOAuth(orca, () => now),
    restarted: () => new MeegoOAuth(orca, () => now),
    advance: (ms: number) => { now += ms },
    registerCalls: () => registerCalls,
    tokenCalls: () => tokenCalls
  }
}

test('device grant hides credentials, obeys interval and slow down, and restores the encrypted session', async () => {
  const results = [{ error: 'authorization_pending' }, { error: 'slow_down' }, GRANTED]
  const fake = fakeOAuth((body) => {
    assert.equal(body.get('device_code'), DEVICE.device_code)
    return results.shift()
  })
  try {
    const [start, repeated] = await Promise.all([fake.oauth.start(ORIGIN), fake.oauth.start(ORIGIN)])
    assert.deepEqual(start, {
      url: `${METADATA.authorization_endpoint}?mode=device&usercode=USER-CODE`,
      userCode: DEVICE.user_code,
      expiresAt: 40_000,
      intervalMs: 5_000
    })
    assert.deepEqual(repeated, start)
    assert.deepEqual(fake.oauth.pending(ORIGIN), start)
    assert.equal(fake.oauth.pending('https://meegle.com'), undefined)
    assert.equal(fake.registerCalls(), 1)
    assert.equal(await fake.oauth.connected(ORIGIN), false)
    assert.deepEqual(await fake.oauth.poll(), { state: 'waiting', intervalMs: 5_000 })
    assert.equal(fake.tokenCalls(), 0)

    fake.advance(5_000)
    assert.deepEqual(await fake.oauth.poll(), { state: 'waiting', intervalMs: 5_000 })
    assert.deepEqual(fake.oauth.pending(ORIGIN), { ...start, intervalMs: 5_000 })
    fake.advance(5_000)
    assert.deepEqual(await fake.oauth.poll(), { state: 'waiting', intervalMs: 10_000 })
    fake.advance(5_000)
    assert.deepEqual(await fake.oauth.poll(), { state: 'waiting', intervalMs: 5_000 })
    assert.equal(fake.tokenCalls(), 2)

    fake.advance(5_000)
    assert.deepEqual(await fake.oauth.poll(), { state: 'authorized' })
    assert.equal(fake.oauth.pending(ORIGIN), undefined)
    assert.equal(await fake.restarted().sessionId(ORIGIN), 'client-1')
    assert.equal(await fake.restarted().sessionId('https://meegle.com'), null)
    assert.equal(await fake.restarted().token(ORIGIN), 'access-1')
  } finally {
    setFetch(null)
  }
})

test('an expired device grant is omitted from pending status', async () => {
  const fake = fakeOAuth(() => GRANTED)
  try {
    await fake.oauth.start(ORIGIN)
    fake.advance(30_000)
    assert.equal(fake.oauth.pending(ORIGIN), undefined)
    assert.equal(fake.tokenCalls(), 0)
  } finally {
    setFetch(null)
  }
})

test('worker status exposes only the current public device prompt until cancellation', async () => {
  const fake = fakeOAuth(() => GRANTED)
  const worker = await mountWorker(workerModule, { host: mockHost() })
  try {
    assert.equal((await worker.request('meego.status')).authorization, undefined)
    const start = await worker.request('meego.beginAuthorization')
    const pending = (await worker.request('meego.status')).authorization
    assert.ok(pending)
    assert.ok(pending!.intervalMs >= 0 && pending!.intervalMs <= start.intervalMs)
    assert.deepEqual(pending, { ...start, intervalMs: pending!.intervalMs })
    assert.equal(fake.registerCalls(), 1)
    assert.equal(fake.tokenCalls(), 0)
    await worker.request('meego.cancelAuthorization')
    assert.equal((await worker.request('meego.status')).authorization, undefined)
  } finally {
    await worker.deactivate()
    setFetch(null)
  }
})

test('refresh is shared, saves rotation, and clears a rejected grant', async () => {
  let refreshCalls = 0
  const fake = fakeOAuth((body) => {
    if (body.get('grant_type') !== 'refresh_token') return GRANTED
    refreshCalls += 1
    if (refreshCalls === 1) {
      assert.equal(body.get('refresh_token'), 'refresh-1')
      return { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 120 }
    }
    assert.equal(body.get('refresh_token'), 'refresh-2')
    return { error: 'invalid_grant' }
  })
  try {
    await fake.oauth.start(ORIGIN)
    fake.advance(5_000)
    await fake.oauth.poll()
    const tokens = await Promise.all([
      fake.oauth.token(ORIGIN, 'access-1'),
      fake.oauth.token(ORIGIN, 'access-1')
    ])
    assert.deepEqual(tokens, ['access-2', 'access-2'])
    assert.equal(refreshCalls, 1)
    assert.equal(await fake.restarted().token(ORIGIN, 'access-1'), 'access-2')
    assert.equal(await fake.oauth.sessionId(ORIGIN), 'client-1')
    fake.advance(120_000)
    await assert.rejects(() => fake.oauth.token(ORIGIN), /重新授权/)
    assert.equal(await fake.restarted().connected(ORIGIN), false)
  } finally {
    setFetch(null)
  }
})

test('disconnect discards a late device poll even if the response arrives after cancellation', async () => {
  let resolvePoll: (value: unknown) => void = () => undefined
  let entered: () => void = () => undefined
  const started = new Promise<void>((resolve) => { entered = resolve })
  const response = new Promise<unknown>((resolve) => { resolvePoll = resolve })
  const fake = fakeOAuth(() => {
    entered()
    return response
  })
  try {
    await fake.oauth.start(ORIGIN)
    fake.advance(5_000)
    const poll = fake.oauth.poll()
    await started
    await fake.oauth.disconnect()
    resolvePoll(GRANTED)
    assert.deepEqual(await poll, { state: 'expired' })
    assert.equal(await fake.oauth.connected(ORIGIN), false)
  } finally {
    setFetch(null)
  }
})

test('transient refresh failures preserve the current session and late refresh cannot reconnect it', async () => {
  let resolveRefresh: (value: unknown) => void = () => undefined
  let entered: () => void = () => undefined
  const started = new Promise<void>((resolve) => { entered = resolve })
  const response = new Promise<unknown>((resolve) => { resolveRefresh = resolve })
  let refreshCalls = 0
  const fake = fakeOAuth((body) => {
    if (body.get('grant_type') !== 'refresh_token') return GRANTED
    refreshCalls += 1
    if (refreshCalls === 1) throw new Error('Failure that contains refresh-1')
    entered()
    return response
  })
  try {
    await fake.oauth.start(ORIGIN)
    fake.advance(5_000)
    await fake.oauth.poll()
    await assert.rejects(() => fake.oauth.token(ORIGIN, 'access-1'), /^MeegoOAuthError: 无法访问飞书项目授权服务，请检查网络后重试。$/)
    assert.equal(await fake.oauth.sessionId(ORIGIN), 'client-1')

    const refresh = fake.oauth.token(ORIGIN, 'access-1')
    const rejected = assert.rejects(() => refresh, /重新授权/)
    await started
    await fake.oauth.disconnect()
    resolveRefresh({ access_token: 'access-2', refresh_token: 'refresh-2' })
    await rejected
    assert.equal(await fake.restarted().connected(ORIGIN), false)
  } finally {
    setFetch(null)
  }
})

test('a second unauthorized response clears only the exact token rejected by MCP', async () => {
  const fake = fakeOAuth((body) => body.get('grant_type') === 'refresh_token'
    ? { access_token: 'access-2', expires_in: 120 }
    : GRANTED)
  try {
    await fake.oauth.start(ORIGIN)
    fake.advance(5_000)
    await fake.oauth.poll()
    assert.equal(await fake.oauth.token(ORIGIN, 'access-1'), 'access-2')
    await fake.oauth.invalidate(ORIGIN, 'access-1')
    await fake.oauth.invalidate('https://meegle.com', 'access-2')
    assert.equal(await fake.oauth.token(ORIGIN), 'access-2')
    await fake.oauth.invalidate(ORIGIN, 'access-2')
    assert.equal(await fake.restarted().connected(ORIGIN), false)
  } finally {
    setFetch(null)
  }
})

test('OAuth uses only official origins and rejects cross-origin discovered endpoints', async () => {
  assert.equal(oauthOrigin('https://meegle.com'), 'https://project.larksuite.com')
  assert.equal(oauthOrigin('https://project.meegle.com'), 'https://project.larksuite.com')
  assert.equal(oauthOrigin('https://project.feishu.cn@unexpected.example'), null)
  assert.equal(oauthOrigin('https://project.feishu.cn:8443'), null)
  const fake = fakeOAuth(() => null)
  let calls = 0
  setFetch(async () => {
    calls += 1
    return reply({ ...METADATA, registration_endpoint: 'https://unexpected.example/register' })
  })
  try {
    await assert.rejects(() => fake.oauth.start('https://unexpected.example'), /检查飞书项目地址/)
    assert.equal(calls, 0)
    await assert.rejects(() => fake.oauth.start(ORIGIN), /无法识别的授权响应/)
    assert.equal(calls, 1)
  } finally {
    setFetch(null)
  }
})
