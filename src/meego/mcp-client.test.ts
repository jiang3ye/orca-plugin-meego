import { assert, test } from 'orca/testing'
import { MeegoApiError, type FetchLike, type FetchResponse } from './client'
import type { MeegoConfig } from './config'
import { MeegoMcpClient } from './mcp-client'

const config: MeegoConfig = {
  baseUrl: 'https://project.feishu.cn', projectKey: 'proj_key', userKey: 'user-a',
  pluginId: '', pluginSecret: '', agentCommand: 'codex', webUrlTemplate: ''
}

interface ToolRequest {
  id: number
  method: string
  params: { name: string; arguments: Record<string, unknown> }
}

function result(id: number, data: unknown): FetchResponse {
  return toolResponse(id, { content: [{ type: 'text', text: JSON.stringify(data) }, { type: 'text', text: 'log_id:mock' }] })
}

function toolResponse(id: number, result: unknown): FetchResponse {
  return {
    ok: true, status: 200, statusText: 'OK',
    text: async () => JSON.stringify({ jsonrpc: '2.0', id, result })
  }
}

function clientWith(handler: (request: ToolRequest) => unknown, clientConfig = config) {
  const calls: ToolRequest['params'][] = []
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, 'https://project.feishu.cn/mcp_server/v1')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
    const request = JSON.parse(String(init?.body)) as ToolRequest
    assert.equal(request.method, 'tools/call')
    calls.push(request.params)
    return result(request.id, handler(request))
  }
  return { client: new MeegoMcpClient({ config: clientConfig, token: async () => 'access', fetchImpl }), calls }
}

test('MCP resolves the logged-in user and page of accessible spaces', async () => {
  const { client, calls } = clientWith(({ params }) => params.name === 'search_user_info'
    ? [{ user_key: 'user-a', name_cn: '张三', name_en: 'San Zhang' }]
    : { list: [{ project_key: 'abc123', project_name: '工作台', simple_name: 'support' }], pagination: { total: 3, page_size: 1 } })
  assert.deepEqual(await client.currentUser(), { key: 'user-a', name: '张三' })
  assert.deepEqual(await client.listSpaces(undefined, 2), {
    spaces: [{ key: 'abc123', name: '工作台', slug: 'support' }], hasMore: true
  })
  assert.deepEqual(calls, [
    { name: 'search_user_info', arguments: { user_keys: ['current_login_user()'] } },
    { name: 'search_project_info', arguments: { page_num: 2 } }
  ])
})

test('MCP searches the accessible catalog by name, slug and key across sparse pages', async () => {
  const { client, calls } = clientWith(({ params: { arguments: args } }) => {
    const page = args.page_num
    if (page === 1) {
      return { list: [{ project_key: 'project-other', project_name: '其他空间' }], has_more: true }
    }
    if (page === 2 || page === 3) return { list: [], has_more: true }
    return {
      list: [{ project_key: 'abc-123', project_name: '示例团队-数据需求', simple_name: 'example-data' }],
      has_more: false
    }
  })
  const match = { spaces: [{ key: 'abc-123', name: '示例团队-数据需求', slug: 'example-data' }], hasMore: false }
  await client.listSpaces()
  assert.deepEqual(await client.listSpaces(' 示例团队数据 '), match)
  assert.deepEqual(await client.listSpaces('ＥＸＡＭＰＬＥ＿ＤＡＴＡ'), match)
  assert.deepEqual(await client.listSpaces('ABC123'), match)
  assert.deepEqual(await client.listSpaces('没有这个项目'), { spaces: [], hasMore: false })
  assert.deepEqual(calls, [1, 2, 3, 4].map((page_num) => ({ name: 'search_project_info', arguments: { page_num } })))
})

test('MCP paginates filtered matches without duplicates or missing rows', async () => {
  const { client, calls } = clientWith(({ params: { arguments: args } }) => {
    const page = Number(args.page_num)
    const start = [1, 30, 60][page - 1]
    const list = Array.from({ length: page < 3 ? 30 : 2 }, (_, index) => ({
      project_key: `key-${start + index}`, project_name: `研发空间 ${start + index}`
    }))
    return { list, pagination: { total: 62, page_size: 30 } }
  })
  const first = await client.listSpaces('研发')
  const second = await client.listSpaces('研发', 2)
  assert.equal(first.hasMore, true)
  assert.equal(second.hasMore, false)
  assert.deepEqual(first.spaces.map(({ key }) => key), Array.from({ length: 50 }, (_, index) => `key-${index + 1}`))
  assert.deepEqual(second.spaces.map(({ key }) => key), Array.from({ length: 11 }, (_, index) => `key-${index + 51}`))
  assert.deepEqual(calls.map(({ arguments: args }) => args), [1, 2, 3].map((page_num) => ({ page_num })))
})

test('MCP resolves pasted-link space slugs with an exact provider lookup', async () => {
  const { client, calls } = clientWith(({ params: { arguments: args } }) => {
    if (args.project_key === 'missing') return null
    return { list: [{ project_key: 'abc123', project_name: '工作台', simple_name: 'support' }] }
  })
  assert.deepEqual(await client.findSpaceBySlug('support'), { key: 'abc123', name: '工作台', slug: 'support' })
  assert.equal(await client.findSpaceBySlug('supp-ort'), null)
  assert.equal(await client.findSpaceBySlug('missing'), null)
  assert.deepEqual(calls, ['support', 'supp-ort', 'missing'].map((project_key) => ({
    name: 'search_project_info', arguments: { project_key, page_num: 1 }
  })))
})

test('MCP uses the MQL session for page two and keeps search literals escaped', async () => {
  const row = (id: number) => ({ moql_field_list: [
    { key: 'work_item_id', value: { long_value: id } },
    { key: 'name', value: { string_value: '发布说明' } },
    { key: 'work_item_status', value: { key_label_value_list: [{ key: 'processing', label: '进行中' }] } },
    { key: 'current_status_operator', value: { user_value_list: [{ user_key: 'user-a' }] } },
    { key: 'updated_at', value: { string_value: '2026-06-01T00:00:00Z' } }
  ] })
  const { client, calls } = clientWith(({ params }) => params.arguments.session_id
    ? { list: null, session_id: null, data: { '1': [row(1235)] } }
    : { list: [{ count: 53, group_infos: [{ group_id: '1' }] }], session_id: 'query-1', data: { '1': [row(1234)] } })
  const input = { typeKey: 'story', pageNum: 1, pageSize: 50, search: "O'Neil_%", userKeys: ['user-a'] }
  const first = await client.filterWorkItems(input)
  const second = await client.filterWorkItems({ ...input, pageNum: 2 })
  assert.equal(first.total, 53)
  assert.equal(first.items[0].id, 1234)
  assert.equal(first.items[0].status, '进行中')
  assert.equal(first.items[0].updatedAt, Date.parse('2026-06-01T00:00:00Z'))
  assert.deepEqual(first.items[0].ownerKeys, ['user-a'])
  assert.equal(second.total, 53)
  assert.equal(second.items[0].id, 1235)
  assert.match(String(calls[0].arguments.mql), /LIKE '%O''Neil\\_\\%%'/)
  assert.match(String(calls[0].arguments.mql), /array_contains\(`current_status_operator`, current_login_user\(\)\)/)
  assert.deepEqual(calls[1], {
    name: 'search_by_mql', arguments: { project_key: 'proj_key', session_id: 'query-1', group_pagination_list: [{ group_id: '1', page_num: 2 }] }
  })
})

test('MCP pages and caches status options by work item type and excludes terminated states', async () => {
  const { client, calls } = clientWith(({ params: { arguments: args } }) => {
    if (args.page_num === 1) return { list: [{ field_key: 'work_item_status', option: [
      { option_id: 'systemEnded', option_name: '已终止' },
      { option_id: `${args.work_item_type}-open`, option_name: '待处理' },
      { option_id: 'disabled', option_name: '停用状态', disabled: true }
    ] }], pagination: { has_more: true } }
    return { list: [{ field_key: 'work_item_status', option: [{ option_id: `${args.work_item_type}-done`, option_name: '已处理' }] }], pagination: { has_more: false } }
  })
  const options = await client.statusOptions('story')
  assert.deepEqual(options, [{ key: 'story-open', label: '待处理' }, { key: 'story-done', label: '已处理' }])
  options[0].key = 'mutated'
  assert.equal((await client.statusOptions('story'))[0].key, 'story-open')
  assert.equal((await client.statusOptions('issue'))[0].key, 'issue-open')
  assert.deepEqual(calls.map(({ name, arguments: args }) => [name, args.work_item_type, args.field_keys, args.page_num]), [
    ['list_workitem_field_config', 'story', ['work_item_status'], 1],
    ['list_workitem_field_config', 'story', ['work_item_status'], 2],
    ['list_workitem_field_config', 'issue', ['work_item_status'], 1],
    ['list_workitem_field_config', 'issue', ['work_item_status'], 2]
  ])
})

test('MCP keeps validated status filters in the MQL session and rejects unknown values', async () => {
  const { client, calls } = clientWith(({ params }) => {
    if (params.name === 'list_workitem_field_config') return { list: [{ field_key: 'work_item_status', option: [
      { option_id: "O'PEN", option_name: '待处理' }, { option_id: 'CLOSED', option_name: '已处理' }
    ] }], pagination: { has_more: false } }
    if (params.arguments.session_id) return { list: null, group_infos: [{ group_id: '1', items: [] }] }
    return { list: [{ count: 60, group_infos: [{ group_id: '1', items: [] }] }], session_id: String(params.arguments.mql).includes('CLOSED') ? 'closed-session' : 'open-session' }
  })
  const input = { typeKey: 'story', pageNum: 1, pageSize: 50, search: '登录', userKeys: ['user-a'], statusKeys: ["O'PEN"] }
  await client.filterWorkItems(input)
  await client.filterWorkItems({ ...input, statusKeys: ['CLOSED'] })
  await client.filterWorkItems({ ...input, pageNum: 2 })
  const queries = calls.filter(({ name }) => name === 'search_by_mql')
  assert.match(String(queries[0].arguments.mql), /`work_item_status` IN \('<id:O''PEN>'\)/)
  assert.match(String(queries[0].arguments.mql), /`name` LIKE '%登录%' AND array_contains/)
  assert.match(String(queries[0].arguments.mql), /ORDER BY `updated_at` DESC$/)
  assert.equal(queries[2].arguments.session_id, 'open-session')
  const count = calls.length
  await assert.rejects(() => client.filterWorkItems({ ...input, statusKeys: ['unknown'] }), /状态选项已变化/)
  await assert.rejects(() => client.filterWorkItems({ ...input, statusKeys: ['systemEnded'] }), /已终止工作项需要单独查询/)
  assert.equal(calls.length, count)
})

test('MCP recognizes the live empty-search envelope and does not request another page', async () => {
  const { client, calls } = clientWith(() => ({
    list: null, data: {}, session_id: 'empty-query', search_status_info: null, extra_info: null
  }))
  const params = { typeKey: 'issue', pageSize: 50, search: 'Fixture search title' }
  assert.deepEqual(await client.filterWorkItems({ ...params, pageNum: 1 }), { items: [], total: 0 })
  assert.deepEqual(await client.filterWorkItems({ ...params, pageNum: 2 }), { items: [], total: 0 })
  assert.equal(calls.length, 1)
  const malformed = clientWith(() => ({})).client
  await assert.rejects(() => malformed.filterWorkItems({ ...params, pageNum: 1 }), /没有返回工作项列表/)
})

test('MCP normalizes details and retains the official canonical URL', async () => {
  const { client, calls } = clientWith(() => ({
    work_item_attribute: {
      work_item_id: '1234', work_item_name: '发布说明', owned_project: { key: 'proj_key', simple_name: 'team' },
      work_item_type: { key: 'story', name: '需求' }, work_item_status: { key: 'progress', name: '实施中' }
    },
    work_item_current_node: [{ owners: [{ key: 'user-a', name: '张三' }] }],
    work_item_fields: [{ key: 'description', name: '描述', type: 'multi_text', value: { markdown: '## 操作步骤' } }]
  }))
  const item = await client.getWorkItem(1234, 'story')
  assert.equal(item?.url, 'https://project.feishu.cn/team/story/detail/1234')
  assert.equal(item?.name, '发布说明')
  assert.equal(item?.description, '## 操作步骤')
  assert.equal(item?.status, '实施中')
  assert.deepEqual(item?.ownerKeys, ['user-a'])
  assert.deepEqual(calls, [{ name: 'get_workitem_brief', arguments: { project_key: 'proj_key', work_item_id: '1234' } }])
})

test('MCP retains raw int64 IDs in MQL, canonical links and comment requests', async () => {
  const workItemId = '9223372036854775807'
  const adjacentId = '9223372036854775806'
  const calls: ToolRequest['params'][] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as ToolRequest
    calls.push(request.params)
    let body: string
    if (request.params.name === 'search_by_mql') {
      const payload = `[{"work_item_id":${workItemId},"name":"大编号工作项"}]`
      body = JSON.stringify({
        jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: payload }] }
      })
    } else if (request.params.name === 'get_workitem_brief') {
      body = `{"jsonrpc":"2.0","id":${request.id},"result":{"structuredContent":{"work_item_attribute":{"work_item_id":${workItemId},"owned_project":{"key":"proj_key","simple_name":"team"}}}}}`
    } else {
      body = `{"jsonrpc":"2.0","id":${request.id},"result":{"structuredContent":{"comments":[{"comment_id":${adjacentId},"content":"第一条"},{"comment_id":${workItemId},"content":"第二条"}]}}}`
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => body }
  }
  const client = new MeegoMcpClient({ config, token: async () => 'access', fetchImpl })

  const { items } = await client.filterWorkItems({ typeKey: 'story', pageNum: 1, pageSize: 50, search: `#${workItemId}` })
  assert.equal(items[0].id, workItemId)
  assert.ok(String(calls[0].arguments.mql).includes(`work_item_id\` = ${workItemId}`))
  const detail = await client.getWorkItem(workItemId, 'story')
  assert.equal(detail?.id, workItemId)
  assert.equal(detail?.url, `https://project.feishu.cn/team/story/detail/${workItemId}`)
  assert.equal(await client.getWorkItem(adjacentId, 'story'), null)
  const { comments } = await client.listComments('story', workItemId, 1)
  assert.deepEqual(comments.map(({ id }) => id), [adjacentId, workItemId])
  assert.deepEqual(calls.slice(1).map(({ arguments: args }) => args.work_item_id), [workItemId, adjacentId, workItemId])
})

test('MCP creates with a known template and comments by the work item ID', async () => {
  const { client, calls } = clientWith(({ params }) => {
    if (params.name === 'get_workitem_field_meta') return [{ field_key: 'name', is_required: 1 }]
    if (params.name === 'list_workitem_field_config') return { list: [{ field_key: 'template', options: [{ option_id: 'only-template' }] }] }
    if (params.name === 'create_workitem') return { url: 'https://project.feishu.cn/team/story/detail/1234' }
    return { ok: true }
  }, { ...config, spaceSlug: 'team' })
  assert.equal(await client.createWorkItem({ typeKey: 'story', name: '发布说明', description: '初稿' }), 1234)
  await client.addComment('story', 1234, '确认完成')
  assert.deepEqual(calls[2], { name: 'create_workitem', arguments: {
    project_key: 'proj_key', work_item_type: 'story', fields: [
      { field_key: 'template', field_value: 'only-template' },
      { field_key: 'name', field_value: '发布说明' },
      { field_key: 'description', field_value: '初稿' }
    ]
  } })
  assert.deepEqual(calls[3], { name: 'add_comment', arguments: { project_key: 'proj_key', work_item_id: '1234', content: '确认完成' } })
})

test('MCP builds a scoped create form and encodes validated field values', async () => {
  const { client, calls } = clientWith(({ params }) => {
    if (params.name === 'get_workitem_field_meta') return { fields: [
      { field_key: 'name', is_required: 1 },
      { field_key: 'description', is_required: 1 },
      { field_key: 'due', field_name: '截止日期', field_type_key: 'date', is_required: 1 },
      { field_key: 'priority', field_name: '优先级', field_type_key: 'select', is_required: true },
      { field_key: 'cost', field_name: '预算', field_type_key: 'number', is_required: true },
      { field_key: 'enabled', field_name: '启用', field_type_key: 'bool', is_required: true }
    ] }
    if (params.name === 'list_workitem_field_config') return { fields: [
      { field_key: 'template', options: [
        { option_id: 71, option_name: '常规', is_default: 1 },
        { option_id: 'urgent', option_name: '紧急' },
        { option_id: 'urgent', option_name: '紧急' }
      ] },
      { field_key: 'priority', options: [{ option_id: 'p1', option_name: '高' }] }
    ] }
    return { url: 'https://project.feishu.cn/team/story/detail/1234' }
  }, { ...config, spaceSlug: 'team' })

  const form = await client.createForm('story')
  assert.equal(form.browserUrl, 'https://project.feishu.cn/team/story/create')
  assert.equal(form.descriptionRequired, true)
  assert.deepEqual(form.templates, [{ id: '71', name: '常规', isDefault: true }, { id: 'urgent', name: '紧急' }])
  assert.deepEqual(form.fields.map(({ key, kind }) => [key, kind]), [['due', 'date'], ['priority', 'select'], ['cost', 'number'], ['enabled', 'boolean']])
  assert.deepEqual(calls[1].arguments.field_keys, ['template', 'due', 'priority', 'cost', 'enabled'])
  const input = {
    typeKey: 'story', name: '发布说明', description: '初稿', templateId: 'urgent',
    fieldValues: { due: '2024-07-29', priority: 'p1', cost: '1.5', enabled: 'false' }
  }
  await assert.rejects(() => client.createWorkItem({ ...input, templateId: 'other' }), /可用创建模板/)
  await assert.rejects(() => client.createWorkItem({ ...input, description: '' }), /描述/)
  await assert.rejects(() => client.createWorkItem({ ...input, fieldValues: { ...input.fieldValues, template: '71' } }), /创建字段已变化/)
  await assert.rejects(() => client.createWorkItem({ ...input, fieldValues: { ...input.fieldValues, due: '2026-02-30' } }), /截止日期/)
  await assert.rejects(() => client.createWorkItem({ ...input, fieldValues: { ...input.fieldValues, priority: 'unknown' } }), /优先级/)
  assert.equal(calls.length, 2)
  assert.equal(await client.createWorkItem(input), 1234)
  assert.deepEqual(calls[2].arguments.fields, [
    { field_key: 'template', field_value: 'urgent' },
    { field_key: 'name', field_value: '发布说明' },
    { field_key: 'description', field_value: '初稿' },
    { field_key: 'due', field_value: '1722182400000' },
    { field_key: 'priority', field_value: 'p1' },
    { field_key: 'cost', field_value: '1.5' },
    { field_key: 'enabled', field_value: 'false' }
  ])
})

test('MCP blocks unsupported required fields and rejects foreign creation links', async () => {
  const { client, calls } = clientWith(({ params }) => {
    if (params.name === 'get_workitem_field_meta') return params.arguments.work_item_type === 'story'
      ? [{ field_key: 'files', field_name: '附件', field_type_key: 'attachment', is_required: '1' }]
      : []
    if (params.name === 'list_workitem_field_config') return { field_key: 'template', options: [{ option_id: 'template' }] }
    return { url: 'https://project.feishu.cn/another/task/detail/1234' }
  }, { ...config, spaceSlug: 'team' })
  assert.deepEqual((await client.createForm('story')).unsupportedRequired, ['附件'])
  await assert.rejects(() => client.createWorkItem({ typeKey: 'story', name: '发布说明' }), /附件/)
  assert.equal(calls.length, 2)
  assert.equal(await client.createWorkItem({ typeKey: 'task', name: '发布说明' }), null)
})

test('MCP accepts a content-only project-key creation receipt despite a different known slug', async () => {
  const receiptConfig = { ...config, projectKey: '0123456789abcdef01234567', spaceSlug: 'fixture-space' }
  let writes = 0
  const client = new MeegoMcpClient({ config: receiptConfig, token: async () => 'access', fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as ToolRequest
    if (request.params.name === 'get_workitem_field_meta') return result(request.id, [])
    if (request.params.name === 'list_workitem_field_config') return result(request.id, { field_key: 'template', options: [{ option_id: 'template' }] })
    assert.equal(request.params.name, 'create_workitem')
    assert.equal(request.params.arguments.project_key, receiptConfig.projectKey)
    writes += 1
    return toolResponse(request.id, { content: [{ type: 'text', text: JSON.stringify({
      work_item_id: 1234,
      url: 'https://project.feishu.cn/0123456789abcdef01234567/story/detail/1234'
    }) }] })
  } })
  assert.equal(await client.createWorkItem({ typeKey: 'story', name: '创建回执回归' }), 1234)
  assert.equal(writes, 1)
})

test('MCP creation receipts accept only the current project key or known canonical slug with matching type and ID', async () => {
  const outcomes = [
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/proj_key/story/detail/1234' }, expected: 1234 },
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/team/story/detail/1234' }, expected: 1234 },
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/work_item/detail/proj_key/story/1234' }, expected: 1234 },
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/other/story/detail/1234' }, expected: null },
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/team/task/detail/1234' }, expected: null },
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/proj_key/story/detail/1235' }, expected: null },
    { receipt: { work_item_id: 1234, url: 'https://project.feishu.cn/work_item/detail/team/story/1234' }, expected: null },
    { receipt: { work_item_id: 1234, url: 'https://project.larksuite.com/proj_key/story/detail/1234' }, expected: null },
    { receipt: { project_key: 'other', work_item_id: 1234, url: 'https://project.feishu.cn/proj_key/story/detail/1234' }, expected: null }
  ]
  for (const { receipt, expected } of outcomes) {
    const { client, calls } = clientWith(({ params }) => {
      if (params.name === 'get_workitem_field_meta') return []
      if (params.name === 'list_workitem_field_config') return { field_key: 'template', options: [{ option_id: 'template' }] }
      return receipt
    }, { ...config, spaceSlug: 'team' })
    assert.equal(await client.createWorkItem({ typeKey: 'story', name: '创建回执边界' }), expected)
    assert.equal(calls.filter(({ name }) => name === 'create_workitem').length, 1)
  }
  const { client } = clientWith(({ params }) => {
    if (params.name === 'get_workitem_field_meta') return []
    if (params.name === 'list_workitem_field_config') return { field_key: 'template', options: [{ option_id: 'template' }] }
    return { work_item_id: 1234, url: 'https://project.feishu.cn/unknown/story/detail/1234' }
  })
  assert.equal(await client.createWorkItem({ typeKey: 'story', name: '未知空间' }), null)
})

test('MCP supports live creation metadata with enabled business leaves and the current member', async () => {
  const { client, calls } = clientWith(({ params }) => {
    if (params.name === 'get_workitem_field_meta') return { FieldConfList: [
      { field_key: 'business', field_name: '业务线', field_type_key: 'business', is_required: 1 },
      { field_key: 'reporter', field_name: '提出人', field_type_key: 'multi_user', is_required: 1 }
    ] }
    if (params.name === 'list_workitem_field_config') return { list: [
      { field_key: 'template', option: [{ option_id: 'template-1', option_name: '默认' }, { option_id: 'old', disabled: true }] },
      { field_key: 'business', option: [{ option_id: 'parent', option_name: '产品', children: [
        { option_id: 'leaf', option_name: '工作台' }, { option_id: 'disabled', disabled: true }
      ] }] }
    ] }
    return { work_item_id: '1234' }
  })
  const form = await client.createForm('story')
  assert.deepEqual(form.templates, [{ id: 'template-1', name: '默认' }])
  assert.deepEqual(form.fields.map(({ options }) => options), [
    [{ value: 'leaf', label: '产品 / 工作台' }], [{ value: 'user-a', label: '我（当前飞书账号）' }]
  ])
  const input = { typeKey: 'story', name: '发布检查', templateId: 'template-1' }
  await assert.rejects(() => client.createWorkItem({ ...input, fieldValues: { business: 'parent', reporter: 'user-a' } }), /业务线/)
  await assert.rejects(() => client.createWorkItem({ ...input, fieldValues: { business: 'leaf', reporter: 'another-user' } }), /提出人/)
  assert.equal(await client.createWorkItem({ ...input, fieldValues: { business: 'leaf', reporter: 'user-a' } }), 1234)
  assert.deepEqual(calls.at(-1)?.arguments.fields, [
    { field_key: 'template', field_value: 'template-1' }, { field_key: 'name', field_value: '发布检查' },
    { field_key: 'business', field_value: 'leaf' }, { field_key: 'reporter', field_value: '["user-a"]' }
  ])
})

test('MCP reads paged comments, including markdown and nested author data', async () => {
  const { client, calls } = clientWith(({ params }) => {
    if (params.name === 'search_user_info') return [{ user_key: 'user-a', name_cn: '张三' }]
    return { comments: [
      { comment_id: 12, creator: 'user-a', content: { rich_text_markdown: { markdown: '**检查完毕**' }, create_time: 1722182400000 } },
      { comment_id: '12', content: '重复记录' },
      { comment_id: '13', status: 'DELETED', content: '已删除' },
      { comment_id: '14', creator: { name_cn: '李四' }, content: '收到' }
    ], pagination: { page_size: 4, total: 15 } }
  })
  assert.deepEqual(await client.listComments('story', 1234, 2), {
    comments: [
      { id: '12', author: '张三', content: '**检查完毕**', createdAt: 1722182400000 },
      { id: '14', author: '李四', content: '收到', createdAt: null }
    ],
    hasMore: true
  })
  assert.deepEqual(calls, [
    { name: 'list_workitem_comments', arguments: { project_key: 'proj_key', work_item_id: '1234', page_num: 2 } },
    { name: 'search_user_info', arguments: { project_key: 'proj_key', user_keys: ['user-a'] } }
  ])
})

test('MCP refreshes after an explicit 401 and avoids retrying ambiguous writes', async () => {
  const tokens: (string | undefined)[] = []
  let calls = 0
  const fetchImpl: FetchLike = async (_url, init) => {
    calls++
    if (calls === 1) return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' }
    if (calls === 2) {
      const request = JSON.parse(String(init?.body)) as ToolRequest
      return result(request.id, [{ type_key: 'story', name: '需求' }])
    }
    throw new Error('unconfirmed timeout')
  }
  const client = new MeegoMcpClient({ config, fetchImpl, token: async (rejected) => {
    tokens.push(rejected)
    return rejected ? 'new-access' : 'old-access'
  } })
  assert.deepEqual(await client.workItemTypes(), [{ key: 'story', name: '需求' }])
  await assert.rejects(() => client.addComment('story', 1234, '确认完成'), /无法确认写入是否成功/)
  assert.deepEqual(tokens, [undefined, 'old-access', undefined])
  assert.equal(calls, 3)
})

test('MCP treats ambiguous write responses as unverified without sending another request', async () => {
  const cases: ((id: number) => FetchResponse)[] = [
    () => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => '' }),
    () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '{' }),
    (id) => result(id + 1, { ok: true }),
    (id) => toolResponse(id, {}),
    (id) => toolResponse(id, { content: null }),
    (id) => toolResponse(id, { content: [{ type: 'text', text: 123 }] }),
    (id) => toolResponse(id, { content: [], isError: 'false' }),
    (id) => toolResponse(id, { content: [], structuredContent: null }),
    (id) => toolResponse(id, { content: [], structuredContent: [] }),
    (id) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ jsonrpc: '2.0', id, error: {} }) }),
    (id) => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({
      jsonrpc: '2.0', id, result: { content: [] }, error: { code: -32602, message: 'conflicting result' }
    }) })
  ]
  for (const respond of cases) {
    let calls = 0
    const client = new MeegoMcpClient({ config, token: async () => 'access', fetchImpl: async (_url, init) => {
      calls++
      return respond((JSON.parse(String(init?.body)) as ToolRequest).id)
    } })
    const outcome = await client.addComment('story', 1234, '确认完成').catch((error: unknown) => error)
    assert.equal(outcome instanceof MeegoApiError && outcome.code, 'WRITE_UNVERIFIED')
    assert.equal(calls, 1)
  }
})

test('MCP confirms valid comment outcomes without requiring a business receipt ID', async () => {
  const outcomes = [
    { content: [] },
    { content: [{ type: 'text', text: '工具返回的非结构化结果' }], isError: false },
    { content: [{ type: 'text', text: 'null' }] },
    { content: [], structuredContent: { extra: 'opaque tool payload' } },
    { content: [{ type: 'resource_link', uri: 'https://project.feishu.cn/team/story/detail/1234', name: '工作项' }] }
  ]
  for (const outcome of outcomes) {
    let calls = 0
    const client = new MeegoMcpClient({ config, token: async () => 'access', fetchImpl: async (_url, init) => {
      calls++
      return toolResponse((JSON.parse(String(init?.body)) as ToolRequest).id, outcome)
    } })
    await client.addComment('story', 1234, '确认完成')
    assert.equal(calls, 1)
  }
})

test('MCP confirms creation without an ID and leaves plain text receipts opaque', async () => {
  for (const receipt of [null, true, {}, '1234', 'https://project.feishu.cn/team/story/detail/1234']) {
    const { client, calls } = clientWith(({ params }) => {
      if (params.name === 'get_workitem_field_meta') return []
      if (params.name === 'list_workitem_field_config') return { field_key: 'template', options: [{ option_id: 'template' }] }
      return receipt
    })
    assert.deepEqual(await client.createWorkItem({ typeKey: 'story', name: '发布检查' }), { state: 'confirmed' })
    assert.equal(calls.filter(({ name }) => name === 'create_workitem').length, 1)
  }
})

test('MCP does not confirm a tool execution error or retry its write', async () => {
  let calls = 0
  const client = new MeegoMcpClient({ config, token: async () => 'access', fetchImpl: async (_url, init) => {
    calls++
    return toolResponse((JSON.parse(String(init?.body)) as ToolRequest).id, {
      content: [{ type: 'text', text: 'business operation failed' }], isError: true
    })
  } })
  const outcome = await client.addComment('story', 1234, '确认完成').catch((error: unknown) => error)
  assert.equal(outcome instanceof MeegoApiError && outcome.code, 'MCP_TOOL_ERROR')
  assert.equal(calls, 1)
})

test('MCP discovers only management schemas through the authenticated paged directory', async () => {
  const calls: { method: string; params: unknown }[] = []
  const inputSchema = { type: 'object', properties: { work_item_id: { type: 'string' } } }
  const client = new MeegoMcpClient({ config, token: async () => 'access', fetchImpl: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer access')
    const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: { cursor?: string } }
    calls.push({ method: request.method, params: request.params })
    return toolResponse(request.id, request.params.cursor ? {
      tools: [{ name: 'transition_state', inputSchema, outputSchema: { type: 'object' }, description: 'omitted' }]
    } : {
      tools: [{ name: 'update_field', inputSchema }, { name: 'create_workitem', inputSchema }], nextCursor: 'second'
    })
  } })
  assert.deepEqual(await client.managementToolCatalog(), [
    { name: 'update_field', inputSchema }, { name: 'transition_state', inputSchema, outputSchema: { type: 'object' } }
  ])
  assert.deepEqual(calls, [{ method: 'tools/list', params: {} }, { method: 'tools/list', params: { cursor: 'second' } }])
})

test('MCP rejects a lookalike host before fetching credentials', async () => {
  assert.throws(() => new MeegoMcpClient({ config: { ...config, baseUrl: 'https://project.feishu.cn.attacker.test' }, token: async () => 'access' }))
})

test('MCP invalidates only the refreshed token when it is also rejected', async () => {
  const revoked: string[] = []
  const client = new MeegoMcpClient({
    config,
    token: async (rejected) => rejected ? 'new-access' : 'old-access',
    invalidate: async (rejected) => { revoked.push(rejected) },
    fetchImpl: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => '' })
  })
  await assert.rejects(() => client.currentUser(), /授权已失效/)
  assert.deepEqual(revoked, ['new-access'])
})

test('MCP rejects detail rows from another project or type', async () => {
  const { client } = clientWith(({ params }) => ({
    work_item_attribute: { work_item_id: params.arguments.work_item_id, work_item_type_key: 'story', project_key: 'other' }
  }))
  assert.equal(await client.getWorkItem(1234, 'story'), null)
})

test('MCP splits owner lookup at the official 20-key request limit', async () => {
  const { client, calls } = clientWith(({ params }) => (params.arguments.user_keys as string[]).map((key) => ({
    user_key: key, name_cn: `名称 ${key}`
  })))
  const keys = Array.from({ length: 21 }, (_, index) => `user-${index}`)
  const names = await client.queryUsers([...keys, keys[0]])
  assert.deepEqual(calls.map((call) => (call.arguments.user_keys as string[]).length), [20, 1])
  assert.equal(names.size, 21)
  assert.equal(names.get('user-20'), '名称 user-20')
})


test('MCP reports a definitive work item permission refusal without retrying the write', async () => {
  const requests: unknown[] = []
  const client = new MeegoMcpClient({ config, token: async () => 'access', fetchImpl: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as ToolRequest
    requests.push(request.params)
    return toolResponse(request.id, { isError: true, content: [{ type: 'text', text: 'error=ErrWorkItemNoPermission,message=No Permission,[VerifyTransferCurrentStatus] no permission,retriable=false' }] })
  } })
  const error = await client.addComment('issue', 4321, '权限检查').catch((error: unknown) => error)
  assert.equal(error instanceof MeegoApiError && error.code, 'MCP_FORBIDDEN')
  assert.deepEqual(requests, [{ name: 'add_comment', arguments: { project_key: 'proj_key', work_item_id: '4321', content: '权限检查' } }])
})
