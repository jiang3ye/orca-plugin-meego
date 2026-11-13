import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkItemDetail } from './protocol'
import { MeegoConnection } from './meego/connection'
import { registerWorkspaceActions } from './worker-workspace-actions'

const SETTINGS = { base_url: 'https://project.feishu.cn', project_key: 'demo', user_key: 'user-a', agent_command: 'codex' }
const SOURCE = { baseUrl: SETTINGS.base_url, projectKey: 'demo' }
const ITEM: WorkItemDetail = {
  id: 123, typeKey: 'story', name: 'Selected target task', status: 'Open', statusState: 'unstarted',
  ownerKeys: [], ownerNames: [], updatedAt: 1, url: 'https://project.feishu.cn/demo/story/detail/123',
  description: 'Implement the task', fields: []
}
const ROWS = [
  { id: 'identity:local-a', kind: 'worktree', name: 'main', branch: 'main', project: 'App', path: '/tmp/app-a', hostId: 'local' },
  { id: 'identity:remote-b', kind: 'worktree', name: 'main', branch: 'main', project: 'App', path: '/srv/app-b', hostId: 'ssh:box' }
]
const TARGET = 'identity:remote-b'
const REF = { id: 123, typeKey: 'story', source: SOURCE, expectedUserKey: 'user-a' }

function hostWith(results: Record<string, unknown> = {}) {
  return mockHost({ settings: SETTINGS, secrets: { meego_plugin_id: 'synthetic-plugin', meego_plugin_secret: 'synthetic-secret' }, results: {
    'workspace.list': { workspaces: ROWS, truncated: false }, 'workspace.readContext': null,
    'agents.available': { agents: [{ id: 'codex', label: 'Codex' }] },
    'agent.launch': { terminalId: 'new-terminal' }, 'workspace.open': { opened: true }, ...results
  } })
}

const workspaceWorker = { default(orca: OrcaWorkerApi) {
  registerWorkspaceActions(orca, new MeegoConnection(orca), { validate: (id) => id, read: async () => ITEM })
} }

function pauseBoundary() {
  let enter!: () => void
  let resume!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { resume = resolve })
  return { entered, resume, wait: async () => { enter(); await released } }
}

test('associates and starts an explicitly selected workspace when ambient context is unavailable', async () => {
  const host = hostWith({ 'workspace.readContext': () => { throw new Error('context unavailable') } })
  const worker = await mountWorker(workspaceWorker, { host })
  try {
    const options = await worker.request('meego.workspaceOptions', REF)
    assert.deepEqual(options.workspaces, [
      { id: 'identity:local-a', kind: 'worktree', name: 'main', branch: 'main', project: 'App', path: '/tmp/app-a', hostId: 'local', linkedToItem: false },
      { id: 'identity:remote-b', kind: 'worktree', name: 'main', branch: 'main', project: 'App', path: '/srv/app-b', hostId: 'ssh:box', linkedToItem: false }
    ])
    assert.equal(options.activeWorkspaceId, null)
    assert.match(options.message!, /context unavailable/)
    const absent = await worker.request('meego.workspaceContext')
    assert.match(absent.unavailableReason!, /context unavailable/)
    await worker.request('meego.linkWorkspace', { workItemId: 123, typeKey: 'story', name: ITEM.name, workspaceId: TARGET, source: SOURCE, expectedUserKey: 'user-a', expectedLinkedAt: null })
    const selected = await worker.request('meego.workspaceContext', { workspaceId: TARGET })
    assert.equal(selected.workspaceId, TARGET)
    assert.equal(selected.project, 'App')
    assert.equal(selected.path, '/srv/app-b')
    assert.equal(selected.hostId, 'ssh:box')
    assert.equal(selected.isActive, false)
    assert.deepEqual(selected.agents, [])
    assert.equal(selected.link?.workItemId, 123)
    const linked = await worker.request('meego.workspaceOptions', REF)
    assert.deepEqual(linked.workspaces.map((row) => [row.id, row.linkedToItem]), [['identity:local-a', false], ['identity:remote-b', true]])
    await assert.rejects(() => worker.request('meego.workspaceOptions', { ...REF, expectedUserKey: 'other-user' }), /连接状态已变化/)
    assert.deepEqual(await worker.request('meego.agentChoices', { workspaceId: TARGET }), { agents: [{ id: 'codex', label: 'Codex' }] })
    await worker.request('meego.sendToAgent', { ...REF, workspaceId: TARGET, terminalId: null, agent: 'codex', linked: true, expectedLinkedAt: selected.link!.linkedAt })
    assert.deepEqual((host.callsOf('agent.launch') as { workspaceId: string; agent: string }[]).map(({ workspaceId, agent }) => ({ workspaceId, agent })), [{ workspaceId: 'identity:remote-b', agent: 'codex' }])
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
    assert.deepEqual(host.callsOf('agents.list'), [])
    await worker.request('meego.openWorkspace', { workspaceId: TARGET })
    assert.deepEqual(host.callsOf('workspace.open'), [{ workspaceId: TARGET }])
    await assert.rejects(() => worker.request('meego.unlinkWorkspace', { workspaceId: TARGET, expectedLinkedAt: 0 }), /关联已变化/)
    await worker.request('meego.unlinkWorkspace', { workspaceId: TARGET, expectedLinkedAt: selected.link!.linkedAt })
    assert.equal((await worker.request('meego.workspaceContext', { workspaceId: TARGET })).link, null)
  } finally { await worker.deactivate() }
})

test('unknown, duplicate and truncated target identities cannot associate, open or launch', async () => {
  for (const workspaces of [ROWS.slice(0, 1), [ROWS[1], ROWS[1]], ROWS]) {
    const host = hostWith({ 'workspace.list': { workspaces, truncated: workspaces === ROWS } })
    const worker = await mountWorker(workspaceWorker, { host })
    try {
      await assert.rejects(() => worker.request('meego.linkWorkspace', { workItemId: 123, typeKey: 'story', name: ITEM.name, workspaceId: TARGET, expectedLinkedAt: null }), /列表不完整|已不可用或标识不唯一/)
      await assert.rejects(() => worker.request('meego.openWorkspace', { workspaceId: TARGET }), /列表不完整|已不可用或标识不唯一/)
      await assert.rejects(() => worker.request('meego.sendToAgent', { ...REF, workspaceId: TARGET, terminalId: null, agent: 'codex' }), /列表不完整|已不可用或标识不唯一/)
      assert.deepEqual(host.callsOf('workspace.open'), [])
      assert.deepEqual(host.callsOf('agent.launch'), [])
      assert.equal(host.data().storage['meego.workspaceLinks'], undefined)
    } finally { await worker.deactivate() }
  }
})

test('opens a validated Agent terminal without launching or sending the prompt again', async () => {
  const host = hostWith({
    'terminal.list': { terminals: [{ id: 'received-terminal' }], truncated: false },
    'terminal.focus': { focused: true }
  })
  const worker = await mountWorker(workspaceWorker, { host })
  try {
    assert.deepEqual(await worker.request('meego.openAgentTerminal', { workspaceId: TARGET, terminalId: 'received-terminal' }), { focused: true })
    host.respond('terminal.focus', { focused: false })
    assert.deepEqual(await worker.request('meego.openAgentTerminal', { workspaceId: TARGET, terminalId: 'received-terminal' }), { focused: false })
    assert.deepEqual(host.callsOf('terminal.list'), [{ workspaceId: 'identity:remote-b' }, { workspaceId: 'identity:remote-b' }])
    assert.deepEqual(host.callsOf('terminal.focus'), [{ terminalId: 'received-terminal' }, { terminalId: 'received-terminal' }])
    assert.deepEqual(host.callsOf('workspace.open'), [])
    assert.deepEqual(host.callsOf('agent.launch'), [])
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
  } finally { await worker.deactivate() }
})

test('unknown, cross-workspace, duplicate or truncated terminal targets cannot be focused', async () => {
  const targets = [
    { terminalId: 'missing-terminal', terminals: [], truncated: false },
    { terminalId: 'local-workspace-terminal', terminals: [{ id: 'received-terminal' }], truncated: false },
    { terminalId: 'received-terminal', terminals: [{ id: 'received-terminal' }, { id: 'received-terminal' }], truncated: false },
    { terminalId: 'received-terminal', terminals: [{ id: 'received-terminal' }], truncated: true }
  ]
  for (const { terminalId, terminals, truncated } of targets) {
    const host = hostWith({ 'terminal.list': { terminals, truncated } })
    const worker = await mountWorker(workspaceWorker, { host })
    try {
      await assert.rejects(() => worker.request('meego.openAgentTerminal', { workspaceId: TARGET, terminalId }), /终端列表不完整|所选 Agent 终端已不可用/)
      assert.deepEqual(host.callsOf('terminal.focus'), [])
      assert.deepEqual(host.callsOf('agent.launch'), [])
      assert.deepEqual(host.callsOf('terminal.sendText'), [])
    } finally { await worker.deactivate() }
  }
})

test('an unavailable workspace cannot be opened through a stale Agent terminal receipt', async () => {
  for (const listing of [
    { workspaces: ROWS.slice(0, 1), truncated: false },
    { workspaces: [ROWS[1], ROWS[1]], truncated: false },
    { workspaces: ROWS, truncated: true }
  ]) {
    const host = hostWith({ 'workspace.list': listing })
    const worker = await mountWorker(workspaceWorker, { host })
    try {
      await assert.rejects(() => worker.request('meego.openAgentTerminal', { workspaceId: TARGET, terminalId: 'received-terminal' }), /列表不完整|已不可用或标识不唯一/)
      assert.deepEqual(host.callsOf('terminal.list'), [])
      assert.deepEqual(host.callsOf('terminal.focus'), [])
    } finally { await worker.deactivate() }
  }
  const host = hostWith({ 'terminal.list': () => {
    host.respond('workspace.list', { workspaces: [], truncated: false })
    return { terminals: [{ id: 'received-terminal' }], truncated: false }
  } })
  const worker = await mountWorker(workspaceWorker, { host })
  try {
    await assert.rejects(() => worker.request('meego.openAgentTerminal', { workspaceId: TARGET, terminalId: 'received-terminal' }), /已不可用或标识不唯一/)
    assert.deepEqual(host.callsOf('terminal.focus'), [])
  } finally { await worker.deactivate() }
})

test('a removed target or installed Agent cannot launch after the item was read', async () => {
  for (const change of ['workspace', 'agent']) {
    const host = hostWith()
    const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
      registerWorkspaceActions(orca, new MeegoConnection(orca), {
        validate: (id) => id,
        read: async () => {
          if (change === 'workspace') host.respond('workspace.list', { workspaces: [], truncated: false })
          else host.respond('agents.available', { agents: [] })
          return ITEM
        }
      })
    } }, { host })
    try {
      await assert.rejects(() => worker.request('meego.sendToAgent', { ...REF, workspaceId: TARGET, terminalId: null, agent: 'codex' }), /所选 Agent 已不可用|已不可用或标识不唯一/)
      assert.deepEqual(host.callsOf('agent.launch'), [])
      assert.deepEqual(host.callsOf('terminal.sendText'), [])
    } finally { await worker.deactivate() }
  }
})

test('an existing terminal stays limited to the active workspace even when another target is selected', async () => {
  const host = hostWith({
    'workspace.readContext': { workspaceId: 'identity:local-a', branch: 'main', displayName: 'main', terminals: [{ id: 'local-terminal' }] },
    'agents.list': { agents: [{ terminalId: 'local-terminal', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] }
  })
  const worker = await mountWorker(workspaceWorker, { host })
  try {
    const selected = await worker.request('meego.workspaceContext', { workspaceId: TARGET })
    assert.equal(selected.isActive, false)
    assert.deepEqual(selected.agents, [])
    await assert.rejects(() => worker.request('meego.sendToAgent', { ...REF, workspaceId: TARGET, terminalId: 'local-terminal' }), /当前工作区已切换/)
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
  } finally { await worker.deactivate() }
})

test('an old account association cannot overwrite the new account after inventory or queued storage waits', async () => {
  for (const boundary of ['inventory', 'storage', 'credentials']) {
    const paused = pauseBoundary()
    let lists = 0
    let secretReads = 0
    let pauseStorage = boundary === 'storage'
    let newAccountSaved!: () => void
    const saved = new Promise<void>((resolve) => { newAccountSaved = resolve })
    const host = hostWith({ 'workspace.list': async () => {
      if (boundary === 'inventory' && ++lists === 2) await paused.wait()
      return { workspaces: ROWS, truncated: false }
    } })
    let ports!: OrcaWorkerApi
    const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
      ports = orca
      const originalGet = orca.storage.get.bind(orca.storage)
      const originalSet = orca.storage.set.bind(orca.storage)
      const scoped: OrcaWorkerApi = { ...orca, secrets: { ...orca.secrets, get: async (key) => {
        if (boundary === 'credentials' && key === 'meego_plugin_credentials' && ++secretReads === 2) await paused.wait()
        return orca.secrets.get(key)
      } }, storage: { ...orca.storage, get: async (key: string) => {
        if (key === 'meego.workspaceLinks' && pauseStorage) {
          pauseStorage = false
          await paused.wait()
        }
        return originalGet(key)
      }, set: async (key, value) => {
        await originalSet(key, value)
        if (key === 'meego.workspaceLinks' && value && typeof value === 'object' && !Array.isArray(value)) {
          const link = value[TARGET]
          if (link && typeof link === 'object' && !Array.isArray(link) && link.accountKey === 'user-b') newAccountSaved()
        }
      } } }
      registerWorkspaceActions(scoped, new MeegoConnection(scoped), { validate: (id) => id, read: async () => ITEM })
    } }, { host })
    try {
      const old = worker.request('meego.linkWorkspace', { workItemId: 123, typeKey: 'story', name: 'Old account task', workspaceId: TARGET, expectedLinkedAt: null })
      const rejected = assert.rejects(() => old, /连接状态已变化/)
      await paused.entered
      await ports.settings.set('user_key', 'user-b')
      const current = worker.request('meego.linkWorkspace', { workItemId: 456, typeKey: 'story', name: 'New account task', workspaceId: TARGET, expectedUserKey: 'user-b', expectedLinkedAt: null })
      if (boundary === 'inventory') await saved
      paused.resume()
      await rejected
      await current
      const selected = await worker.request('meego.workspaceContext', { workspaceId: TARGET })
      assert.equal(selected.link?.workItemId, 456)
      assert.equal(selected.link?.accountKey, 'user-b')
      assert.equal(selected.link?.name, 'New account task')
    } finally { paused.resume(); await worker.deactivate() }
  }
})

test('account changes during item reads or final credentials validation block new sessions, drafts and commands', async () => {
  for (const boundary of ['read', 'credentials']) {
    for (const mode of ['new', 'existing', 'command']) {
      const paused = pauseBoundary()
      let guardReads = false
      const host = hostWith({
        'workspace.readContext': { workspaceId: TARGET, branch: 'main', displayName: 'main', terminals: [{ id: 'target-terminal' }] },
        'agents.list': { agents: [{ terminalId: 'target-terminal', title: 'Codex', agent: 'codex', state: 'done', stateStartedAt: 1 }] }
      })
      let ports!: OrcaWorkerApi
      const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
        ports = orca
        const scoped: OrcaWorkerApi = { ...orca, secrets: { ...orca.secrets, get: async (key) => {
          if (boundary === 'credentials' && guardReads && key === 'meego_plugin_credentials') {
            guardReads = false
            await paused.wait()
          }
          return orca.secrets.get(key)
        } } }
        registerWorkspaceActions(scoped, new MeegoConnection(scoped), { validate: (id) => id, read: async () => {
          guardReads = true
          if (boundary === 'read') await paused.wait()
          return ITEM
        } })
      } }, { host })
      try {
        await ports.storage.set('meego.workspaceLinks', { [TARGET]: {
          workItemId: 123, typeKey: 'story', name: 'Task', status: 'Open', branch: 'main', linkedAt: 1,
          url: ITEM.url, source: SOURCE, accountKey: 'user-a'
        } })
        const request = mode === 'command' ? worker.command('meego.sendToAgent')
          : worker.request('meego.sendToAgent', { id: 123, typeKey: 'story', workspaceId: TARGET,
            ...(mode === 'new' ? { terminalId: null, agent: 'codex' } : { terminalId: 'target-terminal' }) })
        const rejected = assert.rejects(() => request, /连接状态已变化/)
        await paused.entered
        await ports.settings.set('user_key', 'user-b')
        paused.resume()
        await rejected
        assert.deepEqual(host.callsOf('agent.launch'), [])
        assert.deepEqual(host.callsOf('terminal.sendText'), [])
      } finally { paused.resume(); await worker.deactivate() }
    }
  }
})

test('a reconnect with the same actor during the final Agent catalog wait invalidates the original generation', async () => {
  const paused = pauseBoundary()
  const host = hostWith({ 'agents.available': async () => { await paused.wait(); return { agents: [{ id: 'codex', label: 'Codex' }] } } })
  let connection!: MeegoConnection
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    connection = new MeegoConnection(orca)
    registerWorkspaceActions(orca, connection, { validate: (id) => id, read: async () => ITEM })
  } }, { host })
  try {
    const request = worker.request('meego.sendToAgent', { id: 123, typeKey: 'story', workspaceId: TARGET, terminalId: null, agent: 'codex' })
    const rejected = assert.rejects(() => request, /连接状态已变化/)
    await paused.entered
    await connection.saveCredentials('synthetic-plugin', 'synthetic-secret')
    paused.resume()
    await rejected
    assert.deepEqual(host.callsOf('agent.launch'), [])
  } finally { paused.resume(); await worker.deactivate() }
})

test('source changes during the last linked-item read cannot launch under a different ambient space', async () => {
  const paused = pauseBoundary()
  let linkReads = 0
  const host = hostWith()
  let ports!: OrcaWorkerApi
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    ports = orca
    const originalGet = orca.storage.get.bind(orca.storage)
    const scoped = { ...orca, storage: { ...orca.storage, get: async (key: string) => {
      if (key === 'meego.workspaceLinks' && ++linkReads === 3) await paused.wait()
      return originalGet(key)
    } } }
    registerWorkspaceActions(scoped, new MeegoConnection(scoped), { validate: (id) => id, read: async () => ITEM })
  } }, { host })
  try {
    await ports.storage.set('meego.workspaceLinks', { [TARGET]: {
      workItemId: 123, typeKey: 'story', name: 'Task', status: 'Open', branch: 'main', linkedAt: 1,
      url: ITEM.url, source: SOURCE, accountKey: 'user-a'
    } })
    const request = worker.request('meego.sendToAgent', { id: 123, typeKey: 'story', workspaceId: TARGET, terminalId: null, agent: 'codex', linked: true, expectedLinkedAt: 1 })
    const rejected = assert.rejects(() => request, /来自其他飞书项目连接/)
    await paused.entered
    await ports.settings.set('project_key', 'other-space')
    paused.resume()
    await rejected
    assert.deepEqual(host.callsOf('agent.launch'), [])
  } finally { paused.resume(); await worker.deactivate() }
})
