import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import * as main from '../worker'
import { MeegoConnection, RequestError } from './connection'
import { setFetch } from './fetch-provider'
import type { FetchLike } from './client'

const baseUrl = 'https://project.feishu.cn'
const settings = { base_url: baseUrl, project_key: 'project-a', user_key: 'member-a', web_url_template: 'https://project.feishu.cn/custom/{work_item_id}' }
const session = { origin: baseUrl, clientId: 'client-a', accessToken: 'oauth-access', refreshToken: 'oauth-refresh', expiresAt: Date.now() + 60_000 }
const account = { baseUrl, sessionId: 'client-a', user: { key: 'member-a', name: 'Member A' }, space: { key: 'project-a', name: 'Project A' } }

function reply(value: unknown): Awaited<ReturnType<FetchLike>> {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(value) }
}

async function driver(host: MockHost, adapt: (api: OrcaWorkerApi) => OrcaWorkerApi = (api) => api) {
  let connection!: MeegoConnection
  const worker = await mountWorker({ default(api: OrcaWorkerApi) { connection = new MeegoConnection(adapt(api)) } }, { host })
  return { connection, stop: () => worker.deactivate() }
}

test('removing a connection clears its credentials and configuration without deleting workspace records, and is repeatable', async () => {
  setFetch(async () => { throw new Error('Removal must not contact the provider') })
  const host = mockHost({
    settings,
    secrets: {
      meego_oauth_session: JSON.stringify(session),
      meego_plugin_id: 'legacy-id', meego_plugin_secret: 'legacy-secret',
      meego_plugin_credentials: JSON.stringify({ baseUrl, pluginId: 'app-id', pluginSecret: 'app-secret' })
    },
    storage: { 'meego.account': account, 'meego.workspaceLinks': { workspace: { accountKey: 'member-a' } }, 'meego.workspaceCreation.v1.fixture': { state: 'uncertain' }, 'meego.viewMode': 'table' }
  })
  const worker = await mountWorker(main, { host })
  try {
    await worker.request('meego.removeConnection')
    assert.deepEqual(host.data().secrets, {})
    assert.deepEqual(host.data().settings, { base_url: 'https://project.feishu.cn', project_key: '', user_key: '', web_url_template: 'https://project.feishu.cn/work_item/detail/{project_key}/{work_item_type_key}/{work_item_id}' })
    assert.deepEqual(host.data().storage, { 'meego.workspaceLinks': { workspace: { accountKey: 'member-a' } }, 'meego.workspaceCreation.v1.fixture': { state: 'uncertain' }, 'meego.viewMode': 'table' })
    assert.equal((await worker.request('meego.status')).configured, false)
    await assert.rejects(() => worker.request('meego.listTypes'), /请先连接/)
    await worker.request('meego.removeConnection')
    assert.deepEqual(host.data().secrets, {})
    assert.equal(host.data().storage['meego.account'], undefined)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    setFetch(null)
  }
})

test('enterprise disconnect stops business access while keeping preferences and requires an explicit verified reconnect', async () => {
  const credentials = JSON.stringify({ baseUrl, pluginId: 'app-id', pluginSecret: 'app-secret' })
  setFetch(async (url) => {
    if (url.endsWith('/open_api/authen/plugin_token')) return reply({ data: { token: 'enterprise-token', expire_time: 7200 } })
    if (url.endsWith('/open_api/project-a/work_item/all-types')) return reply({ data: [] })
    throw new Error(`Unexpected provider request: ${url}`)
  })
  const host = mockHost({ settings, secrets: { meego_plugin_credentials: credentials } })
  const worker = await mountWorker(main, { host })
  try {
    assert.equal((await worker.request('meego.status')).configured, true)
    await worker.request('meego.disconnect')
    assert.equal((await worker.request('meego.status')).configured, false)
    await assert.rejects(() => worker.request('meego.listTypes'), /授权已断开/)
    assert.equal(host.data().secrets.meego_plugin_credentials, credentials)
    assert.equal(host.data().settings.project_key, 'project-a')
    await worker.request('meego.testConnection')
    assert.equal((await worker.request('meego.status')).configured, true)
    assert.equal(host.data().secrets.meego_plugin_credentials, credentials)
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
    setFetch(null)
  }
})

test('failed removal blocks residual OAuth and enterprise credentials after restart and can be retried', async () => {
  const host = mockHost({ settings, secrets: { meego_oauth_session: JSON.stringify(session), meego_plugin_credentials: JSON.stringify({ baseUrl, pluginId: 'app-id', pluginSecret: 'app-secret' }) }, storage: { 'meego.account': account } })
  const first = await driver(host, (api) => ({ ...api, secrets: { ...api.secrets, delete: async (key) => {
    if (key === 'meego_oauth_session') throw new Error('Credential store unavailable')
    await api.secrets.delete(key)
  } } }))
  await assert.rejects(() => first.connection.remove(), /无法更新本机/)
  await first.stop()
  const restarted = await driver(host)
  try {
    const status = await restarted.connection.status()
    assert.equal(status.configured, false)
    assert.equal(status.connection?.removalPending, true)
    await assert.rejects(() => restarted.connection.project(), /连接状态已变化/)
    const cleanupRequired = (error: unknown) => error instanceof RequestError && error.code === 'connection_cleanup_required'
    await assert.rejects(() => restarted.connection.begin(), cleanupRequired)
    await assert.rejects(() => restarted.connection.saveCredentials('new-id', 'new-secret'), cleanupRequired)
    await assert.rejects(() => restarted.connection.legacyProject(), cleanupRequired)
    await restarted.connection.remove()
    assert.deepEqual(host.data().secrets, {})
    assert.equal(host.data().storage['meego.account'], undefined)
    assert.equal((await restarted.connection.status()).hasSavedConnection, false)
  } finally {
    await restarted.stop()
  }
})

test('removal recovery status stays available when the credential store cannot be read', async () => {
  setFetch(async () => { throw new Error('Recovery status must not contact the provider') })
  const host = mockHost({ storage: { 'meego.account': { mode: 'removing' } } })
  const state = await driver(host, (api) => ({ ...api, secrets: { ...api.secrets, get: async () => {
    throw new Error('Credential store unavailable')
  } } }))
  try {
    assert.deepEqual(await state.connection.status(), {
      configured: false,
      baseUrl: 'https://project.feishu.cn',
      projectKey: '',
      userKey: '',
      missing: [],
      hasSavedConnection: true,
      connection: { state: 'disconnected', removalPending: true }
    })
    await assert.rejects(() => state.connection.project(), (error: unknown) => error instanceof RequestError && error.code === 'consent_required')
  } finally {
    await state.stop()
    setFetch(null)
  }
})

test('pending removal rejects another frame reconnecting until cleanup finishes', async () => {
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const deleting = new Promise<void>((resolve) => { started = resolve })
  const host = mockHost({ settings, secrets: { meego_plugin_credentials: JSON.stringify({ baseUrl, pluginId: 'old-id', pluginSecret: 'old-secret' }) } })
  const state = await driver(host, (api) => ({ ...api, secrets: { ...api.secrets, delete: async (key) => {
    if (key === 'meego_oauth_session') { started(); await waiting }
    await api.secrets.delete(key)
  } } }))
  try {
    const { config } = await state.connection.legacyProject()
    const removing = state.connection.remove()
    await deleting
    const busy = (error: unknown) => error instanceof RequestError && error.code === 'connection_busy'
    await assert.rejects(() => state.connection.begin(), busy)
    await assert.rejects(() => state.connection.saveCredentials('new-id', 'new-secret'), busy)
    await assert.rejects(() => state.connection.legacyProject(), busy)
    await assert.rejects(() => state.connection.useLegacy(config), busy)
    release()
    await removing
    await state.connection.saveCredentials('new-id', 'new-secret')
    assert.deepEqual(JSON.parse(String(host.data().secrets.meego_plugin_credentials)), { baseUrl: 'https://project.feishu.cn', pluginId: 'new-id', pluginSecret: 'new-secret' })
    assert.equal(host.data().storage['meego.account'], undefined)
  } finally {
    release()
    await state.stop()
  }
})

test('a late account lookup cannot restore the removed account', async () => {
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const requested = new Promise<void>((resolve) => { started = resolve })
  setFetch(async (url, init) => {
    assert.equal(url, `${baseUrl}/mcp_server/v1`)
    const request = JSON.parse(String(init?.body))
    assert.equal(request.params.name, 'search_user_info')
    started()
    await waiting
    return reply({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify([{ user_key: 'member-a', name: 'Member A' }]) }] } })
  })
  const host = mockHost({ settings, secrets: { meego_oauth_session: JSON.stringify(session) } })
  const test = await driver(host)
  try {
    const lookup = assert.rejects(() => test.connection.status(), /连接状态已变化/)
    await requested
    await test.connection.remove()
    release()
    await lookup
    assert.equal(host.data().storage['meego.account'], undefined)
    assert.deepEqual(host.data().secrets, {})
  } finally {
    release()
    await test.stop()
    setFetch(null)
  }
})

test('a late refresh cannot restore credentials after connection removal', async () => {
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const requested = new Promise<void>((resolve) => { started = resolve })
  setFetch(async (url) => {
    if (url.endsWith('/.well-known/oauth-authorization-server')) return reply({ issuer: baseUrl, authorization_endpoint: `${baseUrl}/b/auth/mcp`, registration_endpoint: `${baseUrl}/register`, device_authorization_endpoint: `${baseUrl}/device`, token_endpoint: `${baseUrl}/token` })
    assert.equal(url, `${baseUrl}/token`)
    started()
    await waiting
    return reply({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 60 })
  })
  const host = mockHost({ settings, secrets: { meego_oauth_session: JSON.stringify({ ...session, expiresAt: 1 }) }, storage: { 'meego.account': account } })
  const test = await driver(host)
  try {
    const { client } = await test.connection.project()
    const read = assert.rejects(() => client.workItemTypes(), /重新授权/)
    await requested
    await test.connection.remove()
    release()
    await read
    assert.deepEqual(host.data().secrets, {})
    assert.equal(host.data().storage['meego.account'], undefined)
  } finally {
    release()
    await test.stop()
    setFetch(null)
  }
})

test('a late authorization result cannot recreate the removed connection marker', async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const host = mockHost()
  const test = await driver(host)
  test.connection.oauth.poll = async () => { await waiting; return { state: 'authorized' } }
  try {
    const polling = test.connection.poll()
    await test.connection.remove()
    release()
    assert.deepEqual(await polling, { state: 'expired' })
    assert.equal(host.data().storage['meego.account'], undefined)
    assert.deepEqual(host.data().secrets, {})
  } finally {
    release()
    await test.stop()
  }
})
