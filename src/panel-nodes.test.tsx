import { Button, Stack } from 'orca'
import { assert, hostError, mockHost, mount, test, type MockRequests } from 'orca/testing'
import { NodesPanel, resetNodes } from './panel-nodes'
import type { EditWorkItemNodeInput, WorkItemDetail, WorkItemNode, WorkItemNodeList } from './protocol'

const actor = 'current-user'
const source = { baseUrl: 'https://project.feishu.cn', projectKey: 'project-a' }
const detail: WorkItemDetail = {
  id: '9007199254740993', typeKey: 'story', name: '开发流程', status: '开发中', statusState: 'in_progress',
  ownerKeys: ['aggregated-owner'], ownerNames: ['汇总负责人'], updatedAt: 1000, source,
  url: 'https://project.feishu.cn/project-a/story/detail/9007199254740993', description: '', fields: []
}
const other: WorkItemDetail = { ...detail, id: '9007199254740994', name: '另一项流程' }
const ref = { id: detail.id, typeKey: detail.typeKey, source, expectedUserKey: actor }
const available = { state: 'available' as const }
const unavailable = { state: 'browserOnly' as const, reason: '此操作需在飞书项目中完成' }
const doing: WorkItemNode = {
  key: 'node-development', name: '开发联调', status: 'doing', owners: [{ key: 'node-owner', name: '节点原负责人' }],
  revision: 'node-development-v1', actions: { confirm: available, rollback: unavailable, owners: available }
}
const finished: WorkItemNode = {
  key: 'node-design', name: '设计评审', status: 'finished', owners: [{ key: 'designer', name: '设计负责人' }],
  revision: 'node-design-v1', actions: { confirm: unavailable, rollback: available, owners: available }
}
const nodes: WorkItemNodeList = { state: 'available', nodes: [doing, finished] }
const warning = { type: 'Callout', label: '节点操作结果待核对' }
type Saved = { item: WorkItemDetail; outcome?: 'confirmed' | 'adopted' }

function fixture(saved: Saved[] = [], errors: unknown[] = []) {
  return {
    setup: () => resetNodes(detail, actor),
    default: () => (
      <Stack>
        <Button onPress={() => resetNodes(detail, actor)}>打开原工作项</Button>
        <Button onPress={() => resetNodes(other, actor)}>打开另一工作项</Button>
        <NodesPanel currentUserKey={actor} onSaved={async (item, outcome) => { saved.push({ item, outcome }) }} onError={async (error) => { errors.push(error) }} />
      </Stack>
    )
  }
}

function hostFor(requests: MockRequests) {
  return mockHost({ requests: {
    'meego.workflowNodes': () => nodes,
    'meego.inspectWorkflowNode': ({ nodeKey }: { nodeKey: string }) => ({ node: nodeKey === doing.key ? doing : finished }),
    'meego.getWorkItem': () => ({ item: detail }),
    ...requests
  } })
}

test('loads nodes lazily, inspects the selected target, and confirms exactly one prepared node', async () => {
  let reads = 0
  const inspected: string[] = []
  const writes: EditWorkItemNodeInput[] = []
  const saved: Saved[] = []
  const host = hostFor({
    'meego.workflowNodes': (input: unknown) => {
      assert.deepEqual(input, ref)
      reads += 1
      return { ...nodes, nodes: nodes.nodes.map((node) => ({ ...node, actions: { confirm: unavailable, rollback: unavailable, owners: unavailable } })) }
    },
    'meego.inspectWorkflowNode': (input: { nodeKey: string }) => {
      assert.deepEqual(input, { ...ref, nodeKey: doing.key })
      inspected.push(input.nodeKey)
      return { node: doing }
    },
    'meego.editWorkflowNode': (input: EditWorkItemNodeInput) => {
      writes.push(input)
      return { state: 'confirmed', item: { ...detail, updatedAt: 1100 }, nodes: { ...nodes, nodes: [{ ...doing, status: 'finished', revision: 'node-development-v2' }, finished] } }
    }
  })
  const view = await mount(fixture(saved), { host })
  try {
    assert.equal(reads, 0)
    await view.press({ text: '查看流程节点' })
    assert.equal(reads, 1)
    assert.deepEqual(inspected, [])
    assert.equal(view.find({ label: '节点操作' }), null)
    await view.press({ type: 'ListItem', label: '开发联调' })
    await view.press({ text: '准备完成节点' })
    assert.deepEqual(writes, [])
    await view.press({ text: '确认完成节点' })
    assert.deepEqual(writes, [{ ...ref, nodeKey: doing.key, expectedRevision: doing.revision, expectedUpdatedAt: 1000, operation: 'confirm' }])
    assert.equal(saved[0].outcome, 'confirmed')
    assert.equal(saved[0].item.updatedAt, 1100)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('rollback requires an explicit reason and sends the inspected node revision', async () => {
  const writes: EditWorkItemNodeInput[] = []
  const host = hostFor({ 'meego.editWorkflowNode': (input: EditWorkItemNodeInput) => {
    writes.push(input)
    return { state: 'confirmed', item: detail, nodes }
  } })
  const view = await mount(fixture(), { host })
  try {
    await view.press({ text: '查看流程节点' })
    await view.press({ type: 'ListItem', label: '设计评审' })
    await assert.rejects(() => view.press({ text: '准备回退节点' }), /disabled/)
    await view.type({ label: '回退原因' }, '  补充设计评审材料  ')
    await view.press({ text: '准备回退节点' })
    assert.deepEqual(writes, [])
    await view.press({ text: '确认回退节点' })
    assert.deepEqual(writes, [{ ...ref, nodeKey: finished.key, expectedRevision: finished.revision, expectedUpdatedAt: 1000, operation: 'rollback', reason: '补充设计评审材料' }])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

for (const outcome of ['unverified', 'timeout'] as const) {
  test(`${outcome} locks every node in its work item until readonly verification and explicit retry`, async () => {
    const writes: EditWorkItemNodeInput[] = []
    let fresh = false
    const refreshed = { ...doing, revision: 'node-development-v2' }
    const host = hostFor({
      'meego.workflowNodes': () => ({ ...nodes, nodes: [fresh ? refreshed : doing, finished] }),
      'meego.inspectWorkflowNode': ({ nodeKey }: { nodeKey: string }) => ({ node: nodeKey === doing.key ? fresh ? refreshed : doing : finished }),
      'meego.getWorkItem': () => ({ item: { ...detail, updatedAt: 2000 } }),
      'meego.editWorkflowNode': (input: EditWorkItemNodeInput) => {
        writes.push(input)
        if (writes.length === 1) {
          if (outcome === 'timeout') throw hostError('timeout', 'lost write response')
          return { state: 'unverified' }
        }
        return { state: 'confirmed', item: { ...detail, updatedAt: 3000 }, nodes }
      }
    })
    const view = await mount(fixture(), { host })
    try {
      await view.press({ text: '查看流程节点' })
      await view.press({ type: 'ListItem', label: '开发联调' })
      await view.press({ text: '准备完成节点' })
      await view.press({ text: '确认完成节点' })
      assert.notEqual(view.find(warning), null)
      await view.press({ type: 'ListItem', label: '设计评审' })
      await assert.rejects(() => view.type({ label: '回退原因' }, '不能写另一节点'), /disabled/)
      assert.equal(writes.length, 1)
      await view.press({ text: '打开另一工作项' })
      assert.equal(view.find(warning), null)
      await view.press({ text: '打开原工作项' })
      await view.press({ text: '查看流程节点' })
      assert.notEqual(view.find(warning), null)
      fresh = true
      await view.press({ text: '只读核对流程' })
      assert.equal(writes.length, 1)
      await view.press({ text: '已核对，尚未执行' })
      assert.equal(writes.length, 1)
      await view.press({ text: '准备完成节点' })
      await view.press({ text: '确认完成节点' })
      assert.deepEqual(writes[1], { ...ref, nodeKey: doing.key, expectedRevision: refreshed.revision, expectedUpdatedAt: 2000, operation: 'confirm' })
      assert.deepEqual(view.errors, [])
      assert.deepEqual(view.refusals, [])
    } finally {
      await view.unmount()
    }
  })
}

test('node assignee changes keep its own members and never use aggregated work-item owners', async () => {
  const writes: EditWorkItemNodeInput[] = []
  const host = hostFor({
    'meego.searchMembers': (input: unknown) => {
      assert.deepEqual(input, { ...ref, query: '王五' })
      return { users: [{ key: 'member-wang', name: '王五' }] }
    },
    'meego.editWorkflowNode': (input: EditWorkItemNodeInput) => {
      writes.push(input)
      return { state: 'confirmed', item: detail, nodes }
    }
  })
  const view = await mount(fixture(), { host })
  try {
    await view.press({ text: '查看流程节点' })
    await view.press({ type: 'ListItem', label: '开发联调' })
    await view.select({ label: '节点操作' }, 'owners')
    await view.type({ label: '搜索节点负责人' }, '王五', { submit: true })
    await view.press({ type: 'ListItem', label: '王五' })
    await view.press({ text: '分配给我' })
    await view.press({ text: '准备更新负责人' })
    assert.deepEqual(writes, [])
    await view.press({ text: '确认更新负责人' })
    assert.deepEqual(writes, [{ ...ref, nodeKey: doing.key, expectedRevision: doing.revision, expectedUpdatedAt: 1000, operation: 'owners', userKeys: ['node-owner', 'member-wang', actor] }])
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('adopts a freshly read workflow after uncertainty without confirming a node again', async () => {
  let writes = 0
  const saved: Saved[] = []
  const host = hostFor({
    'meego.editWorkflowNode': () => { writes += 1; return { state: 'unverified' } },
    'meego.getWorkItem': () => ({ item: { ...detail, updatedAt: 4000 } })
  })
  const view = await mount(fixture(saved), { host })
  try {
    await view.press({ text: '查看流程节点' })
    await view.press({ type: 'ListItem', label: '开发联调' })
    await view.press({ text: '准备完成节点' })
    await view.press({ text: '确认完成节点' })
    await assert.rejects(() => view.press({ text: '采用最新流程' }), /disabled/)
    await view.press({ text: '只读核对流程' })
    await view.press({ text: '采用最新流程' })
    assert.equal(writes, 1)
    assert.equal(saved[0].outcome, 'adopted')
    assert.equal(saved[0].item.updatedAt, 4000)
    assert.equal(view.find(warning), null)
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('late inspection cannot populate a different detail or account', async () => {
  let finish: (value: { node: WorkItemNode }) => void = () => {}
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const pendingNode = new Promise<{ node: WorkItemNode }>((resolve) => { finish = resolve })
  const host = hostFor({
    'meego.inspectWorkflowNode': ({ expectedUserKey }: { expectedUserKey?: string }) => {
      if (expectedUserKey === actor) { markStarted(); return pendingNode }
      return { node: { ...finished, key: doing.key, name: '新账号可见节点' } }
    }
  })
  const view = await mount(fixture(), { host })
  try {
    await view.press({ text: '查看流程节点' })
    const pending = view.press({ type: 'ListItem', label: '开发联调' })
    await started
    resetNodes(other, 'another-account')
    finish({ node: doing })
    await pending
    assert.equal(view.find({ label: '节点操作' }), null)
    await view.press({ text: '查看流程节点' })
    await view.press({ type: 'ListItem', label: '开发联调' })
    assert.notEqual(view.find({ text: '新账号可见节点' }), null)
    assert.equal(view.find({ text: '准备完成节点' }), null)
    assert.deepEqual(view.errors, [])
  } finally {
    finish({ node: doing })
    await view.unmount()
  }
})

test('state-flow and inherited assignee capabilities remain readonly with a provider link', async () => {
  let stateFlow = true
  const host = hostFor({
    'meego.workflowNodes': () => stateFlow ? ({ state: 'browserOnly', reason: '这是状态流工作项', nodes: [] }) : nodes,
    'meego.inspectWorkflowNode': () => ({ node: { ...doing, actions: { ...doing.actions, owners: { state: 'browserOnly', reason: '节点负责人继承自角色' } } } })
  })
  const view = await mount(fixture(), { host })
  try {
    await view.press({ text: '查看流程节点' })
    assert.equal(view.find({ label: '节点操作' }), null)
    assert.notEqual(view.find({ text: '在飞书项目中查看流程' }), null)
    stateFlow = false
    await view.press({ text: '刷新流程节点' })
    await view.press({ type: 'ListItem', label: '开发联调' })
    await view.select({ label: '节点操作' }, 'owners')
    assert.equal(view.find({ label: '搜索节点负责人' }), null)
    assert.notEqual(view.find({ text: '节点负责人继承自角色' }), null)
    assert.notEqual(view.find({ text: '在飞书项目中操作节点' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
