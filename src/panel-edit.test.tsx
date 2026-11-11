import { Button, Stack } from 'orca'
import { assert, hostError, mockHost, mount, test, type MockRequests } from 'orca/testing'
import { EditPanel, resetEdit } from './panel-edit'
import type { EditWorkItemInput, EditWorkItemOutput, WorkItemDetail, WorkItemEditOptions, WorkItemReference } from './protocol'

const actor = 'actor-user'
const source = { baseUrl: 'https://project.feishu.cn', projectKey: 'demo' }
const detail: WorkItemDetail = {
  id: '9007199254740993', typeKey: 'story', name: '验证登录', status: '开发中', statusState: 'in_progress',
  ownerKeys: ['reporter'], ownerNames: ['报告人'], updatedAt: 1000, source,
  url: 'https://project.feishu.cn/demo/story/detail/9007199254740993', description: '现有描述', fields: []
}
const other: WorkItemDetail = { ...detail, id: '9007199254740994', name: '另一工作项', updatedAt: 2000 }
const options: WorkItemEditOptions = {
  text: { title: { state: 'available' }, description: { state: 'available' } },
  priority: { state: 'available', currentKey: 'p2', options: [{ key: 'p2', label: '普通' }, { key: 'p1', label: '紧急' }] },
  status: { state: 'available', currentKey: 'doing', transitions: [{ id: 'transition-ready-review', label: '进入评审', targetStateKey: 'review' }] },
  operators: { state: 'available', userKeys: ['current-operator'], users: [{ key: 'current-operator', name: '当前经办人' }], multiple: true }
}
const ref = { id: detail.id, typeKey: detail.typeKey, source, expectedUserKey: actor }
const warning = { type: 'Callout', label: '保存结果待核对' }

type Saved = { item: WorkItemDetail; outcome?: 'confirmed' | 'adopted' }

function fixture(saved: Saved[] = [], errors: unknown[] = []) {
  return {
    setup: () => resetEdit(detail, actor),
    default: () => (
      <Stack>
        <Button onPress={() => resetEdit(detail, actor)}>打开原工作项</Button>
        <Button onPress={() => resetEdit(other, actor)}>打开另一工作项</Button>
        <EditPanel currentUserKey={actor} onSaved={async (item, outcome) => { saved.push({ item, outcome }) }} onError={async (error) => { errors.push(error) }} />
      </Stack>
    )
  }
}

function hostFor(requests: MockRequests) {
  return mockHost({ requests: {
    'meego.editOptions': () => ({ options }),
    'meego.getWorkItem': () => ({ item: detail }),
    ...requests
  } })
}

test('saves one real status transition with the original account, source and detail version', async () => {
  const writes: EditWorkItemInput[] = []
  const saved: Saved[] = []
  const host = hostFor({
    'meego.editWorkItem': (input: EditWorkItemInput) => {
      writes.push(input)
      return { state: 'confirmed', item: { ...detail, status: '评审中', updatedAt: 1100 } }
    }
  })
  const view = await mount(fixture(saved), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.select({ label: '编辑字段' }, 'status')
    await view.select({ label: '目标状态' }, 'transition-ready-review')
    await view.press({ text: '保存更改' })
    assert.deepEqual(writes, [{ ...ref, expectedUpdatedAt: 1000, operation: 'status', transitionId: 'transition-ready-review' }])
    assert.equal(saved[0].item.status, '评审中')
    assert.equal(saved[0].outcome, 'confirmed')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('ignores edit options that arrive after switching to another detail', async () => {
  let resolveOptions: (value: { options: WorkItemEditOptions }) => void = () => {}
  const oldOptions = new Promise<{ options: WorkItemEditOptions }>((resolve) => { resolveOptions = resolve })
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const host = hostFor({
    'meego.editOptions': ({ id }: WorkItemReference) => {
      if (id === detail.id) { markStarted(); return oldOptions }
      return { options: {
      ...options, priority: { state: 'available', currentKey: 'new-low', options: [{ key: 'new-low', label: '新低级' }, { key: 'new-high', label: '新高级' }] }
      } }
    },
    'meego.editWorkItem': (input: EditWorkItemInput) => {
      assert.deepEqual(input, { ...ref, id: other.id, expectedUpdatedAt: other.updatedAt, operation: 'priority', value: 'new-high' })
      return { state: 'confirmed', item: other }
    }
  })
  const view = await mount(fixture(), { host })
  try {
    const pending = view.press({ text: '编辑工作项', type: 'Button' })
    await started
    resetEdit(other, actor)
    resolveOptions({ options })
    await pending
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.select({ label: '编辑字段' }, 'priority')
    await view.select({ label: '优先级' }, 'new-high')
    await view.press({ text: '保存更改' })
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    resolveOptions({ options })
    await view.unmount()
  }
})

for (const outcome of ['unverified', 'timeout'] as const) {
  test(`${outcome} locks only its target through refresh and navigation until explicitly acknowledged`, async () => {
    const writes: EditWorkItemInput[] = []
    let reads = 0
    const host = hostFor({
      'meego.editWorkItem': (input: EditWorkItemInput) => {
        writes.push(input)
        if (writes.length === 1) {
          if (outcome === 'timeout') throw hostError('timeout', 'lost reply')
          return { state: 'unverified' }
        }
        return { state: 'confirmed', item: { ...detail, name: '保留新标题', updatedAt: 1200 } }
      },
      'meego.getWorkItem': (input: unknown) => {
        assert.deepEqual(input, ref)
        reads += 1
        return { item: { ...detail, updatedAt: 1150 } }
      }
    })
    const view = await mount(fixture(), { host })
    try {
      await view.press({ text: '编辑工作项', type: 'Button' })
      await view.type({ label: '工作项标题' }, '保留新标题', { replace: true })
      await view.press({ text: '保存更改' })
      assert.notEqual(view.find(warning), null)
      await assert.rejects(() => view.press({ text: '保存更改' }), /disabled/)
      await view.press({ text: '刷新回读' })
      assert.equal(reads, 1)
      await assert.rejects(() => view.press({ text: '保存更改' }), /disabled/)
      await view.press({ text: '打开另一工作项' })
      assert.equal(view.find(warning), null)
      await view.press({ text: '打开原工作项' })
      await view.press({ text: '编辑工作项', type: 'Button' })
      assert.notEqual(view.find(warning), null)
      await view.press({ text: '刷新回读' })
      await view.press({ text: '已核对，尚未保存' })
      assert.equal(writes.length, 1)
      await view.press({ text: '保存更改' })
      assert.equal(writes.length, 2)
      assert.deepEqual(writes[1], { ...ref, operation: 'name', value: '保留新标题', expectedUpdatedAt: 1150 })
      assert.deepEqual(view.errors, [])
      assert.deepEqual(view.refusals, [])
    } finally {
      await view.unmount()
    }
  })
}

test('computed current operators remain readonly even when an older host advertises them as editable', async () => {
  const host = hostFor({})
  const view = await mount(fixture(), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.select({ label: '编辑字段' }, 'operators')
    assert.equal(view.find({ label: '搜索负责人' }), null)
    assert.equal(view.find({ text: '保存更改' }), null)
    assert.notEqual(view.find({ text: '打开飞书项目' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('adopting a fresh readback resolves uncertainty without repeating the edit', async () => {
  let writes = 0
  const saved: Saved[] = []
  const fresh = { ...detail, name: '服务端新标题', updatedAt: 1300 }
  const host = hostFor({
    'meego.editWorkItem': () => { writes += 1; return { state: 'unverified' } },
    'meego.getWorkItem': () => ({ item: fresh })
  })
  const view = await mount(fixture(saved), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.type({ label: '工作项标题' }, '服务端新标题', { replace: true })
    await view.press({ text: '保存更改' })
    await assert.rejects(() => view.press({ text: '采用回读结果' }), /disabled/)
    await view.press({ text: '刷新回读' })
    await view.press({ text: '采用回读结果' })
    assert.equal(writes, 1)
    assert.deepEqual(saved, [{ item: fresh, outcome: 'adopted' }])
    assert.equal(view.find(warning), null)
    assert.deepEqual(view.errors, [])
  } finally {
    await view.unmount()
  }
})

test('a confirmed edit that returns after navigation cannot replace the new detail', async () => {
  let finishWrite: (value: EditWorkItemOutput) => void = () => {}
  const response = new Promise<EditWorkItemOutput>((resolve) => { finishWrite = resolve })
  const saved: Saved[] = []
  let markStarted = () => {}
  const started = new Promise<void>((resolve) => { markStarted = resolve })
  const host = hostFor({ 'meego.editWorkItem': () => { markStarted(); return response } })
  const view = await mount(fixture(saved), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.type({ label: '工作项标题' }, '迟到的新标题', { replace: true })
    const pending = view.press({ text: '保存更改' })
    await started
    resetEdit(other, actor)
    finishWrite({ state: 'confirmed', item: { ...detail, name: '迟到的新标题' } })
    await pending
    assert.deepEqual(saved, [])
    await view.press({ text: '编辑工作项', type: 'Button' })
    assert.notEqual(view.find({ label: '工作项标题' }), null)
    assert.deepEqual(view.errors, [])
  } finally {
    finishWrite({ state: 'unverified' })
    await view.unmount()
  }
})

test('browser-only status and denied metadata never expose a writable status control', async () => {
  let denied = false
  const errors: unknown[] = []
  const host = hostFor({
    'meego.editOptions': () => {
      if (denied) throw hostError('permission_denied', '无权编辑此工作项')
      return { options: { ...options, status: { ...options.status, state: 'browserOnly', reason: '此流转需要补充节点字段' } } }
    }
  })
  const view = await mount(fixture([], errors), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.select({ label: '编辑字段' }, 'status')
    assert.equal(view.find({ label: '目标状态' }), null)
    assert.notEqual(view.find({ text: '此流转需要补充节点字段' }), null)
    assert.notEqual(view.find({ text: '打开飞书项目' }), null)
    denied = true
    await view.press({ text: '打开另一工作项' })
    await view.press({ text: '编辑工作项', type: 'Button' })
    assert.notEqual(view.find({ text: '无权编辑此工作项' }), null)
    assert.equal(errors.length, 1)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})


const roleOptions: NonNullable<WorkItemEditOptions['roles']> = {
  state: 'available',
  options: [
    { key: 'role-product-lead', label: '产品负责人', userKeys: ['product-original', 'product-retained'], users: [
      { key: 'product-original', name: '产品原成员' }, { key: 'product-retained', name: '产品保留成员' }
    ] },
    { key: 'role-engineering-lead', label: '研发负责人', userKeys: ['engineer-original'], users: [
      { key: 'engineer-original', name: '研发原成员' }
    ] }
  ]
}

test('role membership writes the explicitly chosen role and reads back that role after uncertainty', async () => {
  const writes: EditWorkItemInput[] = []
  let updated = false
  const optionsForRole = () => ({
    ...options,
    roles: updated ? { ...roleOptions, options: [
      { ...roleOptions.options[0], userKeys: ['product-retained', 'member-wang', actor], users: [
        { key: 'product-retained', name: '产品保留成员' }, { key: 'member-wang', name: '王五' }, { key: actor, name: '当前账号' }
      ] }, roleOptions.options[1]
    ] } : roleOptions
  })
  const saved: Saved[] = []
  const host = hostFor({
    'meego.editOptions': () => ({ options: optionsForRole() }),
    'meego.searchMembers': (input: unknown) => {
      assert.deepEqual(input, { ...ref, query: '王五' })
      return { users: [{ key: 'member-wang', name: '王五' }] }
    },
    'meego.editWorkItem': (input: EditWorkItemInput) => {
      writes.push(input)
      updated = true
      return { state: 'unverified' }
    }
  })
  const view = await mount(fixture(saved), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.select({ label: '编辑字段' }, 'roleMembers')
    assert.equal(view.find({ label: '搜索角色成员' }), null)
    await assert.rejects(() => view.press({ text: '保存更改' }), /disabled/)
    await view.select({ label: '选择角色' }, 'role-product-lead')
    await view.press({ type: 'ListItem', label: '产品原成员' })
    await view.type({ label: '搜索角色成员' }, '王五', { submit: true })
    await view.press({ type: 'ListItem', label: '王五' })
    await view.press({ text: '分配给我' })
    await view.select({ label: '编辑字段' }, 'name')
    await view.select({ label: '编辑字段' }, 'roleMembers')
    assert.notEqual(view.find({ type: 'ListItem', label: '王五' }), null)
    await view.press({ text: '保存更改' })
    assert.deepEqual(writes, [{
      ...ref, expectedUpdatedAt: 1000, operation: 'roleMembers', roleKey: 'role-product-lead',
      userKeys: ['product-retained', 'member-wang', actor]
    }])
    await assert.rejects(() => view.select({ label: '选择角色' }, 'role-engineering-lead'), /disabled/)
    await view.press({ text: '刷新回读' })
    const rendered = JSON.stringify(view.tree())
    assert.match(rendered, /"label":"角色","value":"产品负责人"/)
    assert.match(rendered, /"label":"角色成员","value":"产品保留成员、王五、当前账号"/)
    await view.press({ text: '采用回读结果' })
    assert.equal(writes.length, 1)
    assert.equal(saved[0].outcome, 'adopted')
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('switching roles clears the previous search and never carries its selected members into another role', async () => {
  const writes: EditWorkItemInput[] = []
  const host = hostFor({
    'meego.editOptions': () => ({ options: { ...options, roles: roleOptions } }),
    'meego.searchMembers': () => ({ users: [{ key: 'product-search-result', name: '产品搜索成员' }] }),
    'meego.editWorkItem': (input: EditWorkItemInput) => {
      writes.push(input)
      return { state: 'confirmed', item: detail }
    }
  })
  const view = await mount(fixture(), { host })
  try {
    await view.press({ text: '编辑工作项', type: 'Button' })
    await view.select({ label: '编辑字段' }, 'roleMembers')
    await view.select({ label: '选择角色' }, 'role-product-lead')
    await view.type({ label: '搜索角色成员' }, '产品', { submit: true })
    await view.press({ type: 'ListItem', label: '产品搜索成员' })
    await view.select({ label: '选择角色' }, 'role-engineering-lead')
    assert.equal(view.find({ type: 'ListItem', label: '产品搜索成员' }), null)
    assert.equal(view.find({ type: 'ListItem', label: '产品原成员' }), null)
    await assert.rejects(() => view.press({ text: '搜索成员' }), /disabled/)
    await view.press({ text: '分配给我' })
    await view.press({ text: '保存更改' })
    assert.deepEqual(writes, [{
      ...ref, expectedUpdatedAt: 1000, operation: 'roleMembers', roleKey: 'role-engineering-lead',
      userKeys: ['engineer-original', actor]
    }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
