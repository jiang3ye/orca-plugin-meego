import { assert, mockHost, mount, test } from 'orca/testing'
import { setWorkspaceLinkItem, WorkspaceLinkPanel, refreshWorkspaceLink } from './panel-workspace-link'
import type { WorkItemDetail, WorkspaceContextInfo, WorkspaceLink, WorkspaceOption } from './protocol'

const source = { baseUrl: 'https://project.feishu.cn', projectKey: 'demo' }
const item: WorkItemDetail = {
  id: '9007199254740993', typeKey: 'story', name: '实现登录', status: '开发中', statusState: 'in_progress',
  ownerKeys: [], ownerNames: [], updatedAt: 1000, source, url: 'https://project.feishu.cn/demo/story/detail/9007199254740993', description: '', fields: []
}
const directories: WorkspaceOption[] = [
  { id: 'code-a', name: '登录开发', kind: 'worktree', project: '网站', branch: 'feat/login', path: '/code/site-login', hostId: 'local' },
  { id: 'code-b', name: '接口开发', kind: 'worktree', project: 'API', branch: 'feat/api', path: '/code/api', hostId: 'local' }
]
const noError = async () => {}
const ref = { id: '9007199254740993', typeKey: 'story', source, expectedUserKey: 'user-a' }

function context(id: string, link: WorkspaceLink | null = null): WorkspaceContextInfo {
  const row = directories.find((entry) => entry.id === id)!
  return { workspaceId: id, workspaceResolution: 'resolved', displayName: row.name, project: row.project, path: row.path,
    branch: row.branch, hostId: 'local', isActive: false, link, branchChanged: false, agents: [] }
}

function fixture() {
  return {
    setup() { setWorkspaceLinkItem(item, 'user-a'); return () => setWorkspaceLinkItem() },
    default: () => <WorkspaceLinkPanel onError={noError} />
  }
}

test('explicitly selects and saves a code directory without any ambient workspace, then hands off that exact association', async () => {
  let saved: WorkspaceLink | null = null
  const writes: unknown[] = []
  const reads: unknown[] = []
  const launches: unknown[] = []
  const view = await mount(fixture(), { host: mockHost({ requests: {
    'meego.workspaceOptions': (input: unknown) => {
      assert.deepEqual(input, ref)
      return { workspaces: directories, activeWorkspaceId: null, truncated: false }
    },
    'meego.workspaceContext': (input) => { assert.ok(input); reads.push(input); return context(input.workspaceId, saved) },
    'meego.linkWorkspace': (input: unknown) => {
      writes.push(input)
      saved = { workItemId: item.id, typeKey: 'story', name: item.name, status: item.status, source, accountKey: 'user-a', branch: 'feat/login', linkedAt: 42, url: item.url }
      return { ok: true }
    },
    'meego.agentChoices': (input: unknown) => { assert.deepEqual(input, { workspaceId: 'code-a' }); return { agents: [{ id: 'claude', label: 'Claude Code' }] } },
    'meego.sendToAgent': (input: unknown) => { launches.push(input); return { sent: true, detail: '已接收启动请求' } }
  } }) })
  try {
    await view.settled()
    assert.deepEqual(reads, [])
    assert.equal(view.find({ text: '关联此工作区' }), null)
    await view.select({ label: '选择代码目录' }, 'code-a')
    assert.deepEqual(writes, [])
    await view.press({ text: '关联此工作区' })
    assert.deepEqual(writes, [{ workItemId: '9007199254740993', typeKey: 'story', name: '实现登录', status: '开发中', url: item.url,
      source, expectedUserKey: 'user-a', workspaceId: 'code-a', expectedLinkedAt: null }])
    await view.press({ text: '交给 Agent' })
    await view.select({ label: '启动的 Agent' }, 'claude')
    await view.press({ text: '启动 Agent 并发送' })
    assert.deepEqual(launches, [{ ...ref, workspaceId: 'code-a', terminalId: null, agent: 'claude', linked: true, expectedLinkedAt: 42 }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('choosing another directory cancels an old handoff and ignores its late Agent catalog', async () => {
  const link: WorkspaceLink = { workItemId: item.id, typeKey: 'story', name: item.name, status: item.status, source, accountKey: 'user-a', branch: 'feat/login', linkedAt: 42, url: item.url }
  let finish: (value: { agents: { id: string; label: string }[] }) => void = () => {}
  const pending = new Promise<{ agents: { id: string; label: string }[] }>((resolve) => { finish = resolve })
  let started = () => {}
  const starting = new Promise<void>((resolve) => { started = resolve })
  const sends: unknown[] = []
  const view = await mount(fixture(), { host: mockHost({ requests: {
    'meego.workspaceOptions': () => ({ workspaces: directories.map((row) => ({ ...row, linkedToItem: row.id === 'code-a' })), activeWorkspaceId: null, truncated: false }),
    'meego.workspaceContext': (input) => { assert.ok(input); return context(input.workspaceId, input.workspaceId === 'code-a' ? link : null) },
    'meego.agentChoices': () => { started(); return pending },
    'meego.sendToAgent': (input: unknown) => { sends.push(input); return { sent: true, detail: 'unexpected' } }
  } }) })
  try {
    await view.settled()
    const opening = view.press({ text: '交给 Agent' })
    await starting
    const selecting = view.select({ label: '选择代码目录' }, 'code-b')
    finish({ agents: [{ id: 'old-agent', label: '旧目录 Agent' }] })
    await selecting
    await opening
    await view.settled()
    assert.equal(view.find({ text: '启动 Agent 并发送' }), null)
    assert.notEqual(view.find({ text: '关联此工作区' }), null)
    assert.deepEqual(sends, [])
    await refreshWorkspaceLink()
    assert.equal(view.find({ text: '交给 Agent' }), null)
    assert.notEqual(view.find({ text: '关联此工作区' }), null)
    assert.deepEqual(view.errors, [])
  } finally { finish({ agents: [] }); await view.unmount() }
})

test('replacing another work item requires its displayed association version and never writes while selecting', async () => {
  const old: WorkspaceLink = { workItemId: 321, typeKey: 'issue', name: '旧工作项', status: 'Open', branch: 'feat/login', linkedAt: 99, url: 'https://project.feishu.cn/demo/issue/detail/321', source }
  const writes: unknown[] = []
  const view = await mount(fixture(), { host: mockHost({ requests: {
    'meego.workspaceOptions': () => ({ workspaces: directories, activeWorkspaceId: 'code-b', truncated: false }),
    'meego.workspaceContext': (input) => { assert.ok(input); return context(input.workspaceId, old) },
    'meego.linkWorkspace': (input: unknown) => { writes.push(input); return { ok: true } }
  } }) })
  try {
    await view.settled()
    await view.select({ label: '选择代码目录' }, 'code-a')
    await view.press({ text: '替换为此工作项' })
    assert.deepEqual(writes, [])
    await view.press({ text: '确认替换关联' })
    assert.deepEqual(writes, [{ workItemId: '9007199254740993', typeKey: 'story', name: '实现登录', status: '开发中', url: item.url,
      source, expectedUserKey: 'user-a', workspaceId: 'code-a', expectedLinkedAt: 99 }])
  } finally { await view.unmount() }
})

test('a warning cannot authorize a context returned for a different code directory', async () => {
  const writes: unknown[] = []
  const view = await mount(fixture(), { host: mockHost({ requests: {
    'meego.workspaceOptions': () => ({ workspaces: directories, activeWorkspaceId: null, truncated: false }),
    'meego.workspaceContext': () => ({ ...context('code-b'), unavailableReason: '当前窗口没有工作区' }),
    'meego.linkWorkspace': (input: unknown) => { writes.push(input); return { ok: true } }
  } }) })
  try {
    await view.settled()
    await view.select({ label: '选择代码目录' }, 'code-a')
    assert.equal(view.valueOf({ label: '选择代码目录' }), 'code-a')
    assert.equal(view.find({ text: '关联此工作区' }), null)
    assert.equal(view.find({ text: '交给 Agent' }), null)
    assert.deepEqual(writes, [])
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
