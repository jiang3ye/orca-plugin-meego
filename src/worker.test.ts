// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
// Network calls go through src/meego/fetch-provider so tests never touch the real Meego.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { doesNotMatch } from 'node:assert/strict'
import type { OrcaWorkerApi } from 'orca/worker'
import * as main from './worker'
import { MeegoApiError, MeegoClient, type FetchLike } from './meego/client'
import { setFetch } from './meego/fetch-provider'
import { buildWorkItemPrompt } from './meego/prompt'
import { clearWorkspaceLink, getWorkspaceLink, setWorkspaceLink } from './meego/links'
import { parseMeegoJson, parseWorkItemId, sameWorkItemId } from './meego/work-item-id'
import { buildWorkItemUrl, verifiedWorkItemUrl } from './meego/config'

const SETTINGS = {
  base_url: 'https://project.feishu.cn',
  project_key: 'demo',
  user_key: 'dev_user',
  agent_command: 'codex',
  web_url_template: 'https://project.feishu.cn/work_item/detail/{project_key}/{work_item_type_key}/{work_item_id}'
}

const WORK_ITEM = {
  id: 6801,
  name: '实现登录',
  work_item_type_key: 'story',
  project_key: 'demo',
  updated_at: 1767000000,
  owners: ['dev_user'],
  current_nodes: [{ current_node_status: { name: '开发中', state: 'in progress' } }],
  fields: [
    { field_key: 'priority', field_alias: '优先级', field_type_key: 'single_options', field_value: { label: 'P0' } },
    {
      field_key: 'description',
      field_alias: '描述',
      field_type_key: 'multi_text',
      field_value: [{ text: '支持手机号验证码登录' }]
    }
  ]
}

function jsonResponse(body: unknown): { ok: boolean; status: number; statusText: string; text(): Promise<string> } {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) }
}

/** A fetch stand-in that records requests and answers from a script of envelopes. */
function queuedFetch(responses: unknown[]): {
  fetch: FetchLike
  requests: { url: string; body: unknown; headers: Record<string, string> }[]
} {
  const requests: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null
    requests.push({ url: String(url), body, headers })
    const next = responses.shift()
    if (next === undefined) throw new Error(`unexpected extra request: ${String(url)}`)
    return jsonResponse(next)
  }
  return { fetch, requests }
}

/** Answers one full Meego pass (token, filter, user/query, types) with demo data. */
function demoFetch() {
  let tokenCalls = 0
  const fetch: FetchLike = async (url) => {
    const target = String(url)
    if (target.endsWith('/plugin_token')) {
      tokenCalls += 1
      return jsonResponse({ data: { token: `p-token-${tokenCalls}`, expire_time: 3600 }, error: { code: 0 } })
    }
    if (target.includes('/work_item/filter')) {
      return jsonResponse({ data: [WORK_ITEM], pagination: { total: 1 } })
    }
    if (target.includes('/user/query')) {
      return jsonResponse({ data: { dev_user: { name_cn: '张三' } } })
    }
    if (target.endsWith('/work_item/all-types')) {
      return jsonResponse({ data: [{ key: 'story', name: '需求' }, { key: 'task', name: '任务' }] })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  return { fetch, tokenCalls: () => tokenCalls }
}

const CONFIG = {
  baseUrl: 'https://project.feishu.cn',
  projectKey: 'demo',
  userKey: 'dev_user',
  pluginId: 'MII_DEMO',
  pluginSecret: 'demo-secret',
  agentCommand: 'codex',
  webUrlTemplate: SETTINGS.web_url_template
}

const WORKSPACES = {
  workspaces: [{ id: 'ws-1', kind: 'worktree', name: 'login-ws', path: '/repo/login', branch: 'feat/login', hostId: null }],
  truncated: false
}

test('caches the plugin token and sends the right headers', async () => {
  const { fetch, requests } = queuedFetch([
    { data: { token: 'p-token-1', expire_time: 3600 }, error: { code: 0 } },
    { data: [], pagination: { total: 0 } },
    { data: [], pagination: { total: 0 } }
  ])
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  await client.filterWorkItems({ typeKey: 'story', pageNum: 1, pageSize: 50 })
  await client.filterWorkItems({ typeKey: 'story', pageNum: 2, pageSize: 50 })
  const tokenCalls = requests.filter((request) => request.url.endsWith('/plugin_token'))
  assert.equal(tokenCalls.length, 1)
  assert.deepEqual(tokenCalls[0]?.body, { plugin_id: 'MII_DEMO', plugin_secret: 'demo-secret', type: 0 })
  const filter = requests.find((request) => request.url.includes('/work_item/filter'))
  assert.equal(filter?.headers['X-PLUGIN-TOKEN'], 'p-token-1')
  assert.equal(filter?.headers['X-USER-KEY'], 'dev_user')
})

test('maps Meego error codes to readable messages', async () => {
  const { fetch } = queuedFetch([
    { data: { token: 'p-token-1', expire_time: 3600 }, error: { code: 0 } },
    { error: { code: 10301, msg: 'Check Token Perm Failed' } }
  ])
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  await assert.rejects(() => client.workItemTypes(), /10301/)
})

test('legacy comments use the official work item object and paginate by cursor', async () => {
  const { fetch, requests } = queuedFetch([
    { data: { token: 'p-token-1', expire_time: 3600 }, err_code: 0 },
    { data: { comment_id: '9007199254741001' }, err_code: 0 },
    { data: { comments: [
      { comment_id: '9007199254741001', creator: 'dev_user', status: 'NORMAL', content: { rich_text: { markdown_content: { markdown: '**确认**' } }, create_time: 1794324000000 } },
      { comment_id: '2', status: 'DELETED' }
    ] }, next_cursor: 'page-next', err_code: 0 },
    { data: [{ user_key: 'dev_user', name_cn: '张三' }], err_code: 0 },
    { data: { comments: [] }, err_code: 0 }
  ])
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  await client.addComment('story', 6801, '**确认**')
  const page = await client.listComments('story', 6801)
  assert.deepEqual(page, {
    comments: [{ id: '9007199254741001', author: '张三', content: '**确认**', createdAt: 1794324000000 }],
    hasMore: true, nextCursor: 'page-next'
  })
  assert.deepEqual(await client.listComments('story', 6801, page.nextCursor), { comments: [], hasMore: false })
  const object = { type: 'WORKITEM', work_item_type_key: 'story', work_item_id: '6801' }
  assert.equal(requests[1]?.url, `${CONFIG.baseUrl}/open_api/comment/create`)
  assert.deepEqual(requests[1]?.body, { project_key: 'demo', object, content: { type: 'RICHTEXT', markdown: '**确认**' } })
  assert.equal(requests[4]?.url, `${CONFIG.baseUrl}/open_api/comment/query`)
  assert.deepEqual(requests[4]?.body, { project_key: 'demo', object, paginator: { direction: 'DESC', page_size: 20, cursor: 'page-next' }, need_rich_text_mark_down: true })
})

test('legacy HTTP 200 business errors fail writes and creation sends a Markdown description field', async () => {
  const { fetch, requests } = queuedFetch([
    { data: { token: 'p-token-1', expire_time: 3600 }, err_code: 0 },
    { err_code: 10001, err_msg: 'No Permission' },
    { err_code: 20038, err_msg: 'Required Field Is Not Set', err: { code: 20038, msg: 'priority required' } },
    { data: 6802, err_code: 0 }
  ])
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  await assert.rejects(() => client.addComment('story', 6801, '确认'), /10001.*No Permission/)
  await assert.rejects(() => client.createWorkItem({ typeKey: 'story', name: '发布检查' }), /20038.*priority required/)
  assert.equal(await client.createWorkItem({ typeKey: 'story', name: '发布检查', description: '## 步骤' }), 6802)
  assert.deepEqual(requests[3]?.body, {
    work_item_type_key: 'story', name: '发布检查', required_mode: 1,
    field_value_pairs: [{ field_key: 'description', field_value_markdown: { markdown: '## 步骤' } }]
  })
})

test('legacy HTTP 5xx on a write requires verification even with a business envelope', async () => {
  let writeCalls = 0
  const fetchImpl: FetchLike = async (url) => {
    if (String(url).endsWith('/plugin_token')) return jsonResponse({ data: { token: 'p-token-1', expire_time: 3600 } })
    writeCalls++
    return { ...jsonResponse({ err_code: 10203 }), ok: false, status: 503, statusText: 'Service Unavailable' }
  }
  const client = new MeegoClient({ config: CONFIG, fetchImpl })
  const outcome = await client.addComment('story', 6801, '确认').catch((error: unknown) => error)
  assert.equal(outcome instanceof MeegoApiError && outcome.code, 'WRITE_UNVERIFIED')
  assert.equal(writeCalls, 1)
})

test('worker returns bridge-safe results for uncertain writes', async () => {
  const writes: string[] = []
  setFetch(async (url) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/plugin_token')) return jsonResponse({ data: { token: 'p-token-1', expire_time: 3600 } })
    writes.push(path)
    if (path === '/open_api/comment/create') throw new Error('response disconnected')
    return jsonResponse({ data: {}, err_code: 0 })
  })
  const host = mockHost({ settings: SETTINGS, secrets: { meego_plugin_id: 'MII_DEMO', meego_plugin_secret: 'demo-secret' } })
  const worker = await mountWorker(main, { host })
  try {
    assert.deepEqual(await worker.request('meego.addComment', { id: 6801, typeKey: 'story', content: '确认' }), { state: 'unverified' })
    assert.deepEqual(await worker.request('meego.createWorkItem', { typeKey: 'story', name: '发布检查' }), { state: 'unverified' })
    assert.deepEqual(writes, ['/open_api/comment/create', '/open_api/demo/work_item/create'])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})

test('legacy template and required fields are validated before native value serialization', async () => {
  const metadata = [
    { field_key: 'template', field_type_key: 'work_item_template', options: [{ value: '20', label: '发布' }, { value: '21', label: '日常' }] },
    { field_key: 'priority', field_name: '优先级', field_type_key: 'select', is_required: 1, options: [{ value: 'p1', label: '高' }] },
    { field_key: 'points', field_name: '点数', field_type_key: 'number', is_required: 1 },
    { field_key: 'confirmed', field_name: '已确认', field_type_key: 'bool', is_required: 1 }
  ]
  const { fetch, requests } = queuedFetch([
    { data: { token: 'p-token-1', expire_time: 3600 }, err_code: 0 },
    { data: metadata, err_code: 0 },
    { data: metadata, err_code: 0 },
    { data: metadata, err_code: 0 },
    { data: 6803, err_code: 0 }
  ])
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  const form = await client.createForm('story')
  assert.deepEqual(form.templates, [{ id: '20', name: '发布' }, { id: '21', name: '日常' }])
  const draft = { typeKey: 'story', name: '验收', templateId: '21', fieldValues: { priority: 'p1', points: '1.5', confirmed: 'false' } }
  await assert.rejects(() => client.createWorkItem({ ...draft, templateId: '99' }), /选择.*模板/)
  assert.equal(await client.createWorkItem(draft), 6803)
  assert.equal(requests[1]?.url, `${CONFIG.baseUrl}/open_api/demo/work_item/story/meta`)
  assert.deepEqual(requests[4]?.body, {
    work_item_type_key: 'story', name: '验收', required_mode: 1, template_id: 21,
    field_value_pairs: [
      { field_key: 'priority', field_value: { value: 'p1' } },
      { field_key: 'points', field_value: 1.5 },
      { field_key: 'confirmed', field_value: false }
    ]
  })
})

test('normalizes work items (status, owners, description, url)', async () => {
  const { fetch } = queuedFetch([
    { data: { token: 'p-token-1', expire_time: 3600 }, error: { code: 0 } },
    { data: [WORK_ITEM], pagination: { total: 101 } }
  ])
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  const result = await client.filterWorkItems({ typeKey: 'story', pageNum: 1, pageSize: 50, needMultiText: true })
  assert.equal(result.total, 101)
  const item = result.items[0]
  assert.equal(item?.status, '开发中')
  assert.equal(item?.statusState, 'in_progress')
  assert.deepEqual(item?.ownerKeys, ['dev_user'])
  assert.equal(item?.description, '支持手机号验证码登录')
})

test('preserves positive int64 IDs while leaving other JSON tokens intact', () => {
  assert.deepEqual(parseMeegoJson('{"a":9007199254740992,"b":9007199254740993,"note":"\\\"9007199254740995\\\"","n":1.0000000000000001}'), {
    a: '9007199254740992', b: '9007199254740993', note: '"9007199254740995"', n: 1
  })
  assert.throws(() => parseMeegoJson('{9007199254740993:1}'))
  assert.equal(parseWorkItemId('9223372036854775807'), '9223372036854775807')
  assert.equal(parseWorkItemId('9223372036854775808'), null)
  assert.equal(parseWorkItemId(Number('9007199254740993')), null)
  assert.equal(sameWorkItemId('0006801', 6801), true)
  assert.equal(sameWorkItemId('9007199254740992', '9007199254740993'), false)
})

test('builds HTTPS links for the active region and verifies the linked work item', () => {
  const item = { id: '9007199254740993', typeKey: 'story' }
  const international = { ...CONFIG, baseUrl: 'https://project.larksuite.com' }
  assert.equal(buildWorkItemUrl(international, item), 'https://project.larksuite.com/work_item/detail/demo/story/9007199254740993')
  assert.equal(buildWorkItemUrl({ ...CONFIG, webUrlTemplate: 'http://unsafe.example/{work_item_id}' }, item), '')
  assert.equal(buildWorkItemUrl({ ...CONFIG, webUrlTemplate: 'https://u:p@unsafe.example/{work_item_id}' }, item), '')
  assert.equal(buildWorkItemUrl({ ...CONFIG, webUrlTemplate: 'https://projects.example/{work_item_id}' }, item), 'https://projects.example/9007199254740993')
  const source = { ...CONFIG, spaceSlug: 'team' }
  assert.equal(verifiedWorkItemUrl(`${CONFIG.baseUrl}/team/story/detail/9007199254740992`, source, item), null)
  assert.equal(verifiedWorkItemUrl(`${CONFIG.baseUrl}/elsewhere/story/detail/${item.id}`, source, item), null)
  assert.equal(verifiedWorkItemUrl(`${CONFIG.baseUrl}/redirect?work_item_id=${item.id}`, source, item), null)
  assert.equal(verifiedWorkItemUrl(`${CONFIG.baseUrl}/team/_story_resource/detail/${item.id}?scope=abc`, source, item), `${CONFIG.baseUrl}/team/_story_resource/detail/${item.id}`)
})

test('legacy filters send wide IDs as exact int64 literals and read them back without rounding', async () => {
  const ids = ['9007199254740992', '9007199254740993']
  const fetch: FetchLike = async (url, init) => {
    if (url.endsWith('/plugin_token')) return jsonResponse({ data: { token: 'p-token', expire_time: 3600 }, err_code: 0 })
    assert.match(String(init?.body), /"work_item_ids":\[9007199254740992,9007199254740993\]/)
    return {
      ok: true, status: 200, statusText: 'OK',
      text: async () => '{"data":[{"id":9007199254740992,"name":"A"},{"id":9007199254740993,"name":"B"}],"err_code":0}'
    }
  }
  const client = new MeegoClient({ config: CONFIG, fetchImpl: fetch })
  const { items } = await client.filterWorkItems({ typeKey: 'story', pageNum: 1, pageSize: 50, workItemIds: ids })
  assert.deepEqual(items.map(({ id }) => id), ids)
})

test('builds an agent prompt with title, status, url and truncation', () => {
  const prompt = buildWorkItemPrompt({
    id: 6801,
    typeKey: 'story',
    name: '实现登录',
    status: '开发中',
    statusState: 'in_progress',
    ownerKeys: ['dev_user'],
    ownerNames: ['张三'],
    updatedAt: 1767000000000,
    url: 'https://project.feishu.cn/work_item/detail/demo/story/6801',
    description: '支持手机号验证码登录',
    fields: []
  })
  assert.match(prompt, /【Meego 工作项】#6801 实现登录/)
  assert.match(prompt, /状态：开发中/)
  assert.match(prompt, /负责人：张三/)
  assert.match(prompt, /https:\/\/project\.feishu\.cn\/work_item\/detail\/demo\/story\/6801/)
  assert.match(prompt, /支持手机号验证码登录/)

  const long = 'x'.repeat(4000)
  const truncated = buildWorkItemPrompt({
    id: 1, typeKey: 'story', name: 'n', status: '', statusState: 'unknown',
    ownerKeys: [], ownerNames: [], updatedAt: null, url: 'https://example.com', description: long, fields: []
  })
  assert.match(truncated, /已截断/)
})

test('workspace links round-trip through storage', async () => {
  const store = new Map<string, unknown>()
  const orca = {
    storage: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      keys: async () => [...store.keys()],
      onDidChange: () => ({ dispose() {} })
    }
  } as unknown as OrcaWorkerApi

  assert.equal(await getWorkspaceLink(orca, 'ws-1'), null)
  await setWorkspaceLink(orca, 'ws-1', {
    workItemId: 6801, typeKey: 'story', name: '实现登录', status: '开发中',
    branch: 'feat/login', linkedAt: 1, url: 'https://example.com/6801'
  })
  assert.equal((await getWorkspaceLink(orca, 'ws-1'))?.workItemId, 6801)
  assert.equal(await getWorkspaceLink(orca, 'ws-2'), null)
  await clearWorkspaceLink(orca, 'ws-1')
  assert.equal(await getWorkspaceLink(orca, 'ws-1'), null)
})

test('status reports what is missing until credentials exist', async () => {
  const host = mockHost({ settings: SETTINGS })
  const worker = await mountWorker(main, { host })
  const before = await worker.request('meego.status')
  assert.equal(before.configured, false)
  assert.deepEqual(before.missing.map((item) => item.key), ['meego_plugin_id', 'meego_plugin_secret'])
  await worker.request('meego.saveCredentials', { pluginId: 'MII_DEMO', pluginSecret: 'demo-secret' })
  const after = await worker.request('meego.status')
  assert.equal(after.configured, true)
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('listWorkItems caches page 1 and refetches on force; testConnection passes', async () => {
  const { fetch, tokenCalls } = demoFetch()
  setFetch(fetch)
  const host = mockHost({ settings: SETTINGS, secrets: { meego_plugin_id: 'MII_DEMO', meego_plugin_secret: 'demo-secret' } })
  const worker = await mountWorker(main, { host })
  try {
    const first = await worker.request('meego.listWorkItems', { typeKey: 'story' })
    assert.equal(first.fromCache, false)
    assert.equal(first.items[0]?.name, '实现登录')
    assert.deepEqual(first.items[0]?.ownerNames, ['张三'])
    const second = await worker.request('meego.listWorkItems', { typeKey: 'story' })
    assert.equal(second.fromCache, true)
    const forced = await worker.request('meego.listWorkItems', { typeKey: 'story', force: true })
    assert.equal(forced.fromCache, false)
    const connection = await worker.request('meego.testConnection')
    assert.equal(connection.ok, true)
    assert.equal(connection.typeCount, 2)
    assert.ok(tokenCalls() >= 1)
    assert.deepEqual(worker.refusals, [])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})

test('sendToAgent verifies the workspace and uses its running agent terminal', async () => {
  const { fetch } = demoFetch()
  setFetch(fetch)
  const host = mockHost({
    settings: SETTINGS,
    secrets: { meego_plugin_id: 'MII_DEMO', meego_plugin_secret: 'demo-secret' },
    results: {
      'workspace.readContext': { branch: 'feat/login', displayName: 'login-ws', terminals: [{ id: 'term-1' }] },
      'workspace.list': WORKSPACES,
      'agents.list': { agents: [{ terminalId: 'term-1', title: 'Claude', agent: 'claude', state: 'working', stateStartedAt: 1 }] },
      'terminal.sendText': { accepted: true },
      'notifications.show': { delivered: true }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    const result = await worker.request('meego.sendToAgent', { id: 6801, typeKey: 'story' })
    assert.equal(result.sent, true)
    assert.match(result.detail, /请在终端核对后提交/)
    const sends = host.callsOf('terminal.sendText')
    assert.equal(sends.length, 1)
    const params = sends[0] as { terminalId: string; text: string; enter: boolean }
    assert.equal(params.terminalId, 'term-1')
    assert.equal(params.enter, false)
    doesNotMatch(params.text, /[\r\n]/)
    assert.match(params.text, /【Meego 工作项】#6801 实现登录/)
    assert.deepEqual(worker.refusals, [])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})

test('explicitly starting an agent never drafts to an agent that appeared after confirmation', async () => {
  const { fetch } = demoFetch()
  setFetch(fetch)
  const host = mockHost({
    settings: SETTINGS,
    secrets: { meego_plugin_id: 'MII_DEMO', meego_plugin_secret: 'demo-secret' },
    results: {
      'workspace.readContext': { branch: 'feat/login', displayName: 'login-ws', terminals: [{ id: 'term-1' }] },
      'agents.list': { agents: [{ terminalId: 'term-1', title: 'Other Agent', agent: 'codex', state: 'working', stateStartedAt: 1 }] },
      'workspace.list': WORKSPACES,
      'agent.launch': { terminalId: 'term-2' }
    }
  })
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    const call = orca.host.call.bind(orca.host)
    const wrapped = { ...orca, host: { ...orca.host, call: (async (method: Parameters<typeof call>[0], params?: Parameters<typeof call>[1]) => {
      if (method === 'agents.available') return { agents: [{ id: 'codex', label: 'Codex' }] }
      return call(method, params)
    }) as typeof orca.host.call } }
    main.default(wrapped)
  } }, { host })
  try {
    await assert.rejects(() => worker.request('meego.sendToAgent', { id: 6801, typeKey: 'story', workspaceId: 'ws-1', terminalId: null }), /请选择此次启动/)
    await assert.rejects(() => worker.request('meego.sendToAgent', { id: 6801, typeKey: 'story', workspaceId: 'ws-1', terminalId: null, agent: 'claude' }), /所选 Agent 已不可用/)
    assert.deepEqual(host.callsOf('agent.launch'), [])
    const result = await worker.request('meego.sendToAgent', { id: 6801, typeKey: 'story', workspaceId: 'ws-1', terminalId: null, agent: 'codex' })
    assert.equal(result.sent, true)
    const launches = host.callsOf('agent.launch')
    assert.equal(launches.length, 1)
    const params = launches[0] as { workspaceId: string; agent: string; prompt: string }
    assert.equal(params.workspaceId, 'ws-1')
    assert.equal(params.agent, 'codex')
    assert.match(params.prompt, /实现登录/)
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})

test('command and omitted-terminal handoffs require an explicit Agent choice when no existing terminal is available', async () => {
  const { fetch } = demoFetch()
  setFetch(fetch)
  const host = mockHost({
    settings: SETTINGS,
    secrets: { meego_plugin_id: 'MII_DEMO', meego_plugin_secret: 'demo-secret' },
    storage: { 'meego.workspaceLinks': { 'ws-1': {
      workItemId: 6801, typeKey: 'story', name: '实现登录', status: '开发中',
      branch: 'feat/login', linkedAt: 1, accountKey: 'dev_user',
      source: { baseUrl: SETTINGS.base_url, projectKey: SETTINGS.project_key },
      url: 'https://project.feishu.cn/demo/story/detail/6801'
    } } },
    results: {
      'workspace.readContext': { branch: 'feat/login', displayName: 'login-ws', terminals: [] },
      'workspace.list': WORKSPACES,
      'agents.list': { agents: [] }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    await assert.rejects(() => worker.request('meego.sendToAgent', { id: 6801, typeKey: 'story' }), /请在 Meego 面板选择本次启动的 Agent/)
    await assert.rejects(() => worker.command('meego.sendToAgent'), /请在 Meego 面板选择本次启动的 Agent/)
    assert.deepEqual(host.callsOf('agent.launch'), [])
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
    assert.deepEqual(worker.refusals, [])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})

test('handoff rejects a changed workspace or a terminal from another workspace', async () => {
  const { fetch } = demoFetch()
  setFetch(fetch)
  const host = mockHost({
    settings: SETTINGS,
    secrets: { meego_plugin_id: 'MII_DEMO', meego_plugin_secret: 'demo-secret' },
    results: {
      'workspace.readContext': { branch: 'feat/login', displayName: 'login-ws', terminals: [{ id: 'local-terminal' }] },
      'workspace.list': WORKSPACES,
      'agents.list': { agents: [{ terminalId: 'other-terminal', title: 'Another Agent', agent: 'codex', state: 'working', stateStartedAt: 1 }] }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    const input = { id: 6801, typeKey: 'story' }
    await assert.rejects(() => worker.request('meego.sendToAgent', { ...input, workspaceId: 'other-workspace' }), /工作区已切换/)
    await assert.rejects(() => worker.request('meego.sendToAgent', { ...input, workspaceId: 'ws-1', terminalId: 'other-terminal' }), /所选 Agent/)
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
    assert.deepEqual(host.callsOf('agent.launch'), [])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})

test('worker keeps caches by space and resolves a pasted link using the authorized source space', async () => {
  const baseUrl = SETTINGS.base_url
  const user = { key: 'meego-user', name: '开发者' }
  const demo = { key: 'demo-key', name: '研发空间', slug: 'demo' }
  const another = { key: 'another-key', name: '另一空间', slug: 'another' }
  const wideId = '9007199254740993'
  const calls: { name: string; project?: string }[] = []
  const payload = (space: typeof demo) => ({ project_key: space.key, project_name: space.name, simple_name: space.slug })
  setFetch(async (url, init) => {
    assert.equal(url, `${baseUrl}/mcp_server/v1`)
    const request = JSON.parse(String(init?.body))
    const { name, arguments: args } = request.params
    calls.push({ name, project: args.project_key })
    let data: unknown
    if (name === 'search_project_info') data = { list: [payload(demo), payload(another)] }
    else if (name === 'list_workitem_types') data = [{ type_key: 'story', name: args.project_key }]
    else if (name === 'get_workitem_brief') data = { work_item_attribute: { work_item_id: args.work_item_id, name: '目标工作项', work_item_type_key: 'story', project_key: args.project_key } }
    else if (name === 'add_comment') data = { ok: true }
    else throw new Error(`Unexpected MCP tool: ${name}`)
    return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } })
  })
  const host = mockHost({
    settings: SETTINGS,
    secrets: { meego_oauth_session: JSON.stringify({ origin: baseUrl, clientId: 'client', accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.now() + 100_000 }) },
    storage: {
      'meego.account': { baseUrl, sessionId: 'client', user, space: demo },
      'meego.workspaceLinks': {
        'ws-1': { workItemId: 6801, typeKey: 'story', name: '旧账号工作项', status: '进行中', branch: 'feat/login', linkedAt: 1, url: `${baseUrl}/demo/story/detail/6801`, source: { baseUrl, projectKey: demo.key }, accountKey: 'old-user' }
      }
    },
    results: {
      'workspace.readContext': { branch: 'feat/login', displayName: 'login-ws', terminals: [{ id: 'ready-agent' }] },
      'workspace.list': WORKSPACES,
      'agents.list': { agents: [{ terminalId: 'ready-agent', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] },
      'terminal.sendText': { accepted: true }
    }
  })
  const worker = await mountWorker(main, { host })
  try {
    assert.equal((await worker.request('meego.listTypes')).types[0]?.name, demo.key)
    await worker.request('meego.listSpaces', {})
    await worker.request('meego.selectSpace', { key: another.key })
    assert.equal((await worker.request('meego.listTypes')).types[0]?.name, another.key)
    assert.equal((await worker.request('meego.workspaceContext')).link, null)
    await assert.rejects(() => worker.request('meego.sendToAgent', { id: 6801, typeKey: 'story', linked: true }), /无法确认关联来源/)
    await assert.rejects(() => worker.request('meego.unlinkWorkspace', { workspaceId: 'ws-1', expectedLinkedAt: 1 }), /无法解除这条关联/)
    const { item } = await worker.request('meego.openWorkItemLink', { url: `${baseUrl}/demo/_story_resource/detail/${wideId}?scope=abc` })
    assert.equal(item.url, `${baseUrl}/demo/_story_resource/detail/${wideId}`)
    assert.equal(item.id, wideId)
    assert.equal(item.spaceName, demo.name)
    assert.deepEqual(item.source, { baseUrl, projectKey: demo.key })
    const priorCalls = calls.length
    await assert.rejects(() => worker.request('meego.addComment', { id: item.id, typeKey: item.typeKey, source: item.source, expectedUserKey: 'old-user', content: '收到' }), /连接状态已变化/)
    assert.equal(calls.length, priorCalls)
    await worker.request('meego.addComment', { id: item.id, typeKey: item.typeKey, source: item.source, content: '收到' })
    assert.deepEqual(calls.at(-1), { name: 'add_comment', project: demo.key })
    await worker.request('meego.linkWorkspace', { workItemId: item.id, typeKey: item.typeKey, name: item.name, source: item.source, url: item.url, expectedLinkedAt: null })
    const link = (await worker.request('meego.workspaceContext')).link
    assert.equal(link?.workItemId, wideId)
    await worker.request('meego.sendToAgent', { id: wideId, typeKey: item.typeKey, linked: true, expectedLinkedAt: link?.linkedAt })
    assert.match(String((host.callsOf('terminal.sendText')[0] as { text: string }).text), /#9007199254740993/)
    assert.match(String((host.callsOf('terminal.sendText')[0] as { text: string }).text), /_story_resource\/detail\/9007199254740993/)
    assert.equal((await worker.request('meego.status')).projectKey, another.key)
    await worker.request('meego.disconnect')
    await assert.rejects(() => worker.request('meego.listTypes'), /授权已断开/)
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})
