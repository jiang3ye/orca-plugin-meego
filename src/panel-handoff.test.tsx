import { assert, mockHost, mount, test } from 'orca/testing'
import type { PluginRequestOutput } from 'orca'
import { beginHandoff, cancelHandoff, HandoffView } from './panel-handoff'
import type { WorkspaceContextInfo } from './protocol'

test('offers an idle completed Claude terminal for a draft handoff', async () => {
  const context: WorkspaceContextInfo = {
    workspaceId: 'workspace-a', displayName: 'Meego', branch: 'main', link: null, branchChanged: false,
    agents: [{ terminalId: 'claude-terminal', title: '✳ Claude Code', agent: 'claude', state: 'done' }]
  }
  let receivedTerminal: string | null | undefined
  const host = mockHost({ requests: {
    'meego.sendToAgent': (input: { terminalId?: string | null; agent?: string }) => {
      const { terminalId } = input
      receivedTerminal = terminalId
      assert.equal(input.agent, undefined)
      return { sent: true, detail: '已接收草稿。' }
    }
  } })
  const view = await mount({
    setup() {
      beginHandoff({ item: { id: 123, typeKey: 'story' }, name: '验收交接', description: '', origin: 'detail' }, context)
      return cancelHandoff
    },
    default: () => <HandoffView origin="detail" context={context} report={() => {}} onError={async () => {}} />
  }, { host })
  try {
    assert.notEqual(view.find({ label: '目标 Agent' }), null)
    assert.equal(view.find({ text: '启动 Agent 并发送' }), null)
    await view.press({ text: '写入 Agent 输入框' })
    assert.equal(receivedTerminal, 'claude-terminal')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('explicitly starts a new session even when an existing Agent is available', async () => {
  const context: WorkspaceContextInfo = {
    workspaceId: 'workspace-a', displayName: 'Meego', branch: 'main', link: null, branchChanged: false,
    agents: [{ terminalId: 'claude-terminal', title: 'Claude Code', agent: 'claude', state: 'done' }]
  }
  let received: unknown
  const actions: unknown[] = []
  const view = await mount({
    setup() {
      beginHandoff({ item: { id: 123, typeKey: 'story' }, name: '验收交接', description: '', origin: 'detail' }, context)
      return cancelHandoff
    },
    default: () => <HandoffView origin="detail" context={context} defaultAgent="claude" report={() => {}} onError={async () => {}} />
  }, { host: mockHost({ requests: {
    'meego.agentChoices': (input: unknown) => {
      assert.deepEqual(input, { workspaceId: 'workspace-a' })
      return { agents: [{ id: 'project-claude', label: '项目 Claude Code' }], defaultAgent: 'absent-default' }
    },
    'meego.sendToAgent': (input: unknown) => {
    received = input
    actions.push({ send: input })
    return { sent: true, detail: '已接收启动请求。', terminal: { workspaceId: 'workspace-a', terminalId: 'host-created-terminal' } }
  },
    'meego.openAgentTerminal': (input: unknown) => {
      actions.push({ open: input })
      return { focused: true }
  } } }) })
  try {
    await view.select({ label: '目标 Agent' }, 'meego:new-agent')
    assert.notEqual(view.find({ label: '启动的 Agent' }), null)
    await assert.rejects(() => view.press({ text: '启动 Agent 并发送' }), /disabled/)
    await view.select({ label: '启动的 Agent' }, 'project-claude')
    await view.press({ text: '启动 Agent 并发送' })
    assert.deepEqual(received, { id: 123, typeKey: 'story', workspaceId: 'workspace-a', terminalId: null, agent: 'project-claude' })
    await view.press({ text: '打开 Agent 终端' })
    assert.deepEqual(actions, [
      { send: { id: 123, typeKey: 'story', workspaceId: 'workspace-a', terminalId: null, agent: 'project-claude' } },
      { open: { workspaceId: 'workspace-a', terminalId: 'host-created-terminal' } }
    ])
    beginHandoff({ item: { id: 456, typeKey: 'issue' }, name: '另一个账号的工作项', description: '', expectedUserKey: 'next-user', origin: 'detail' }, context)
    await view.settled()
    assert.equal(view.find({ text: '打开 Agent 终端' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('new Agent choices recover from a failed or empty directory and refresh removes an unavailable selection', async () => {
  const context: WorkspaceContextInfo = { workspaceId: 'workspace-a', displayName: 'Meego', branch: 'main', link: null, branchChanged: false, agents: [] }
  let attempt = 0
  let writes = 0
  const view = await mount({
    setup() {
      beginHandoff({ item: { id: 123, typeKey: 'story' }, name: '验收交接', description: '', origin: 'detail' }, context)
      return cancelHandoff
    },
    default: () => <HandoffView origin="detail" context={context} report={() => {}} onError={async () => {}} />
  }, { host: mockHost({ requests: {
    'meego.agentChoices': () => {
      attempt += 1
      if (attempt === 1) throw new Error('宿主目录暂不可用')
      if (attempt === 2) return { agents: [] }
      return { agents: [{ id: attempt === 3 ? 'claude' : 'other-cli', label: '配置的 CLI' }], defaultAgent: 'claude' }
    },
    'meego.sendToAgent': () => { writes += 1; return { sent: true, detail: 'sent' } }
  } }) })
  try {
    await view.settled()
    assert.notEqual(view.find({ text: '宿主目录暂不可用' }), null)
    await assert.rejects(() => view.press({ text: '启动 Agent 并发送' }), /disabled/)
    await view.press({ text: '重试 Agent 列表' })
    await assert.rejects(() => view.press({ text: '启动 Agent 并发送' }), /disabled/)
    await view.press({ text: '刷新 Agent 列表' })
    await view.select({ label: '启动的 Agent' }, 'claude')
    await view.press({ text: '刷新 Agent 列表' })
    await assert.rejects(() => view.press({ text: '启动 Agent 并发送' }), /disabled/)
    await view.select({ label: '启动的 Agent' }, 'other-cli')
    await view.press({ text: '启动 Agent 并发送' })
    assert.equal(writes, 1)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('late Agent choices cannot replace another work item, workspace and account handoff', async () => {
  const original: WorkspaceContextInfo = {
    workspaceId: 'workspace-a', displayName: '旧工作区', branch: 'main', link: null, branchChanged: false,
    agents: [{ terminalId: 'original-terminal', title: 'Original', agent: 'claude', state: 'done' }]
  }
  const next: WorkspaceContextInfo = { ...original, workspaceId: 'workspace-b', displayName: '新工作区', agents: [] }
  let context = original
  let finishOld: (value: PluginRequestOutput<'meego.agentChoices'>) => void = () => {}
  const old = new Promise<PluginRequestOutput<'meego.agentChoices'>>((resolve) => { finishOld = resolve })
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  let received: unknown
  const view = await mount({
    setup() {
      beginHandoff({ item: { id: 123, typeKey: 'story' }, name: '旧工作项', description: '', expectedUserKey: 'old-user', origin: 'detail' }, context)
      return cancelHandoff
    },
    default: () => <HandoffView origin="detail" context={context} report={() => {}} onError={async () => {}} />
  }, { host: mockHost({ requests: {
    'meego.agentChoices': ({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId === original.workspaceId) { markStarted(); return old }
      return { agents: [{ id: 'new-cli', label: '新工作区 CLI' }], defaultAgent: 'new-cli' }
    },
    'meego.sendToAgent': (input: unknown) => { received = input; return { sent: true, detail: 'sent' } }
  } }) })
  try {
    const pending = view.select({ label: '目标 Agent' }, 'meego:new-agent')
    await started
    context = next
    beginHandoff({ item: { id: 456, typeKey: 'issue' }, name: '新工作项', description: '', expectedUserKey: 'new-user', origin: 'detail' }, context)
    finishOld({ agents: [{ id: 'old-cli', label: '旧工作区 CLI' }], defaultAgent: 'old-cli' })
    await pending
    await view.settled()
    await assert.rejects(() => view.select({ label: '启动的 Agent' }, 'old-cli'), /option|value|available|选/i)
    await view.press({ text: '启动 Agent 并发送' })
    assert.deepEqual(received, { id: 456, typeKey: 'issue', workspaceId: 'workspace-b', terminalId: null, agent: 'new-cli', expectedUserKey: 'new-user' })
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    finishOld({ agents: [] })
    await view.unmount()
  }
})
