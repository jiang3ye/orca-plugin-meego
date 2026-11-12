// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
// The mock host stands in for src/worker.ts: each entry answers one plugin.request.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ListWorkItemsInput, MeegoStatus, WorkspaceContextInfo, WorkspaceLink } from './protocol'

const NOW = Date.now()

const STATUS_UNCONFIGURED: MeegoStatus = {
  configured: false,
  baseUrl: 'https://project.feishu.cn',
  projectKey: '',
  userKey: '',
  missing: [
    { key: 'meego_plugin_id', label: 'Plugin ID' },
    { key: 'meego_plugin_secret', label: 'Plugin Secret' },
    { key: 'project_key', label: 'Project Key' },
    { key: 'user_key', label: 'User Key' }
  ]
}

const STATUS_CONFIGURED: MeegoStatus = {
  configured: true,
  baseUrl: 'https://project.feishu.cn',
  projectKey: 'demo',
  userKey: 'dev_user',
  missing: []
}

const TYPES = [{ key: 'story', name: '需求' }, { key: 'task', name: '任务' }]

const ITEMS = [
  {
    id: 6801,
    typeKey: 'story',
    name: '实现登录',
    status: '开发中',
    statusState: 'in_progress' as const,
    ownerKeys: ['dev_user'],
    ownerNames: ['张三'],
    updatedAt: NOW - 60_000
  },
  {
    id: 6802,
    typeKey: 'story',
    name: '修复登出死循环',
    status: '已完成',
    statusState: 'done' as const,
    ownerKeys: [],
    ownerNames: [],
    updatedAt: null
  }
]

const DETAIL = {
  ...ITEMS[0],
  url: 'https://project.feishu.cn/work_item/detail/demo/story/6801',
  description: '支持手机号验证码登录',
  fields: [{ label: '优先级', value: 'P0' }]
}

const CONTEXT_NO_WORKSPACE: WorkspaceContextInfo = {
  workspaceId: null,
  displayName: null,
  branch: null,
  link: null,
  branchChanged: false,
  agents: []
}

const LINK = {
  workItemId: 6801,
  typeKey: 'story',
  name: '实现登录',
  status: '开发中',
  branch: 'main',
  linkedAt: NOW,
  url: 'https://project.feishu.cn/work_item/detail/demo/story/6801'
}

const CONTEXT_LINKED: WorkspaceContextInfo = {
  workspaceId: 'ws-1',
  displayName: 'login-ws',
  branch: 'feat/login',
  link: LINK,
  branchChanged: true,
  agents: []
}
const WORKSPACE = { id: 'ws-1', kind: 'worktree' as const, name: 'login-ws', project: 'Demo', path: '/code/demo', branch: 'feat/login', hostId: 'local' }

function baseRequests(overrides: Record<string, (input: never) => unknown>): Record<string, (input: never) => unknown> {
  return {
    'meego.listTypes': () => ({ types: TYPES }),
    'meego.listWorkItems': () => ({ items: ITEMS, total: ITEMS.length, page: 1, hasMore: false, fromCache: false }),
    'meego.workspaceContext': () => CONTEXT_NO_WORKSPACE,
    'meego.workspaceOptions': () => ({ workspaces: [WORKSPACE], truncated: false, activeWorkspaceId: null }),
    'meego.agentChoices': () => ({ agents: [{ id: 'claude', label: 'Claude Code' }], defaultAgent: 'claude' }),
    'meego.createForm': () => ({ form: { templates: [{ id: 'standard', name: '标准模板' }], fields: [], unsupportedRequired: [] } }),
    ...overrides
  }
}

test('removing the connection clears the sidebar business list and open detail', async () => {
  let connected = true
  const host = mockHost({ requests: baseRequests({
    'meego.status': () => connected ? STATUS_CONFIGURED : { ...STATUS_UNCONFIGURED, hasSavedConnection: false },
    'meego.getWorkItem': () => ({ item: DETAIL })
  }) })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.activateRow({ label: '工作项列表' }, '6801')
    assert.notEqual(view.find({ text: '#6801 实现登录' }), null)
    connected = false
    await view.post('meego.connectionChanged', { reason: 'removed' })
    assert.equal(view.find({ label: '工作项列表' }), null)
    assert.equal(view.find({ text: '#6801 实现登录' }), null)
    assert.notEqual(view.find({ text: '连接飞书项目' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('shows the setup card until credentials save, then loads the list', async () => {
  let configured = false
  const host = mockHost({
    requests: {
      'meego.status': () => (configured ? STATUS_CONFIGURED : STATUS_UNCONFIGURED),
      'meego.saveCredentials': () => { configured = true; return { ok: true } },
      'meego.testConnection': () => ({ ok: true, projectKey: 'demo', userKey: 'dev_user', typeCount: 2 }),
      ...baseRequests({})
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    assert.notEqual(view.find({ text: '连接飞书项目' }), null)
    await view.press({ text: '高级连接' })
    assert.notEqual(view.find({ text: '还缺少：Plugin ID、Plugin Secret、Project Key、User Key' }), null)

    await view.type({ label: 'Plugin ID' }, 'MII_DEMO')
    await view.type({ label: 'Plugin Secret' }, 'demo-secret', { submit: true })
    await view.press({ text: '保存并测试连接' })
    await view.settled()

    assert.notEqual(view.find({ text: '工作项' }), null)
    assert.deepEqual(view.rowsOf({ label: '工作项列表' }), ['6801', '6802'])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('keeps the setup error visible when the connection test fails', async () => {
  const host = mockHost({
    requests: {
      'meego.status': () => STATUS_UNCONFIGURED,
      'meego.saveCredentials': () => ({ ok: true }),
      'meego.testConnection': () => { throw new Error('Meego API 错误 10204：插件密钥不正确') }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await view.press({ text: '高级连接' })
    await view.type({ label: 'Plugin ID' }, 'MII_DEMO')
    await view.type({ label: 'Plugin Secret' }, 'bad-secret')
    await view.press({ text: '保存并测试连接' })
    await view.settled()
    assert.notEqual(view.find({ text: 'Meego API 错误 10204：插件密钥不正确' }), null)
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('opens a detail from a row and hands the item to the agent', async () => {
  let linked = false
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.getWorkItem': () => ({ item: DETAIL }),
      'meego.workspaceContext': () => ({
        ...CONTEXT_LINKED,
        link: linked ? LINK : null,
        agents: [{ terminalId: 'terminal-1', agent: 'claude', title: 'Claude', state: 'working' }]
      }),
      'meego.linkWorkspace': () => { linked = true; return { ok: true } },
      'meego.sendToAgent': (input: { workspaceId: string; terminalId: string; expectedUserKey?: string }) => {
        assert.equal(input.workspaceId, 'ws-1')
        assert.equal(input.terminalId, 'terminal-1')
        assert.equal(input.expectedUserKey, STATUS_CONFIGURED.userKey)
        return { sent: true, detail: '已写入 Claude 的输入框，请在终端提交。' }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.settled()
    await view.activateRow({ label: '工作项列表' }, '6801')
    await view.settled()
    assert.notEqual(view.find({ text: '#6801 实现登录' }), null)
    await view.select({ label: '选择代码目录' }, 'ws-1')
    await view.press({ text: '关联此工作区' })
    await view.press({ text: '交给 Agent' })
    await view.press({ text: '写入 Agent 输入框' })
    await view.settled()
    assert.notEqual(view.find({ text: '已写入 Claude 的输入框，请在终端提交。' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('handoff from the workspace card explicitly requests a new agent', async () => {
  const host = mockHost({ requests: baseRequests({
    'meego.status': () => STATUS_CONFIGURED,
    'meego.workspaceContext': () => ({ ...CONTEXT_LINKED, agents: [] }),
    'meego.sendToAgent': (input: { terminalId?: string | null; workspaceId: string }) => {
      assert.equal(input.terminalId, null)
      assert.equal(input.workspaceId, 'ws-1')
      return { sent: true, detail: '已接收启动请求。' }
    }
  }) })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ text: '交接关联项' })
    await view.press({ text: '启动 Agent 并发送' })
    assert.notEqual(view.find({ text: '已接收启动请求。' }), null)
  } finally {
    await view.unmount()
  }
})

test('selects an explicit code directory while ambient focus is unavailable and retains it after workspace changes', async () => {
  const linked: unknown[] = []
  let link: WorkspaceLink | null = null
  const host = mockHost({ requests: baseRequests({
    'meego.status': () => STATUS_CONFIGURED,
    'meego.getWorkItem': () => ({ item: DETAIL }),
    'meego.workspaceContext': (input: { workspaceId: string } | undefined) => input
      ? { ...CONTEXT_LINKED, link, unavailableReason: '当前窗口未选择工作区', isActive: false }
      : { ...CONTEXT_NO_WORKSPACE, workspaceResolution: 'ambiguous' },
    'meego.linkWorkspace': (input: unknown) => { linked.push(input); link = LINK; return { ok: true } }
  }) })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.activateRow({ label: '工作项列表' }, '6801')
    assert.equal(view.find({ text: '重新识别工作区' }), null)
    await view.select({ label: '选择代码目录' }, 'ws-1')
    await view.press({ text: '关联此工作区' })
    assert.deepEqual(linked, [{ workItemId: 6801, typeKey: 'story', name: '实现登录', status: '开发中', url: DETAIL.url,
      expectedUserKey: 'dev_user', expectedLinkedAt: null, workspaceId: 'ws-1' }])
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.valueOf({ label: '选择代码目录' }), 'ws-1')
    await view.press({ text: '交给 Agent' })
    assert.notEqual(view.find({ label: '启动的 Agent' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('a failed workspace context request retains its cause and can be retried in place', async () => {
  let unavailable = true
  const host = mockHost({ requests: baseRequests({
    'meego.status': () => STATUS_CONFIGURED,
    'meego.workspaceContext': () => {
      if (unavailable) throw new Error('宿主连接已断开')
      return CONTEXT_LINKED
    }
  }) })
  const view = await mount(panel, { host })
  try {
    await panel.initialLoad
    assert.notEqual(view.find({ text: '读取 Orca 工作区失败：宿主连接已断开' }), null)
    unavailable = false
    await view.press({ text: '重新识别工作区' })
    assert.equal(view.find({ text: '读取 Orca 工作区失败：宿主连接已断开' }), null)
    await view.press({ text: '交接关联项' })
    assert.notEqual(view.find({ text: '启动 Agent 并发送' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('opens a legacy numeric link when the detail returns the same ID as text', async () => {
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.workspaceContext': () => CONTEXT_LINKED,
      'meego.workspaceOptions': () => ({ workspaces: [{ ...WORKSPACE, linkedToItem: true }], activeWorkspaceId: 'ws-1', truncated: false }),
      'meego.openWorkItemLink': (input: unknown) => {
        assert.deepEqual(input, { url: LINK.url, expectedUserKey: STATUS_CONFIGURED.userKey })
        return { item: { ...DETAIL, id: '6801' } }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.settled()
    assert.notEqual(view.find({ text: '解除关联' }), null)
    assert.notEqual(view.find({ text: '关联时使用分支 main。' }), null)
    await view.press({ label: '查看关联工作项' })
    assert.notEqual(view.find({ text: '已关联此工作项' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('unlinks the workspace from its work item', async () => {
  let linked = true
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.unlinkWorkspace': (input: { workspaceId: string; expectedLinkedAt?: number | null }) => {
        assert.equal(input.workspaceId, 'ws-1')
        assert.equal(input.expectedLinkedAt, LINK.linkedAt)
        linked = false
        return { ok: true }
      },
      'meego.workspaceContext': (): WorkspaceContextInfo =>
        linked ? CONTEXT_LINKED : { ...CONTEXT_LINKED, link: null }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.settled()
    await view.press({ text: '解除关联' })
    await view.settled()
    assert.equal(view.find({ text: '解除关联' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('picks a space after authorization and clears search when the space or account changes', async () => {
  let authorized = false
  let selected = ''
  let userKey = STATUS_CONFIGURED.userKey
  const listRequests: ListWorkItemsInput[] = []
  const statuses: MeegoStatus = { ...STATUS_UNCONFIGURED, connection: { state: 'disconnected' } }
  const authorizeUrl = 'https://project.feishu.cn/b/auth/mcp?usercode=mock'
  const host = mockHost({
    results: { 'shell.openExternal': { opened: true } },
    requests: baseRequests({
      'meego.status': () => {
        if (!authorized) return statuses
        if (!selected) return { ...statuses, connection: { state: 'choose_space', accountName: '测试账号' } }
        return {
          ...STATUS_CONFIGURED,
          projectKey: selected,
          userKey,
          connection: { state: 'connected', accountName: '测试账号', spaceName: selected === 'dev' ? '研发空间' : '交付空间' }
        }
      },
      'meego.beginAuthorization': () => ({ url: authorizeUrl, userCode: 'MOCK', expiresAt: Date.now() + 60_000, intervalMs: 1 }),
      'meego.pollAuthorization': () => {
        authorized = true
        return { state: 'authorized' }
      },
      'meego.listSpaces': () => ({ spaces: [{ key: 'dev', name: '研发空间' }, { key: 'delivery', name: '交付空间' }], hasMore: false }),
      'meego.selectSpace': ({ key }: { key: string }) => {
        selected = key
        return { ok: true }
      },
      'meego.listWorkItems': (input: ListWorkItemsInput) => {
        listRequests.push(input)
        return { items: ITEMS, total: ITEMS.length, page: 1, hasMore: false, fromCache: false }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ text: '连接飞书项目' })
    assert.notEqual(view.find({ text: '在浏览器授权' }), null)
    await view.press({ text: '在浏览器授权' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await view.settled()
    assert.deepEqual(host.callsOf('shell.openExternal'), [{ url: authorizeUrl }])
    await view.press({ text: '研发空间' })
    assert.notEqual(view.find({ text: '飞书项目 · 研发空间' }), null)
    await view.type({ label: '搜索' }, '研发查询', { submit: true })
    assert.equal(listRequests.at(-1)?.search, '研发查询')
    assert.equal(Object.hasOwn(view.persisted.plugin, 'meego.search'), false)
    await view.press({ text: '切换空间' })
    await view.press({ text: '交付空间' })
    assert.notEqual(view.find({ text: '飞书项目 · 交付空间' }), null)
    assert.equal(listRequests.at(-1)?.source?.projectKey, 'delivery')
    assert.equal(listRequests.at(-1)?.search, undefined)
    assert.equal(view.find({ label: '清除工作项搜索' }), null)
    await view.type({ label: '搜索' }, '原账号查询', { submit: true })
    assert.equal(listRequests.at(-1)?.search, '原账号查询')
    userKey = 'next_user'
    await view.post('meego.connectionChanged', { reason: 'authorized' })
    await view.settled()
    assert.equal(listRequests.at(-1)?.expectedUserKey, userKey)
    assert.equal(listRequests.at(-1)?.search, undefined)
    assert.equal(view.find({ label: '清除工作项搜索' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('opens a pasted work-item link and binds the resolved source to the focused workspace', async () => {
  const linkedDetail = { ...DETAIL, source: { baseUrl: 'https://project.feishu.cn', projectKey: 'delivery' } }
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.workspaceContext': () => ({ ...CONTEXT_LINKED, link: null }),
      'meego.openWorkItemLink': ({ url, expectedUserKey }: { url: string; expectedUserKey?: string }) => {
        assert.equal(url, DETAIL.url)
        assert.equal(expectedUserKey, STATUS_CONFIGURED.userKey)
        return { item: linkedDetail }
      },
      'meego.linkWorkspace': (input: unknown) => {
        assert.deepEqual(input, {
          workItemId: DETAIL.id,
          typeKey: DETAIL.typeKey,
          name: DETAIL.name,
          status: DETAIL.status,
          url: DETAIL.url,
          source: linkedDetail.source,
          workspaceId: 'ws-1',
          expectedUserKey: STATUS_CONFIGURED.userKey,
          expectedLinkedAt: null
        })
        return { ok: true }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '粘贴工作项链接' })
    await view.type({ label: '工作项链接' }, DETAIL.url, { submit: true })
    await view.settled()
    assert.notEqual(view.find({ text: '#6801 实现登录' }), null)
    await view.select({ label: '选择代码目录' }, 'ws-1')
    await view.press({ text: '关联此工作区' })
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('discards out-of-order list responses and uses the worker pagination flag', async () => {
  let completeSlow: () => void = () => {}
  const slowPage = new Promise((resolve) => {
    completeSlow = () => resolve({ items: [ITEMS[0]], total: 100, page: 1, hasMore: false, fromCache: false })
  })
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.listWorkItems': ({ search, page, source, expectedUserKey }: ListWorkItemsInput) => {
        assert.deepEqual(source, { baseUrl: STATUS_CONFIGURED.baseUrl, projectKey: STATUS_CONFIGURED.projectKey })
        assert.equal(expectedUserKey, STATUS_CONFIGURED.userKey)
        if (search === '慢') return slowPage
        if (search === '快' && page === 1) {
          return { items: [ITEMS[1]], total: 1, page: 1, hasMore: true, fromCache: false }
        }
        return { items: [{ ...ITEMS[1], id: '6802' }, ITEMS[0]], total: 2, page: page ?? 1, hasMore: false, fromCache: false }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    const slow = view.type({ label: '搜索' }, '慢', { submit: true })
    await view.type({ label: '搜索' }, '快', { replace: true, submit: true })
    completeSlow()
    await slow
    await view.settled()
    assert.deepEqual(view.rowsOf({ label: '工作项列表' }), ['6802'])
    await view.loadMore({ label: '工作项列表' })
    assert.deepEqual(view.rowsOf({ label: '工作项列表' }), ['6802', '6801'])
    assert.deepEqual(view.errors, [])
  } finally {
    completeSlow()
    await view.unmount()
  }
})

test('keeps adjacent 64-bit IDs distinct through keyboard search, binding, comments and handoff', async () => {
  const firstId = '9007199254740992'
  const id = '9007199254740993'
  const source = { baseUrl: STATUS_CONFIGURED.baseUrl, projectKey: STATUS_CONFIGURED.projectKey }
  const detail = { ...DETAIL, id, url: `${source.baseUrl}/demo/story/detail/${id}`, source }
  const account = { expectedUserKey: STATUS_CONFIGURED.userKey }
  const target = { id, typeKey: detail.typeKey, source, ...account }
  const table = { label: '工作项列表' }
  let link: WorkspaceLink | null = null
  let commentsPosted = 0
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.listWorkItems': ({ search }: ListWorkItemsInput) => {
        if (search !== undefined) assert.equal(search, `#${id}`)
        const items = search === undefined ? [{ ...ITEMS[1], id: firstId }, detail] : [detail]
        return { items, total: items.length, page: 1, hasMore: false, fromCache: false }
      },
      'meego.getWorkItem': (input: unknown) => {
        assert.deepEqual(input, target)
        return { item: detail }
      },
      'meego.workspaceContext': () => ({
        ...CONTEXT_LINKED,
        link,
        agents: [{ terminalId: 'terminal-1', title: 'Codex', agent: 'codex', state: 'working' }]
      }),
      'meego.linkWorkspace': (input: unknown) => {
        assert.deepEqual(input, {
          workItemId: id, typeKey: detail.typeKey, name: detail.name, status: detail.status, url: detail.url,
          source, ...account, workspaceId: 'ws-1', expectedLinkedAt: null
        })
        link = { ...LINK, workItemId: id, url: detail.url, source }
        return { ok: true }
      },
      'meego.listComments': (input: unknown) => {
        assert.deepEqual(input, { ...target, page: 1 })
        return { comments: [], hasMore: false }
      },
      'meego.addComment': (input: unknown) => {
        assert.deepEqual(input, { ...target, content: '复核通过' })
        commentsPosted += 1
        return { ok: true }
      },
      'meego.sendToAgent': (input: unknown) => {
        assert.deepEqual(input, {
          ...target, workspaceId: 'ws-1', terminalId: 'terminal-1', linked: true, expectedLinkedAt: LINK.linkedAt
        })
        return { sent: true, detail: '已写入 Codex 的输入框。' }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    assert.deepEqual(view.rowsOf(table), [firstId, id])
    assert.deepEqual(view.columnsOf(table, { width: 320 }), ['name'])
    assert.ok(view.columnsOf(table, { width: 600 }).includes('id'))
    await view.type({ label: '搜索' }, `#${id}`, { submit: true })
    assert.deepEqual(view.rowsOf(table), [id])
    await view.activateRow(table, id)
    assert.notEqual(view.find({ text: `#${id} ${detail.name}` }), null)
    await view.press({ label: '返回列表' })
    assert.notEqual(view.find({ text: `共 1 项 · 搜索「#${id}」` }), null)
    await view.activateRow(table, id)
    await view.select({ label: '选择代码目录' }, 'ws-1')
    await view.press({ text: '关联此工作区' })
    assert.notEqual(view.find({ text: '已关联此工作项' }), null)
    await view.press({ text: '查看评论' })
    await view.type({ label: '评论内容' }, '复核通过')
    await view.press({ text: '发布评论' })
    assert.equal(commentsPosted, 1)
    await view.press({ label: '返回列表' })
    await view.press({ text: '交接关联项' })
    await view.press({ text: '写入 Agent 输入框' })
    assert.notEqual(view.find({ text: '已写入 Codex 的输入框。' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('cancels a prepared browser authorization and restores the connection entry', async () => {
  let cancelled = false
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_UNCONFIGURED,
      'meego.beginAuthorization': () => ({
        url: 'https://project.feishu.cn/b/auth/mcp?usercode=mock',
        userCode: 'MOCK',
        expiresAt: Date.now() + 60_000,
        intervalMs: 1000
      }),
      'meego.cancelAuthorization': () => { cancelled = true; return { ok: true } }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ text: '连接飞书项目' })
    await view.press({ text: '取消授权' })
    assert.equal(cancelled, true)
    assert.notEqual(view.find({ text: '连接飞书项目' }), null)
    assert.deepEqual(host.callsOf('shell.openExternal'), [])
  } finally {
    await view.unmount()
  }
})

test('hands off the saved workspace link to the selected Agent', async () => {
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.workspaceContext': () => ({
        ...CONTEXT_LINKED,
        agents: [
          { terminalId: 'terminal-1', title: 'Claude', agent: 'claude', state: 'working' },
          { terminalId: 'terminal-2', title: 'Codex', agent: 'codex', state: 'waiting' }
        ]
      }),
      'meego.sendToAgent': (input: unknown) => {
        assert.deepEqual(input, {
          id: 6801, typeKey: 'story', workspaceId: 'ws-1', terminalId: 'terminal-2', linked: true,
          expectedLinkedAt: LINK.linkedAt, expectedUserKey: STATUS_CONFIGURED.userKey
        })
        return { sent: true, detail: '已写入 Codex 的输入框，请在终端提交。' }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ text: '交接关联项' })
    await view.select({ label: '目标 Agent' }, 'terminal-2')
    await view.press({ text: '写入 Agent 输入框' })
    assert.notEqual(view.find({ text: '已写入 Codex 的输入框，请在终端提交。' }), null)
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('previews a work-item link before choosing a browsing space', async () => {
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => ({
        ...STATUS_UNCONFIGURED,
        connection: { state: 'choose_space', accountName: '测试账号' }
      }),
      'meego.listSpaces': () => ({ spaces: [{ key: 'demo', name: '研发' }, { key: 'delivery', name: '交付' }], hasMore: false }),
      'meego.openWorkItemLink': () => ({ item: DETAIL })
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ text: '粘贴工作项链接' })
    await view.type({ label: '工作项链接' }, DETAIL.url, { submit: true })
    assert.notEqual(view.find({ text: '#6801 实现登录' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('pins the displayed account and space for creating a work item and opening its detail', async () => {
  const scope = {
    source: { baseUrl: STATUS_CONFIGURED.baseUrl, projectKey: STATUS_CONFIGURED.projectKey },
    expectedUserKey: STATUS_CONFIGURED.userKey
  }
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.listTypes': (input: unknown) => {
        assert.deepEqual(input, scope)
        return { types: TYPES }
      },
      'meego.createWorkItem': (input: unknown) => {
        assert.deepEqual(input, { typeKey: 'story', name: '实现登录', templateId: 'standard', ...scope })
        return { item: ITEMS[0] }
      },
      'meego.getWorkItem': (input: unknown) => {
        assert.deepEqual(input, { id: DETAIL.id, typeKey: DETAIL.typeKey, ...scope })
        return { item: DETAIL }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '新建工作项' })
    await view.type({ label: '标题' }, '实现登录')
    await view.press({ text: '创建' })
    assert.notEqual(view.find({ text: '#6801 实现登录' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('creates with the chosen template and validates required fields before sending', async () => {
  const scope = {
    source: { baseUrl: STATUS_CONFIGURED.baseUrl, projectKey: STATUS_CONFIGURED.projectKey },
    expectedUserKey: STATUS_CONFIGURED.userKey
  }
  let writes = 0
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => ({ ...STATUS_CONFIGURED, connection: { state: 'connected', accountName: '张三', spaceName: '产品研发' } }),
      'meego.createForm': (input: unknown) => {
        assert.deepEqual(input, { typeKey: 'story', ...scope })
        return { form: {
          templates: [{ id: 't-feature', name: '产品需求' }, { id: 't-infra', name: '基础设施' }],
          fields: [
            { key: '_impact', label: '影响范围', kind: 'text', required: true },
            { key: 'commit_date', label: '交付日期', kind: 'date', required: true },
            { key: 'internal', label: '内部交付', kind: 'boolean', required: true },
            { key: 'priority', label: '优先级', kind: 'select', required: true, options: [{ value: 'high', label: '高' }] }
          ],
          unsupportedRequired: [],
          descriptionRequired: true
        } }
      },
      'meego.createWorkItem': (input: unknown) => {
        writes += 1
        assert.deepEqual(input, {
          typeKey: 'story', name: '部署登录', description: '统一身份入口', templateId: 't-infra', ...scope,
          fieldValues: { _impact: '桌面端', commit_date: '2026-11-12', internal: 'false', priority: 'high' }
        })
        return { item: ITEMS[0] }
      },
      'meego.getWorkItem': () => ({ item: DETAIL })
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '新建工作项' })
    await view.type({ label: '标题' }, '部署登录')
    await view.press({ text: '创建' })
    assert.notEqual(view.find({ text: '请填写描述。' }), null)
    await view.type({ label: '描述（必填）' }, '统一身份入口')
    await view.press({ text: '创建' })
    assert.notEqual(view.find({ text: '请选择工作项模板。' }), null)
    await view.select({ label: '工作项模板' }, 't-infra')
    await view.press({ text: '创建' })
    assert.notEqual(view.find({ text: '请填写「影响范围」。' }), null)
    assert.equal(writes, 0)
    await view.type({ label: '影响范围', type: 'Input' }, '桌面端')
    await view.type({ label: '交付日期', type: 'Input' }, '2026-11-31')
    await view.press({ text: '创建' })
    assert.notEqual(view.find({ text: '「交付日期」须填写有效日期，格式为 YYYY-MM-DD。' }), null)
    await view.type({ label: '交付日期', type: 'Input' }, '2026-11-12', { replace: true })
    await view.select({ label: '内部交付', type: 'Select' }, 'false')
    await view.select({ label: '优先级', type: 'Select' }, 'high')
    await view.press({ text: '创建' })
    assert.equal(writes, 1)
    assert.notEqual(view.find({ text: '#6801 实现登录' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('loads scoped comments with the returned cursor and refreshes after publishing', async () => {
  const target = {
    id: DETAIL.id,
    typeKey: DETAIL.typeKey,
    source: { baseUrl: STATUS_CONFIGURED.baseUrl, projectKey: STATUS_CONFIGURED.projectKey },
    expectedUserKey: STATUS_CONFIGURED.userKey
  }
  const reads: unknown[] = []
  let writes = 0
  let attempts = 0
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => STATUS_CONFIGURED,
      'meego.getWorkItem': () => ({ item: DETAIL }),
      'meego.listComments': (input: { page?: number }) => {
        reads.push(input)
        const id = input.page === 2 ? 'second' : writes > 0 ? 'new' : 'first'
        return {
          comments: [{ id, author: '张三', content: id === 'new' ? '验证通过' : '处理记录', createdAt: NOW }],
          hasMore: id === 'first', ...(id === 'first' ? { nextCursor: 'next-token' } : {})
        }
      },
      'meego.addComment': (input: unknown) => {
        assert.deepEqual(input, { ...target, content: '验证通过' })
        attempts += 1
        if (attempts === 1) throw new Error('暂时无法发布')
        writes += 1
        return { ok: true }
      }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.activateRow({ label: '工作项列表' }, '6801')
    assert.equal(reads.length, 0)
    await view.press({ text: '查看评论' })
    await view.press({ text: '加载更多评论' })
    await view.type({ label: '评论内容' }, '验证通过')
    await view.press({ text: '发布评论' })
    assert.notEqual(view.find({ text: '暂时无法发布' }), null)
    await view.press({ text: '发布评论' })
    assert.equal(writes, 1)
    assert.equal(attempts, 2)
    assert.notEqual(view.find({ text: '评论已发布' }), null)
    assert.deepEqual(reads, [
      { ...target, page: 1 },
      { ...target, page: 2, cursor: 'next-token' },
      { ...target, page: 1 }
    ])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('loads metadata for the selected type and directs unsupported fields to the verified browser form', async () => {
  const typesSeen: string[] = []
  let writes = 0
  const host = mockHost({
    requests: baseRequests({
      'meego.status': () => ({ ...STATUS_CONFIGURED, connection: { state: 'connected', accountName: '张三', spaceName: '产品研发' } }),
      'meego.createForm': ({ typeKey }: { typeKey: string }) => {
        typesSeen.push(typeKey)
        return { form: {
          templates: [{ id: 'standard', name: '标准模板' }],
          fields: [],
          unsupportedRequired: typeKey === 'task' ? ['审批流程'] : [],
          browserUrl: `https://project.feishu.cn/demo/${typeKey}/create`
        } }
      },
      'meego.createWorkItem': () => { writes += 1; return { item: ITEMS[0] } }
    })
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '新建工作项' })
    await view.type({ label: '标题' }, '保留标题')
    await view.select({ label: '工作项类型' }, 'task')
    assert.deepEqual(typesSeen, ['story', 'task'])
    assert.notEqual(view.find({ text: '此类型需要在网页填写：审批流程。' }), null)
    assert.notEqual(view.find({ text: '在飞书项目中新建' }), null)
    await view.submit({ label: '标题' })
    assert.equal(writes, 0)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
