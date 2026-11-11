import { assert, hostError, mockHost, mount, test, type MockRequests } from 'orca/testing'
import * as panel from './panel'
import type { CreateWorkItemInput, WorkItemDetail, EditWorkItemInput, EditWorkItemNodeInput, WorkItemNode, WorkItemId } from './protocol'

const source = { baseUrl: 'https://project.feishu.cn', projectKey: 'demo' }
const detail: WorkItemDetail = {
  id: 6801, typeKey: 'story', name: '验证登录', status: '', statusState: 'unknown',
  ownerKeys: [], ownerNames: [], updatedAt: null, source,
  url: 'https://project.feishu.cn/demo/story/detail/6801', description: '', fields: []
}
const other = { ...detail, id: 6802, name: '验证评论', url: 'https://project.feishu.cn/demo/story/detail/6802' }
const createWarning = { type: 'Callout', label: '创建结果待核对' }
const commentWarning = { type: 'Callout', label: '评论发布结果待核对' }

function writeHost(requests: MockRequests) {
  return mockHost({
    requests: {
      'meego.status': () => ({ ...source, userKey: 'demo-user', configured: true, missing: [] }),
      'meego.listTypes': () => ({ types: [{ key: 'story', name: '需求' }] }),
      'meego.listWorkItems': () => ({ items: [detail, other], total: 2, page: 1, hasMore: false, fromCache: false }),
      'meego.workspaceContext': () => ({ workspaceId: null, displayName: null, branch: null, link: null, branchChanged: false, agents: [] }),
      'meego.createForm': () => ({ form: { templates: [{ id: 'standard', name: '标准模板' }], fields: [], unsupportedRequired: [] } }),
      'meego.getWorkItem': ({ id }: { id: WorkItemId }) => ({ item: id === detail.id ? detail : other }),
      'meego.listComments': () => ({ comments: [], hasMore: false }),
      ...requests
    }
  })
}

test('unverified creation keeps the draft and blocks button and Enter until acknowledged', async () => {
  const writes: CreateWorkItemInput[] = []
  const host = writeHost({
    'meego.createWorkItem': (input: CreateWorkItemInput) => {
      writes.push(input)
      if (writes.length === 1) return { state: 'unverified' }
      return { item: detail }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '新建工作项' })
    await view.type({ label: '标题' }, '验证登录')
    await view.type({ label: '描述' }, '这段内容应保留')
    await view.press({ text: '创建' })
    assert.notEqual(view.find(createWarning), null)
    assert.notEqual(view.find({ text: '在飞书项目中核对' }), null)
    await assert.rejects(() => view.press({ text: '创建' }), /disabled/)
    await assert.rejects(() => view.submit({ label: '标题' }), /disabled/)
    assert.equal(writes.length, 1)
    await view.press({ label: '新建工作项' })
    assert.notEqual(view.find(createWarning), null)
    await view.press({ text: '已核对，尚未创建' })
    assert.equal(writes.length, 1)
    await view.submit({ label: '标题' })
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[1], writes[0])
    assert.notEqual(view.find({ text: '#6801 验证登录' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('timed-out comment is scoped to its detail and stays locked through refresh and navigation', async () => {
  const writes: string[] = []
  let reads = 0
  const host = writeHost({
    'meego.listComments': () => {
      reads += 1
      return { comments: [], hasMore: false }
    },
    'meego.addComment': ({ content }: { content: string }) => {
      writes.push(content)
      throw hostError('timeout', 'meego.addComment timed out')
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.activateRow({ label: '工作项列表' }, '6801')
    await view.press({ text: '查看评论' })
    await view.type({ label: '评论内容' }, '请保留这条评论')
    await view.press({ text: '发布评论' })
    assert.notEqual(view.find(commentWarning), null)
    await view.press({ text: '刷新评论' })
    assert.equal(reads, 2)
    await assert.rejects(() => view.press({ text: '发布评论' }), /disabled/)
    assert.deepEqual(writes, ['请保留这条评论'])

    await view.press({ label: '返回列表' })
    await view.activateRow({ label: '工作项列表' }, '6802')
    await view.press({ text: '查看评论' })
    assert.equal(view.find(commentWarning), null)
    await view.press({ label: '返回列表' })
    await view.activateRow({ label: '工作项列表' }, '6801')
    assert.notEqual(view.find({ text: '有一条评论待核对' }), null)
    await view.press({ text: '查看评论' })
    assert.notEqual(view.find(commentWarning), null)
    await assert.rejects(() => view.press({ text: '发布评论' }), /disabled/)
    await view.press({ text: '已核对，尚未发布' })
    assert.equal(writes.length, 1)
    await view.press({ text: '发布评论' })
    assert.deepEqual(writes, ['请保留这条评论', '请保留这条评论'])
    assert.notEqual(view.find(commentWarning), null)
    await view.press({ text: '丢弃草稿' })
    assert.equal(view.find(commentWarning), null)
    await assert.rejects(() => view.press({ text: '发布评论' }), /disabled/)
    assert.equal(writes.length, 2)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('a definitive creation rejection leaves the draft ready to edit and submit', async () => {
  const titles: string[] = []
  const host = writeHost({
    'meego.createWorkItem': ({ name }: CreateWorkItemInput) => {
      titles.push(name)
      if (titles.length === 1) throw hostError('invalid_input', '飞书项目拒绝了标题')
      return { item: detail }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '新建工作项' })
    await view.type({ label: '标题' }, '需要修改')
    await view.press({ text: '创建' })
    assert.notEqual(view.find({ text: '飞书项目拒绝了标题' }), null)
    assert.equal(view.find(createWarning), null)
    await view.type({ label: '标题' }, '验证登录', { replace: true, submit: true })
    assert.deepEqual(titles, ['需要修改', '验证登录'])
    assert.notEqual(view.find({ text: '#6801 验证登录' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('a confirmed creation without an ID closes the form and returns to the refreshed list', async () => {
  const host = writeHost({ 'meego.createWorkItem': () => ({ state: 'confirmed' }) })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.press({ label: '新建工作项' })
    await view.type({ label: '标题' }, '服务已确认的工作项')
    await view.press({ text: '创建' })
    assert.equal(view.find(createWarning), null)
    assert.equal(view.find({ label: '标题' }), null)
    assert.notEqual(view.find({ label: '工作项列表' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})


test('field and node saves share the latest detail version while preserving an unsent comment', async () => {
  const original = { ...detail, updatedAt: 1000 }
  const renamed = { ...original, name: '已补全登录流程', updatedAt: 1100 }
  const completed = { ...renamed, updatedAt: 1200 }
  const node: WorkItemNode = {
    key: 'development', name: '开发联调', status: 'doing', owners: [], revision: 'a'.repeat(64),
    actions: { confirm: { state: 'available' }, rollback: { state: 'browserOnly' }, owners: { state: 'browserOnly' } }
  }
  const fields: EditWorkItemInput[] = []
  const nodes: EditWorkItemNodeInput[] = []
  const comments: unknown[] = []
  const host = writeHost({
    'meego.getWorkItem': () => ({ item: original }),
    'meego.editOptions': () => ({ options: {
      text: { title: { state: 'available' }, description: { state: 'available' } },
      priority: { state: 'browserOnly', currentKey: null, options: [] },
      status: { state: 'browserOnly', currentKey: null, transitions: [] },
      operators: { state: 'browserOnly', userKeys: [], users: [], multiple: false }
    } }),
    'meego.editWorkItem': (input: EditWorkItemInput) => { fields.push(input); return { state: 'confirmed', item: renamed } },
    'meego.workflowNodes': () => ({ state: 'available', nodes: [node] }),
    'meego.inspectWorkflowNode': () => ({ node }),
    'meego.editWorkflowNode': (input: EditWorkItemNodeInput) => {
      nodes.push(input)
      return { state: 'confirmed', item: completed, nodes: { state: 'available', nodes: [{ ...node, status: 'finished' }] } }
    },
    'meego.addComment': (input: unknown) => { comments.push(input); return { ok: true } }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'meego.viewMode': 'table' } } })
  try {
    await panel.initialLoad
    await view.activateRow({ label: '工作项列表' }, '6801')
    await view.press({ text: '查看评论' })
    await view.type({ label: '评论内容' }, '这条未发送评论必须保留')
    await view.press({ type: 'Button', text: '编辑工作项' })
    await view.type({ label: '工作项标题' }, '已补全登录流程', { replace: true })
    await view.press({ text: '保存更改' })
    assert.deepEqual(fields, [{ id: 6801, typeKey: 'story', source, expectedUserKey: 'demo-user', expectedUpdatedAt: 1000, operation: 'name', value: '已补全登录流程' }])
    await view.press({ text: '查看流程节点' })
    await view.press({ type: 'ListItem', label: '开发联调' })
    await view.press({ text: '准备完成节点' })
    await view.press({ text: '确认完成节点' })
    assert.deepEqual(nodes, [{ id: 6801, typeKey: 'story', source, expectedUserKey: 'demo-user', expectedUpdatedAt: 1100, nodeKey: 'development', expectedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', operation: 'confirm' }])
    await view.press({ text: '发布评论' })
    assert.deepEqual(comments, [{ id: 6801, typeKey: 'story', source, expectedUserKey: 'demo-user', content: '这条未发送评论必须保留' }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})
