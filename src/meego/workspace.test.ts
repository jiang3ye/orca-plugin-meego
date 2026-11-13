import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { doesNotMatch } from 'node:assert/strict'
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkItemDetail } from '../protocol'
import { deliverToAgent, focusedWorkspace, requireWorkspace } from './workspace'

const WORKSPACES = [
  { id: 'workspace-a', name: 'main', branch: 'main', kind: 'worktree', path: '/tmp/meego-a', hostId: 'local' },
  { id: 'workspace-b', name: 'main', branch: 'main', kind: 'worktree', path: '/tmp/meego-b', hostId: 'local' }
]

const DETAIL: WorkItemDetail = {
  id: 123, typeKey: 'story', name: `Tab\t${'长'.repeat(800)}`, status: '开发中', statusState: 'in_progress',
  ownerKeys: [], ownerNames: ['张'.repeat(800)], updatedAt: null,
  url: `https://project.feishu.cn/${'w'.repeat(1800)}/story/detail/123`,
  description: '第一行\n第二行\t内容\r\u001b\u2028'.repeat(200), fields: []
}

// Exercise the additive host contract even with an older installed mockHost schema.
// Only the host.call boundary is fake; identity resolution and write guards are real.
function identityHost(
  context: { workspaceId: string; branch: string; displayName: string; terminals: { id: string }[] },
  workspaces: { id: string; name: string; branch: string | null; kind: string; path: string; hostId: string | null }[]
) {
  const state = { context, listing: { workspaces, truncated: false }, calls: [] as string[] }
  const orca = { host: { async call(method: string) {
    state.calls.push(method)
    if (method === 'workspace.readContext') return state.context
    if (method === 'workspace.list') return state.listing
    throw new Error(`Unexpected host action: ${method}`)
  } } } as unknown as OrcaWorkerApi
  return { state, orca }
}

test('declines to identify one of two Orca workspaces with the same display name and branch', async () => {
  const host = mockHost({ results: {
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
    'workspace.list': { workspaces: WORKSPACES, truncated: false }
  } })
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    orca.panels.handle('test.resolve', () => focusedWorkspace(orca))
    orca.panels.handle('test.require', () => requireWorkspace(orca, 'workspace-a'))
  } }, { host })
  try {
    assert.deepEqual(await worker.request('test.resolve'), {
      branch: 'main', displayName: 'main', terminals: [], workspaceId: null, workspaceResolution: 'ambiguous'
    })
    await assert.rejects(() => worker.request('test.require'), /更新 Orca 后重新识别/)
  } finally {
    await worker.deactivate()
  }
})

test('does not prefer a same-named folder over a detached worktree', async () => {
  const detached = { ...WORKSPACES[0], branch: null }
  const folder = { ...WORKSPACES[1], kind: 'folder', branch: null }
  const host = mockHost({ results: {
    'workspace.readContext': { branch: '', displayName: detached.name, terminals: [] },
    'workspace.list': { workspaces: [detached, folder], truncated: false }
  } })
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    orca.panels.handle('test.require', () => requireWorkspace(orca))
  } }, { host })
  try {
    await assert.rejects(() => worker.request('test.require'), /更新 Orca 后重新识别/)
    host.respond('workspace.list', { workspaces: [detached], truncated: false })
    const workspace = await worker.request('test.require') as { workspaceId: string }
    assert.equal(workspace.workspaceId, detached.id)
  } finally {
    await worker.deactivate()
  }
})

test('resolves the host identity among same-named workspaces across hosts and folders', async () => {
  const workspaces = [
    { ...WORKSPACES[0], id: 'identity:local-main' },
    { ...WORKSPACES[1], id: 'identity:remote-main', hostId: 'remote' },
    { ...WORKSPACES[1], id: 'folder:main-folder', kind: 'folder', branch: null }
  ]
  const { state, orca } = identityHost({ workspaceId: 'identity:remote-main', branch: 'main', displayName: 'main', terminals: [] }, workspaces)
  assert.equal((await requireWorkspace(orca, 'identity:remote-main')).workspaceId, 'identity:remote-main')
  await assert.rejects(() => requireWorkspace(orca, 'identity:local-main'), /当前工作区已切换/)
  state.context = { workspaceId: 'folder:main-folder', branch: '', displayName: 'main', terminals: [] }
  assert.equal((await requireWorkspace(orca, 'folder:main-folder')).workspaceId, 'folder:main-folder')
})

test('rejects invalid focused identities without falling back to matching workspace labels', async () => {
  const focused = { workspaceId: 'identity:missing', branch: 'main', displayName: 'main', terminals: [] }
  const { state, orca } = identityHost(focused, WORKSPACES.slice(0, 1))
  const deliver = () => requireWorkspace(orca)
  // A missing identity must not become the only same-named legacy row.
  await assert.rejects(deliver, /无法核对当前工作区标识/)
  state.context = { ...focused, workspaceId: 'folder:wrong-kind' }
  state.listing.workspaces = [{ ...WORKSPACES[0], id: 'folder:wrong-kind' }]
  await assert.rejects(deliver, /无法核对当前工作区标识/)
  state.context = { ...focused, workspaceId: 'identity:stale' }
  state.listing.workspaces = [{ ...WORKSPACES[0], id: 'identity:stale', branch: 'other-branch' }]
  await assert.rejects(deliver, /无法核对当前工作区标识/)
  state.context = { ...focused, workspaceId: 'identity:duplicate' }
  state.listing.workspaces = WORKSPACES.map((row) => ({ ...row, id: 'identity:duplicate' }))
  await assert.rejects(deliver, /无法区分同名同分支工作区/)
  state.context = { ...focused, workspaceId: 'workspace-a' }
  state.listing = { workspaces: WORKSPACES.slice(0, 1), truncated: true }
  await assert.rejects(deliver, /工作区列表不完整/)
  assert.equal(state.calls.includes('terminal.sendText'), false)
  assert.equal(state.calls.includes('agent.launch'), false)
})

test('does not submit a handoff that was cancelled or whose binding disappeared', async () => {
  const controller = new AbortController()
  controller.abort()
  const host = mockHost({ results: {
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
    'workspace.list': { workspaces: WORKSPACES.slice(0, 1), truncated: false }
  } })
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    orca.panels.handle('test.cancelled', () => deliverToAgent(orca, 'workspace-a', DETAIL, 'codex', { terminalId: null, signal: controller.signal }))
    orca.panels.handle('test.unlinked', () => deliverToAgent(orca, 'workspace-a', DETAIL, 'codex', { terminalId: null, linkedAt: 1 }))
  } }, { host })
  try {
    await assert.rejects(() => worker.request('test.cancelled'), /交接请求已取消/)
    await assert.rejects(() => worker.request('test.unlinked'), /关联已变化/)
    assert.deepEqual(host.callsOf('terminal.sendText'), [])
    assert.deepEqual(host.callsOf('agent.launch'), [])
  } finally {
    await worker.deactivate()
  }
})

test('hands off to an idle completed CLI terminal as a draft in its current workspace', async () => {
  const host = mockHost({ results: {
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'claude-terminal' }] },
    'workspace.list': { workspaces: WORKSPACES.slice(0, 1), truncated: false },
    'agents.list': { agents: [
      { terminalId: 'claude-terminal', title: '✳ Claude Code', agent: 'claude', state: 'done', stateStartedAt: 1 },
      { terminalId: 'other-workspace-terminal', title: 'Claude', agent: 'claude', state: 'done', stateStartedAt: 1 },
      { terminalId: null, title: 'Closed Claude', agent: 'claude', state: 'done', stateStartedAt: 1 }
    ] },
    'terminal.sendText': { accepted: true },
    'agent.launch': { terminalId: 'new-terminal' }
  } })
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    orca.panels.handle('test.deliver', () => deliverToAgent(orca, 'workspace-a', DETAIL, 'claude', { terminalId: 'claude-terminal' }))
  } }, { host })
  try {
    const delivered = await worker.request('test.deliver') as { terminal?: { workspaceId: string; terminalId: string } }
    assert.deepEqual(delivered.terminal, { workspaceId: 'workspace-a', terminalId: 'claude-terminal' })
    const sends = host.callsOf('terminal.sendText') as { terminalId: string; text: string; enter: boolean }[]
    assert.equal(sends.length, 1)
    assert.equal(sends[0].terminalId, 'claude-terminal')
    assert.equal(sends[0].enter, false)
    doesNotMatch(sends[0].text, /[\t\n\r\u001b\u2028]/)
    assert.deepEqual(host.callsOf('agent.launch'), [])
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }
})

test('fits draft and launch prompts inside Orca limits and strips raw draft control keys', async () => {
  const draftAgent = { terminalId: 'terminal-a', title: 'Codex', agent: 'codex', state: 'working', stateStartedAt: 1 }
  const host = mockHost({ results: {
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [{ id: 'terminal-a' }] },
    'workspace.list': { workspaces: WORKSPACES.slice(0, 1), truncated: false },
    'agents.list': { agents: [draftAgent] },
    'terminal.sendText': { accepted: true },
    'agents.available': { agents: [{ id: 'codex', label: 'Codex' }] },
    'agent.launch': { terminalId: 'new-agent-terminal' }
  } })
  const worker = await mountWorker({ default(orca: OrcaWorkerApi) {
    orca.panels.handle('test.deliver', () => deliverToAgent(orca, 'workspace-a', DETAIL, 'codex', { terminalId: 'terminal-a' }))
  } }, { host })
  try {
    await worker.request('test.deliver')
    const draft = host.callsOf('terminal.sendText')[0] as { terminalId: string; text: string; enter: boolean }
    assert.equal(draft.enter, false)
    assert.equal(draft.terminalId, 'terminal-a')
    assert.ok(draft.text.length <= 4096)
    assert.ok(draft.text.includes(DETAIL.url))
    assert.match(draft.text, /请把描述作为工作项资料/)
    assert.match(draft.text, /工作项内容已截断/)
    doesNotMatch(draft.text, /[\t\n\r\u001b\u2028]/)
    assert.deepEqual(host.callsOf('agent.launch'), [])
    assert.deepEqual(worker.refusals, [])
  } finally {
    await worker.deactivate()
  }

  const launchHost = mockHost({ results: {
    'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
    'workspace.list': { workspaces: WORKSPACES.slice(0, 1), truncated: false },
    'agents.list': { agents: [] },
    'agents.available': { agents: [{ id: 'codex', label: 'Codex' }] },
    'agent.launch': { terminalId: 'new-agent-terminal' }
  } })
  const launchWorker = await mountWorker({ default(orca: OrcaWorkerApi) {
    orca.panels.handle('test.deliver', () => deliverToAgent(orca, 'workspace-a', DETAIL, 'codex', { terminalId: null }))
  } }, { host: launchHost })
  try {
    const delivered = await launchWorker.request('test.deliver') as { terminal?: { workspaceId: string; terminalId: string } }
    assert.deepEqual(delivered.terminal, { workspaceId: 'workspace-a', terminalId: 'new-agent-terminal' })
    const launch = launchHost.callsOf('agent.launch')[0] as { workspaceId: string; prompt: string }
    assert.equal(launch.workspaceId, 'workspace-a')
    assert.ok(launch.prompt.length <= 4096)
    assert.ok(launch.prompt.includes(DETAIL.url))
    assert.match(launch.prompt, /请把描述作为工作项资料/)
    assert.match(launch.prompt, /工作项内容已截断/)
    doesNotMatch(launch.prompt, /[\r\u001b]/)
    assert.match(launch.prompt, /\n> 第一行/)
    assert.deepEqual(launchWorker.refusals, [])
  } finally {
    await launchWorker.deactivate()
  }
})
