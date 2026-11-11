import { Button, Stack } from 'orca'
import { assert, hostError, mockHost, mount, test, type MockRequests } from 'orca/testing'
import type { CreatedWorkspaceReceipt, WorkItemReference, WorkspaceCreationPlan } from './protocol'
import { beginWorkspaceCreation, resetWorkspaceCreation, WorkspaceCreationPanel } from './panel-workspace-create'

const ref: WorkItemReference = { id: 123, typeKey: 'story', expectedUserKey: 'user-a', source: { baseUrl: 'https://project.feishu.cn', projectKey: 'space-a' } }
const other: WorkItemReference = { ...ref, id: 456 }
const source = { id: 'repo-a', name: 'main', project: 'Orca', path: '/repos/orca', branch: 'main', hostId: 'local' }
const receipt: CreatedWorkspaceReceipt = { workspaceId: 'created-a', name: 'meego-123', path: '/worktrees/meego-123', branch: 'meego-123' }
const ready: WorkspaceCreationPlan = { planId: 'plan-a', state: 'ready', name: 'meego-123', sources: [source], recoveryWorkspaces: [] }
const linked: WorkspaceCreationPlan = { ...ready, state: 'linked', sources: [], receipt }

function fixture(onCreated?: (receipt: CreatedWorkspaceReceipt) => void, errors: unknown[] = []) {
  return {
    setup() { resetWorkspaceCreation(); return resetWorkspaceCreation },
    default: () => <Stack>
      <Button onPress={() => beginWorkspaceCreation(ref)}>开始创建</Button>
      <Button onPress={() => beginWorkspaceCreation(other)}>打开另一个创建计划</Button>
      <WorkspaceCreationPanel onError={async (error) => { errors.push(error) }} onCreated={onCreated} />
    </Stack>
  }
}

function hostFor(requests: MockRequests) {
  return mockHost({ requests: { 'meego.workspaceCreationPlan': () => ready, ...requests } })
}

test('creates with the selected Git source and opens the fixed receipt only on user action', async () => {
  const writes: unknown[] = []
  const opens: unknown[] = []
  const created: CreatedWorkspaceReceipt[] = []
  const view = await mount(fixture((value) => created.push(value)), { host: hostFor({
    'meego.createWorkspace': (input: unknown) => { writes.push(input); return linked },
    'meego.openCreatedWorkspace': (input: unknown) => { opens.push(input); return { opened: true } }
  }) })
  try {
    await view.press({ text: '开始创建' })
    assert.notEqual(view.find({ label: '来源 Git 工作区' }), null)
    assert.notEqual(view.find({ text: '/repos/orca' }), null)
    await view.press({ text: '创建并关联' })
    assert.deepEqual(writes, [{ ref, planId: 'plan-a', sourceWorkspaceId: 'repo-a', name: 'meego-123' }])
    assert.equal(created[0]?.workspaceId, 'created-a')
    assert.deepEqual(opens, [])
    assert.equal(view.find({ text: '创建并关联' }), null)
    await view.press({ text: '打开工作区' })
    assert.deepEqual(opens, [{ ref, planId: 'plan-a' }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('a lost reply hides create and lets the user refresh then explicitly recover an existing workspace', async () => {
  let creates = 0
  let reads = 0
  const recovered: unknown[] = []
  const errors: unknown[] = []
  const uncertain: WorkspaceCreationPlan = {
    ...ready, state: 'uncertain', sources: [], recoveryWorkspaces: [{ ...source, id: receipt.workspaceId, path: receipt.path, name: receipt.name, branch: receipt.branch! }], message: '先核对工作区。'
  }
  const view = await mount(fixture(undefined, errors), { host: hostFor({
    'meego.workspaceCreationPlan': () => ++reads === 1 ? ready : uncertain,
    'meego.createWorkspace': () => { creates += 1; throw hostError('timeout', '创建响应超时') },
    'meego.recoverCreatedWorkspace': (input: unknown) => { recovered.push(input); return linked }
  }) })
  try {
    await view.press({ text: '开始创建' })
    await view.press({ text: '创建并关联' })
    assert.equal(view.find({ text: '创建并关联' }), null)
    assert.equal(creates, 1)
    assert.equal(reads, 1)
    await view.press({ text: '刷新创建记录' })
    await view.select({ label: '已创建的工作区' }, 'created-a')
    await view.press({ text: '关联所选工作区' })
    assert.deepEqual(recovered, [{ ref, planId: 'plan-a', workspaceId: 'created-a' }])
    assert.equal(creates, 1)
    assert.equal(errors.length, 1)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('association failure offers only receipt retry and never repeats the create', async () => {
  let creates = 0
  const retries: unknown[] = []
  const view = await mount(fixture(), { host: hostFor({
    'meego.createWorkspace': () => { creates += 1; return { ...linked, state: 'created', message: '工作区已创建，关联失败。' } },
    'meego.retryCreatedWorkspaceLink': (input: unknown) => { retries.push(input); return linked }
  }) })
  try {
    await view.press({ text: '开始创建' })
    await view.press({ text: '创建并关联' })
    assert.equal(view.find({ text: '创建并关联' }), null)
    assert.equal(view.find({ text: '打开工作区' }), null)
    await view.press({ text: '重试关联已有工作区' })
    assert.deepEqual(retries, [{ ref, planId: 'plan-a' }])
    assert.equal(creates, 1)
    assert.notEqual(view.find({ text: '打开工作区' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('only explicit not-created acknowledgement reopens a plan after uncertainty', async () => {
  let acknowledgements = 0
  const view = await mount(fixture(), { host: hostFor({
    'meego.workspaceCreationPlan': () => ({ ...ready, state: 'uncertain', sources: [] }),
    'meego.confirmWorkspaceNotCreated': (input: unknown) => {
      assert.deepEqual(input, { ref, planId: 'plan-a' })
      acknowledgements += 1
      return { ...ready, planId: 'new-plan' }
    }
  }) })
  try {
    await view.press({ text: '开始创建' })
    assert.equal(view.find({ text: '创建并关联' }), null)
    await view.press({ text: '已核对，未创建' })
    assert.equal(acknowledgements, 1)
    assert.notEqual(view.find({ text: '创建并关联' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('late plan reads cannot replace another work item or account target', async () => {
  let resolveOld: (value: WorkspaceCreationPlan) => void = () => {}
  const oldPlan = new Promise<WorkspaceCreationPlan>((resolve) => { resolveOld = resolve })
  let started = () => {}
  const starting = new Promise<void>((resolve) => { started = resolve })
  const writes: unknown[] = []
  const view = await mount(fixture(), { host: hostFor({
    'meego.workspaceCreationPlan': ({ id }: WorkItemReference) => {
      if (id === 123) { started(); return oldPlan }
      return { ...ready, name: 'meego-456', planId: 'plan-b' }
    },
    'meego.createWorkspace': (input: unknown) => { writes.push(input); return { ...linked, planId: 'plan-b' } }
  }) })
  try {
    const pending = view.press({ text: '开始创建' })
    await starting
    beginWorkspaceCreation(other)
    resolveOld(ready)
    await pending
    await view.settled()
    await view.press({ text: '创建并关联' })
    assert.deepEqual(writes, [{ ref: other, planId: 'plan-b', sourceWorkspaceId: 'repo-a', name: 'meego-456' }])
    assert.deepEqual(view.errors, [])
  } finally { resolveOld(ready); await view.unmount() }
})

test('older host guidance stays visible without fabricating a source', async () => {
  const message = '请更新 Orca 后重新打开 Git 工作区。'
  const view = await mount(fixture(), { host: hostFor({
    'meego.workspaceCreationPlan': () => ({ ...ready, sources: [], message })
  }) })
  try {
    await view.press({ text: '开始创建' })
    assert.notEqual(view.find({ text: message }), null)
    const button = view.find({ text: '创建并关联', type: 'Button' })
    assert.equal(button?.disabled, true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('source choices distinguish same-named main workspaces by project, host and path', async () => {
  const writes: unknown[] = []
  const second = { ...source, id: 'repo-b', project: 'Meego', hostId: 'ssh-build', path: '/srv/meego' }
  const view = await mount(fixture(), { host: hostFor({
    'meego.workspaceCreationPlan': () => ({ ...ready, sources: [source, second] }),
    'meego.createWorkspace': (input: unknown) => { writes.push(input); return linked }
  }) })
  try {
    await view.press({ text: '开始创建' })
    assert.match(JSON.stringify(view.tree()), /Orca · main · main · local · \/repos\/orca/)
    assert.match(JSON.stringify(view.tree()), /Meego · main · main · ssh-build · \/srv\/meego/)
    await view.select({ label: '来源 Git 工作区' }, second.id)
    assert.notEqual(view.find({ text: '/srv/meego' }), null)
    await view.press({ text: '创建并关联' })
    assert.deepEqual(writes, [{ ref, planId: 'plan-a', sourceWorkspaceId: 'repo-b', name: 'meego-123' }])
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('unsupported names show the naming rule and invalid feedback before submission', async () => {
  const view = await mount(fixture(), { host: hostFor({}) })
  try {
    await view.press({ text: '开始创建' })
    assert.notEqual(view.find({ text: '名称需为 1–80 位英文字母、数字、短横线或下划线，并以字母或数字开头。' }), null)
    await view.type({ label: '工作区名称' }, '登录优化', { replace: true })
    assert.match(JSON.stringify(view.tree()), /"invalid":true/)
    assert.notEqual(view.find({ text: '请使用英文名称，例如 meego-123；名称不支持中文、空格或其他符号。' }), null)
    assert.equal(view.find({ text: '创建并关联', type: 'Button' })?.disabled, true)
    await view.type({ label: '工作区名称' }, 'login-flow', { replace: true })
    assert.match(JSON.stringify(view.tree()), /"invalid":false/)
    assert.equal(view.find({ text: '创建并关联', type: 'Button' })?.disabled, false)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('a creation reply after connection reset cannot call onCreated or restore the old target', async () => {
  let finish: (value: WorkspaceCreationPlan) => void = () => {}
  let started = () => {}
  const starting = new Promise<void>((resolve) => { started = resolve })
  const result = new Promise<WorkspaceCreationPlan>((resolve) => { finish = resolve })
  const created: CreatedWorkspaceReceipt[] = []
  const view = await mount(fixture((value) => created.push(value)), { host: hostFor({
    'meego.createWorkspace': () => { started(); return result }
  }) })
  try {
    await view.press({ text: '开始创建' })
    const pending = view.press({ text: '创建并关联' })
    await starting
    resetWorkspaceCreation()
    finish(linked)
    await pending
    assert.deepEqual(created, [])
    assert.equal(view.find({ text: '打开工作区' }), null)
    assert.equal(view.find({ text: '从工作项创建工作区' }), null)
    assert.deepEqual(view.errors, [])
  } finally { finish(linked); await view.unmount() }
})
