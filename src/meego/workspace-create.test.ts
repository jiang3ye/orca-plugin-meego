import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { CreatedWorkspaceReceipt, WorkItemDetail, WorkItemReference } from '../protocol'
import { RequestError } from './connection'
import { registerWorkspaceCreation } from './workspace-create'

const SOURCE = { baseUrl: 'https://project.feishu.cn', projectKey: 'space-a' }
const REF: WorkItemReference = { id: 123, typeKey: 'story', source: SOURCE, expectedUserKey: 'user-a' }
const ITEM: WorkItemDetail = {
  id: 123, typeKey: 'story', source: SOURCE, name: '登录体验', status: '进行中', statusState: 'in_progress',
  ownerKeys: [], ownerNames: [], updatedAt: null, description: '', fields: [], url: 'https://project.feishu.cn/space-a/story/detail/123'
}
const ROOT = { id: 'source-a', name: 'main', project: 'Orca', path: '/repos/orca', branch: 'main', hostId: 'local', kind: 'worktree' as const }
const RECEIPT: CreatedWorkspaceReceipt = { workspaceId: 'created-a', name: 'meego-123', branch: 'meego-123', path: '/worktrees/meego-123' }

async function fixture(createSignal?: AbortSignal) {
  let account = 'user-a'
  let workspaces: { id: string; name: string; project?: string | null; path: string; branch: string | null; hostId: string | null; kind: 'worktree' | 'folder' }[] = [ROOT]
  let canCreateWorktree: boolean | undefined = true
  let creates = 0
  let opens: string[] = []
  let create = async (_input: { sourceWorkspaceId: string; name: string; requestId: string }, _options?: { signal?: AbortSignal }) => {
    workspaces = [...workspaces, { id: RECEIPT.workspaceId, name: RECEIPT.name, path: RECEIPT.path, branch: RECEIPT.branch, hostId: ROOT.hostId, kind: 'worktree' }]
    return RECEIPT
  }
  let beforeSet = (_key: string, _value: unknown): void => {}
  let beforeResolve = async (): Promise<void> => {}
  const host = mockHost()
  const module = { default(orca: OrcaWorkerApi) {
    const call = orca.host.call.bind(orca.host)
    const mockedCall = (async (...args: Parameters<typeof call>) => {
      const [method, params, options] = args
      if (method === 'workspace.list') return { workspaces, truncated: false, ...(canCreateWorktree === undefined ? {} : { canCreateWorktree }) }
      if (method === 'workspace.create') { creates += 1; return create(params as Parameters<typeof create>[0], options) }
      if (method === 'workspace.open') { opens.push((params as { workspaceId: string }).workspaceId); return { opened: true } }
      return call(...args)
    }) as typeof orca.host.call
    const handle = ((name: string, handler: Parameters<typeof orca.panels.handle>[1]) => {
      orca.panels.handle(name, (input, context) => handler(input, {
        ...context, signal: name === 'meego.createWorkspace' ? createSignal ?? context.signal : context.signal
      }))
    }) as typeof orca.panels.handle
    const wrapped: OrcaWorkerApi = { ...orca,
      host: { ...orca.host, call: mockedCall },
      panels: { ...orca.panels, handle },
      storage: { ...orca.storage, async set(key, value) { beforeSet(key, value); await orca.storage.set(key, value) } }
    }
    orca.panels.handle('test.setLinks', (input) => {
      if (input === undefined) throw new Error('Expected workspace links')
      return orca.storage.set('meego.workspaceLinks', input)
    })
    registerWorkspaceCreation(wrapped, { async resolve(ref) {
      await beforeResolve()
      if (ref.expectedUserKey && ref.expectedUserKey !== account) throw new RequestError('account_changed', '账号已变化。')
      return { item: ITEM, accountKey: account }
    } })
  } }
  const worker = await mountWorker(module, { host })
  return {
    worker, host, module, creates: () => creates, opens: () => opens,
    setCreate(value: typeof create) { create = value }, setAccount(value: string) { account = value },
    setWorkspaces(value: typeof workspaces) { workspaces = value },
    setCapability(value: boolean | undefined) { canCreateWorktree = value },
    beforeSet(value: typeof beforeSet) { beforeSet = value },
    beforeResolve(value: typeof beforeResolve) { beforeResolve = value },
    journals: () => Object.entries(host.data().storage).filter(([key]) => key.startsWith('meego.workspaceCreation.v1.')),
    links: () => host.data().storage['meego.workspaceLinks'] as Record<string, { workItemId: number; accountKey: string }> | undefined
  }
}

test('journals before creating, persists receipt before linking, and opens only on request', async () => {
  const f = await fixture()
  let sawCreating = false
  let sawReceiptBeforeLink = false
  f.beforeSet((key, value) => {
    if (key.startsWith('meego.workspaceCreation.v1.') && (value as { state: string }).state === 'creating') sawCreating = true
    if (key === 'meego.workspaceLinks') {
      const journal = f.journals()[0][1] as { state: string; receipt?: CreatedWorkspaceReceipt }
      sawReceiptBeforeLink = journal.state === 'created' && journal.receipt?.workspaceId === RECEIPT.workspaceId
    }
  })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    assert.equal(plan.name, 'meego-123')
    const result = await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    assert.equal(result.state, 'linked', result.message)
    assert.equal(sawCreating, true)
    assert.equal(sawReceiptBeforeLink, true)
    assert.equal(f.links()?.['created-a']?.workItemId, 123)
    assert.equal(f.links()?.['source-a'], undefined)
    assert.deepEqual(f.host.callsOf('workspace.readContext'), [])
    assert.deepEqual(f.opens(), [])
    await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    assert.equal(f.creates(), 1)
    await f.worker.request('meego.openCreatedWorkspace', { ref: REF, planId: plan.planId })
    assert.deepEqual(f.opens(), ['created-a'])
  } finally { await f.worker.deactivate() }
})

test('does not dispatch when durable creating storage fails', async () => {
  const f = await fixture()
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    f.beforeSet((key, value) => {
      if (key.startsWith('meego.workspaceCreation.v1.') && (value as { state: string }).state === 'creating') throw new Error('disk unavailable')
    })
    await assert.rejects(() => f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name }), /disk unavailable/)
    assert.equal(f.creates(), 0)
    assert.equal(f.links(), undefined)
  } finally { await f.worker.deactivate() }
})

test('cancellation while revalidating a creation plan never dispatches a host create', async () => {
  const controller = new AbortController()
  const f = await fixture(controller.signal)
  let release = () => {}
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let reachedRevalidation = () => {}
  const revalidating = new Promise<void>((resolve) => { reachedRevalidation = resolve })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    let reads = 0
    f.beforeResolve(async () => {
      if (++reads === 2) { reachedRevalidation(); await waiting }
    })
    const pending = f.worker.request('meego.createWorkspace', {
      ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name
    })
    const cancelled = assert.rejects(() => pending, /cancelled while reading the creation source/)
    await revalidating
    controller.abort(new Error('cancelled while reading the creation source'))
    release()
    await cancelled
    assert.equal(f.creates(), 0)
    assert.equal(f.links(), undefined)
    assert.equal((f.journals()[0][1] as { state: string }).state, 'ready')
  } finally { release(); await f.worker.deactivate() }
})

test('a host creation receipt arriving after cancellation stays uncertain and is never associated', async () => {
  const controller = new AbortController()
  const f = await fixture(controller.signal)
  let finish: (receipt: CreatedWorkspaceReceipt) => void = () => {}
  const pendingReceipt = new Promise<CreatedWorkspaceReceipt>((resolve) => { finish = resolve })
  let started = () => {}
  const starting = new Promise<void>((resolve) => { started = resolve })
  f.setCreate(async (_input, options) => {
    assert.equal(options?.signal, controller.signal)
    started()
    // An already-started host effect can finish even if its caller is cancelled.
    return pendingReceipt
  })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    const input = { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name }
    const pending = f.worker.request('meego.createWorkspace', input)
    await starting
    controller.abort(new Error('cancelled after host dispatch'))
    f.setWorkspaces([ROOT, { ...ROOT, id: RECEIPT.workspaceId, name: RECEIPT.name, path: RECEIPT.path, branch: RECEIPT.branch }])
    finish(RECEIPT)
    assert.equal((await pending).state, 'uncertain')
    assert.equal(f.creates(), 1)
    assert.equal(f.links(), undefined)
    assert.equal((await f.worker.request('meego.workspaceCreationPlan', REF)).state, 'uncertain')
    assert.equal(f.creates(), 1)
    assert.deepEqual(f.opens(), [])
  } finally { finish(RECEIPT); await f.worker.deactivate() }
})

test('a timed-out host creation must settle before an explicit acknowledgement can renew its request id', async () => {
  // The plugin has no Node type dependency; this public runner clock advances the
  // actual 75-second deadline without sleeps or production-only test hooks.
  const runner = 'node:test'
  const { mock } = await import(runner) as {
    mock: { timers: { enable(options: { apis: string[] }): void; tick(milliseconds: number): void; reset(): void } }
  }
  const f = await fixture()
  let finish: (receipt: CreatedWorkspaceReceipt) => void = () => {}
  const pendingReceipt = new Promise<CreatedWorkspaceReceipt>((resolve) => { finish = resolve })
  let started = () => {}
  const starting = new Promise<void>((resolve) => { started = resolve })
  f.setCreate(async () => { started(); return pendingReceipt })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    const input = { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name }
    const previousRequestId = (f.journals()[0][1] as { requestId: string }).requestId
    mock.timers.enable({ apis: ['setTimeout'] })
    const pending = f.worker.request('meego.createWorkspace', input)
    await starting
    mock.timers.tick(75_000)
    assert.equal((await pending).state, 'uncertain')
    assert.equal((await f.worker.request('meego.workspaceCreationPlan', REF)).state, 'uncertain')
    await assert.rejects(() => f.worker.request('meego.confirmWorkspaceNotCreated', { ref: REF, planId: plan.planId }), /创建请求仍在进行/)
    await assert.rejects(() => f.worker.request('meego.createWorkspace', input), /创建请求仍在进行/)
    assert.equal(f.creates(), 1)
    assert.equal((f.journals()[0][1] as { requestId: string }).requestId, previousRequestId)
    finish(RECEIPT)
    const renewed = await f.worker.request('meego.confirmWorkspaceNotCreated', { ref: REF, planId: plan.planId })
    assert.equal(renewed.state, 'ready')
    assert.notEqual(renewed.planId, plan.planId)
    assert.notEqual((f.journals()[0][1] as { requestId: string }).requestId, previousRequestId)
    assert.equal(f.creates(), 1)
    assert.equal(f.links(), undefined)
    assert.deepEqual(f.opens(), [])
  } finally {
    mock.timers.reset()
    finish(RECEIPT)
    await f.worker.deactivate()
  }
})

test('serializes two concurrent submissions of the same plan into one host create', async () => {
  const f = await fixture()
  let finish: (receipt: CreatedWorkspaceReceipt) => void = () => {}
  let started = () => {}
  const starting = new Promise<void>((resolve) => { started = resolve })
  const pendingReceipt = new Promise<CreatedWorkspaceReceipt>((resolve) => { finish = resolve })
  f.setCreate(async () => { started(); return pendingReceipt })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    const input = { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name }
    const first = f.worker.request('meego.createWorkspace', input)
    await starting
    const second = f.worker.request('meego.createWorkspace', input)
    f.setWorkspaces([ROOT, { ...ROOT, id: RECEIPT.workspaceId, name: RECEIPT.name, path: RECEIPT.path, branch: RECEIPT.branch }])
    finish(RECEIPT)
    assert.equal((await first).state, 'linked')
    assert.equal((await second).state, 'linked')
    assert.equal(f.creates(), 1)
  } finally { finish(RECEIPT); await f.worker.deactivate() }
})

test('uncertain create survives worker restart and only explicit not-created acknowledgement renews request id', async () => {
  const f = await fixture()
  f.setCreate(async () => { throw new Error('lost response') })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    const input = { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name }
    assert.equal((await f.worker.request('meego.createWorkspace', input)).state, 'uncertain')
    const requestId = (f.journals()[0][1] as { requestId: string }).requestId
    assert.match(requestId, /^[A-Za-z0-9_-]{1,128}$/)
    await f.worker.request('meego.createWorkspace', input)
    assert.equal(f.creates(), 1)
    await f.worker.deactivate()
    const restarted = await mountWorker(f.module, { host: f.host })
    try {
      const resumed = await restarted.request('meego.workspaceCreationPlan', REF)
      assert.equal(resumed.state, 'uncertain')
      assert.equal(resumed.planId, plan.planId)
      await restarted.request('meego.createWorkspace', input)
      assert.equal(f.creates(), 1)
      const renewed = await restarted.request('meego.confirmWorkspaceNotCreated', { ref: REF, planId: plan.planId })
      assert.equal(renewed.state, 'ready')
      assert.notEqual(renewed.planId, plan.planId)
      assert.notEqual((f.journals()[0][1] as { requestId: string }).requestId, requestId)
      assert.equal(f.creates(), 1)
    } finally { await restarted.deactivate() }
  } finally { await f.worker.deactivate() }
})

test('keeps receipt on account switch and retries only association after original account returns', async () => {
  const f = await fixture()
  f.setCreate(async () => {
    f.setWorkspaces([ROOT, { ...ROOT, id: RECEIPT.workspaceId, path: RECEIPT.path, name: RECEIPT.name, branch: RECEIPT.branch }])
    f.setAccount('user-b')
    return RECEIPT
  })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    const created = await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    assert.equal(created.state, 'created')
    assert.equal(created.receipt?.workspaceId, 'created-a')
    assert.equal(f.links(), undefined)
    await assert.rejects(() => f.worker.request('meego.retryCreatedWorkspaceLink', { ref: REF, planId: plan.planId }), /账号已变化/)
    f.setAccount('user-a')
    assert.equal((await f.worker.request('meego.retryCreatedWorkspaceLink', { ref: REF, planId: plan.planId })).state, 'linked')
    assert.equal(f.creates(), 1)
    assert.equal(f.links()?.['created-a']?.accountKey, 'user-a')
  } finally { await f.worker.deactivate() }
})

test('blocks association until receipt persistence succeeds, without another create', async () => {
  const f = await fixture()
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    f.beforeSet((key, value) => {
      if (key.startsWith('meego.workspaceCreation.v1.') && (value as { state: string }).state === 'created') throw new Error('receipt not saved')
    })
    const result = await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    assert.equal(result.state, 'created')
    assert.equal(f.links(), undefined)
    f.beforeSet(() => {})
    assert.equal((await f.worker.request('meego.retryCreatedWorkspaceLink', { ref: REF, planId: plan.planId })).state, 'linked')
    assert.equal(f.creates(), 1)
  } finally { await f.worker.deactivate() }
})

test('explicit recovery associates a selected existing receipt without creating or changing focus', async () => {
  const f = await fixture()
  f.setCreate(async () => { throw new Error('lost') })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    f.setWorkspaces([ROOT, { ...ROOT, id: 'recovered', path: '/worktrees/recovered', branch: 'meego-123', name: 'meego-123' }])
    await assert.rejects(() => f.worker.request('meego.recoverCreatedWorkspace', { ref: REF, planId: plan.planId, workspaceId: ROOT.id }), /不能选择来源/)
    const recovered = await f.worker.request('meego.recoverCreatedWorkspace', { ref: REF, planId: plan.planId, workspaceId: 'recovered' })
    assert.equal(recovered.state, 'linked')
    assert.equal(recovered.receipt?.workspaceId, 'recovered')
    assert.equal(f.links()?.recovered?.workItemId, 123)
    assert.equal(f.creates(), 1)
    assert.deepEqual(f.opens(), [])
  } finally { await f.worker.deactivate() }
})

test('rejects stale plans and source branch changes; old hosts cannot offer a creation source', async () => {
  const f = await fixture()
  try {
    const old = await f.worker.request('meego.workspaceCreationPlan', REF)
    const current = await f.worker.request('meego.workspaceCreationPlan', REF)
    await assert.rejects(() => f.worker.request('meego.createWorkspace', { ref: REF, planId: old.planId, sourceWorkspaceId: ROOT.id, name: old.name }), /计划已变化/)
    f.setWorkspaces([{ ...ROOT, branch: 'release' }])
    await assert.rejects(() => f.worker.request('meego.createWorkspace', { ref: REF, planId: current.planId, sourceWorkspaceId: ROOT.id, name: current.name }), /仓库、主机或分支已变化/)
    f.setCapability(undefined)
    const unsupported = await f.worker.request('meego.workspaceCreationPlan', REF)
    assert.deepEqual(unsupported.sources, [])
    assert.match(unsupported.message ?? '', /更新 Orca/)
    assert.equal(f.creates(), 0)
  } finally { await f.worker.deactivate() }
})

test('uses only the top-level creation marker and returns Git branches with project labels', async () => {
  const f = await fixture()
  try {
    f.setWorkspaces([
      ROOT,
      { ...ROOT, id: 'other-project', project: 'Meego', path: '/repos/meego' },
      { ...ROOT, id: 'folder', project: null, kind: 'folder' },
      { ...ROOT, id: 'detached', project: null, branch: null }
    ])
    const supported = await f.worker.request('meego.workspaceCreationPlan', REF)
    assert.deepEqual(supported.sources.map((row) => ({ id: row.id, project: row.project })), [
      { id: ROOT.id, project: 'Orca' }, { id: 'other-project', project: 'Meego' }
    ])
    f.setCapability(false)
    const unavailable = await f.worker.request('meego.workspaceCreationPlan', REF)
    assert.deepEqual(unavailable.sources, [])
    assert.match(unavailable.message ?? '', /更新 Orca/)
    f.setCapability(true)
    f.setWorkspaces([{ ...ROOT, branch: null }])
    const detachedOnly = await f.worker.request('meego.workspaceCreationPlan', REF)
    assert.deepEqual(detachedOnly.sources, [])
    assert.match(detachedOnly.message ?? '', /打开有分支/)
    assert.equal(f.creates(), 0)
  } finally { await f.worker.deactivate() }
})

test('project display-name changes do not change the selected source identity', async () => {
  const f = await fixture()
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    f.setWorkspaces([{ ...ROOT, project: 'Orca 重命名' }])
    const created = await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    assert.equal(created.state, 'linked')
    assert.equal(f.creates(), 1)
  } finally { await f.worker.deactivate() }
})

test('never overwrites a different existing work item when recovering a workspace', async () => {
  const f = await fixture()
  f.setCreate(async () => { throw new Error('lost') })
  try {
    const plan = await f.worker.request('meego.workspaceCreationPlan', REF)
    await f.worker.request('meego.createWorkspace', { ref: REF, planId: plan.planId, sourceWorkspaceId: ROOT.id, name: plan.name })
    f.setWorkspaces([ROOT, { ...ROOT, id: 'taken', path: '/worktrees/taken' }])
    await f.worker.request('test.setLinks', { taken: { workItemId: 456, typeKey: 'story', accountKey: 'user-b', source: SOURCE } })
    await assert.rejects(() => f.worker.request('meego.recoverCreatedWorkspace', { ref: REF, planId: plan.planId, workspaceId: 'taken' }), /已关联其他工作项/)
    assert.equal(f.links()?.taken?.workItemId, 456)
    assert.equal(f.creates(), 1)
  } finally { await f.worker.deactivate() }
})
