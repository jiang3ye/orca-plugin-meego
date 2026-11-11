import { assert, test } from 'orca/testing'
import { MeegoApiError, type RawWorkItem } from './client'
import type { McpManagementTool } from './mcp-client'
import { MeegoWorkItemEditor } from './work-item-edit'
import { requirementsComplete } from './work-item-edit-metadata'

const string = { type: 'string' }
const strings = { type: 'array', items: string }
const scope = { project_key: string, work_item_id: string }

// Minimal, anonymous copies of the first-party tools/list contracts.
function catalog(): McpManagementTool[] {
  const tool = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, inputSchema: { type: 'object', properties, required } })
  return [
    tool('get_workitem_brief', { ...scope, fields: strings }),
    tool('list_workitem_field_config', { project_key: string, work_item_type: string, field_keys: strings, page_num: { type: 'number' } }, ['project_key', 'work_item_type']),
    tool('get_transitable_states', { ...scope, work_item_type: string, user_key: string }, ['project_key', 'work_item_id']),
    tool('get_transition_required', { ...scope, state_key: string, mode: string }, ['state_key']),
    tool('transition_state', { ...scope, transition_id: string }, ['project_key', 'work_item_id', 'transition_id']),
    tool('update_field', { ...scope, fields: { type: 'array', items: { type: 'object', properties: { field_key: string, field_value: string } } }, role_operate: {
      type: 'array', items: { type: 'object', properties: { op: string, role_key: string, user_keys: strings } }
    } }, ['work_item_id']),
    tool('list_workitem_role_config', { project_key: string, work_item_type: string, role_keys: strings, page_num: { type: 'number' } }, ['project_key', 'work_item_type']),
    tool('search_user_info', { project_key: string, user_keys: strings, need_all_status: { type: 'boolean' } }, ['user_keys'])
  ]
}

function setup() {
  const state = {
    id: '9223372036854775807', typeKey: 'issue', projectKey: 'space-a', mode: '状态流',
    priority: 'p2', status: 'OPEN', operators: ['user-a'], name: 'Example issue', description: '# Before',
    apply: true, required: {} as unknown,
    roles: [{ key: 'operator', name: '经办人' }, { key: 'reporter', name: '报告人', members: [{ key: 'user-a', name: 'Name user-a' }] }] as unknown,
    roleConfig: { list: [{ role_id: 'reporter', role_name: '报告人' }, { role_id: 'operator', role_name: '经办人' }],
      pagination: { page_num: 1, page_size: 50, total: 2, has_more: false } } as unknown,
    roleConfigPages: null as Record<number, unknown> | null,
    roleApplyLimit: Infinity, roleWriteError: '', roleThrownError: null as unknown, malformedRoleReadback: false, unavailableUsers: [] as string[], onUserLookup: () => {},
    fields: [
      { field_key: 'name', field_type: '_name' },
      { field_key: 'description', field_type: 'multi-text' },
      { field_key: 'current_status_operator', field_type: 'multi-user' },
      { field_key: 'priority', field_type: 'select', option: [{ option_id: 'p1', option_name: 'High' }, { option_id: 'p2', option_name: 'Normal' }] }
    ] as Record<string, unknown>[],
    tools: catalog(), deniedTool: '', uncertainTool: '', nativeProject: 'space-a'
  }
  const calls: { name: string; args: Record<string, unknown>; write: boolean }[] = []
  const statusName = () => state.status === 'ACTIVE' ? 'In progress' : state.status
  const raw = (): RawWorkItem => ({
    id: state.id, typeKey: state.typeKey, projectKey: state.projectKey,
    name: state.name, description: state.description, fields: [], status: statusName(),
    statusState: 'unknown', ownerKeys: ['aggregated-node-owner'], updatedAt: null
  })
  const editor = new MeegoWorkItemEditor({
    projectKey: 'space-a', userKey: 'user-a', catalog: async () => state.tools,
    readWorkItem: async () => raw(),
    call: async (name, args, write = false, beforeSend) => {
      if (write) await beforeSend?.()
      calls.push({ name, args, write })
      if (state.deniedTool === name) throw new MeegoApiError('MCP_FORBIDDEN', 'Permission denied')
      if (state.uncertainTool === name) throw new MeegoApiError('WRITE_UNVERIFIED', 'Check the remote result')
      if (name === 'list_workitem_field_config') return { list: state.fields, pagination: { has_more: false } }
      if (name === 'get_workitem_brief') return {
        work_item_attribute: {
          work_item_id: state.id, owned_project: { key: state.nativeProject }, work_item_type: { key: state.typeKey },
          work_item_mod: state.mode, work_item_status: { key: state.status, name: statusName() }, role_members: state.roles
        },
        work_item_fields: [
          { key: 'priority', value: { value: state.priority, label: 'Priority' } },
          { key: 'current_status_operator', value: state.operators.length ? state.operators.map((key) => ({ key, name: key })) : null }
        ]
      }
      if (name === 'get_transitable_states') return { state_key: state.status, transition: [{ id: '9223372036854775806', state_key: 'ACTIVE', state_name: 'In progress', confirm_form: null }] }
      if (name === 'get_transition_required') return state.required
      if (name === 'list_workitem_role_config') return state.roleConfigPages?.[Number(args.page_num)] ?? state.roleConfig
      if (name === 'search_user_info') {
        state.onUserLookup()
        return (args.user_keys as string[]).filter((key) => !state.unavailableUsers.includes(key)).map((user_key) => ({ user_key, name_cn: `Name ${user_key}` }))
      }
      if (write && name === 'update_field') {
        if (Array.isArray(args.role_operate)) {
          if (state.apply) {
            const roles = state.roles as { key: string; name: string; members?: { key: string; name: string }[] }[]
            for (const operation of args.role_operate.slice(0, state.roleApplyLimit) as { op: string; role_key: string; user_keys: string[] }[]) {
              const role = roles.find((role) => role.key === operation.role_key)!
              const members = role.members ?? []
              role.members = operation.op === 'remove' ? members.filter((member) => !operation.user_keys.includes(member.key))
                : [...members, ...operation.user_keys.map((key) => ({ key, name: `Name ${key}` }))]
            }
          }
          if (state.malformedRoleReadback) state.roles = null
          if (state.roleThrownError !== null) throw state.roleThrownError
          if (state.roleWriteError) throw new MeegoApiError(state.roleWriteError, 'Role update failed')
          return { state: 'confirmed' }
        }
        if (state.apply) {
          const field = (args.fields as { field_key: string; field_value: string }[])[0]
          if (field.field_key === 'priority') state.priority = field.field_value
          if (field.field_key === 'current_status_operator') throw new MeegoApiError('MCP_TOOL_ERROR', 'current_status_operator:can not update system calculate field')
          if (field.field_key === 'name') state.name = field.field_value
          if (field.field_key === 'description') state.description = field.field_value
        }
        return { state: 'confirmed' }
      }
      if (write && name === 'transition_state') {
        if (state.apply) state.status = 'ACTIVE'
        return { state: 'confirmed' }
      }
      throw new Error(`Unexpected tool ${name}`)
    }
  })
  return { editor, state, calls, writes: () => calls.filter((call) => call.write) }
}

test('management capabilities use exact field metadata and authenticated tool schemas', async () => {
  const { editor, state } = setup()
  const result = await editor.options(state.id, 'issue')
  assert.equal(result.priority.state, 'available')
  assert.equal(result.priority.currentKey, 'p2')
  assert.deepEqual(result.priority.options, [{ key: 'p1', label: 'High' }, { key: 'p2', label: 'Normal' }])
  assert.equal(result.status.state, 'available')
  assert.deepEqual(result.status.transitions, [{ id: '9223372036854775806', label: 'In progress', targetStateKey: 'ACTIVE' }])
  assert.deepEqual(result.operators.userKeys, ['user-a'])
  assert.equal(result.operators.state, 'browserOnly')
  assert.match(result.operators.reason ?? '', /计算字段/)
  assert.equal(result.text.title.state, 'available')
  assert.equal(result.text.description.state, 'available')
})

test('priority update preserves int64 identity, sends one field and verifies its native value', async () => {
  const { editor, state, writes } = setup()
  assert.equal((await editor.updatePriority(state.id, 'issue', 'p1')).state, 'confirmed')
  assert.deepEqual(writes(), [{ name: 'update_field', args: { project_key: 'space-a', work_item_id: state.id, fields: [{ field_key: 'priority', field_value: 'p1' }] }, write: true }])
  await assert.rejects(() => editor.updatePriority(state.id, 'issue', 'High'), /网页/)
  assert.equal(writes().length, 1)
})

test('status transition verifies its target and rejects unfinished requirements without writing', async () => {
  const { editor, state, writes, calls } = setup()
  state.required = { form_items: [{ key: 'reason' }] }
  await assert.rejects(() => editor.transition(state.id, 'issue', '9223372036854775806'), /补全/)
  assert.equal(writes().length, 0)
  state.required = {}
  assert.equal((await editor.transition(state.id, 'issue', '9223372036854775806')).state, 'confirmed')
  assert.deepEqual(writes()[0].args, { project_key: 'space-a', work_item_id: state.id, transition_id: '9223372036854775806' })
  const requirement = calls.find((call) => call.name === 'get_transition_required')
  assert.deepEqual(requirement?.args, { project_key: 'space-a', work_item_id: state.id, state_key: 'ACTIVE', mode: 'unfinished' })
})

test('calculated current operators stay read only and stale requests cannot write or clear them', async () => {
  const { editor, state, writes, calls } = setup()
  const original = await editor.options(state.id, 'issue')
  assert.equal(original.operators.state, 'browserOnly')
  assert.equal(original.operators.multiple, true)
  assert.deepEqual(original.operators.userKeys, ['user-a'])
  const readCount = calls.length
  for (const keys of [['user-b'], [], ['aggregated-node-owner']]) {
    await assert.rejects(() => editor.updateCurrentOperators(state.id, 'issue', keys), /流程计算字段/)
  }
  assert.equal(calls.length, readCount)
  assert.deepEqual(writes(), [])
  state.fields = state.fields.filter((field) => field.field_key !== 'current_status_operator')
  const options = await editor.options(state.id, 'issue')
  assert.equal(options.operators.state, 'browserOnly')
  await assert.rejects(() => editor.updateCurrentOperators(state.id, 'issue', ['aggregated-node-owner']), /网页/)
  assert.deepEqual(writes(), [])
})

test('user field type and generic role-update support never imply current-operator write support', async () => {
  const { editor, state, writes } = setup()
  const update = state.tools.find((tool) => tool.name === 'update_field')!
  const schema = update.inputSchema as { properties: Record<string, unknown> }
  schema.properties.role_operate = {
    type: 'array', items: { type: 'object', properties: { op: string, role_key: string, user_keys: strings } }
  }
  for (const type of ['user', 'multi-user']) {
    state.fields.find((field) => field.field_key === 'current_status_operator')!.field_type = type
    assert.equal((await editor.options(state.id, 'issue')).operators.state, 'browserOnly')
    await assert.rejects(() => editor.updateCurrentOperators(state.id, 'issue', ['user-b']), /计算字段/)
  }
  assert.deepEqual(writes(), [])
})

test('role choices require the complete native role list and exact configured keys and labels', async () => {
  const { editor, state, calls } = setup()
  const options = await editor.options(state.id, 'issue')
  assert.equal(options.operators.state, 'browserOnly')
  assert.deepEqual(options.roles, { state: 'available', options: [
    { key: 'operator', label: '经办人', userKeys: [], users: [] },
    { key: 'reporter', label: '报告人', userKeys: ['user-a'], users: [{ key: 'user-a', name: 'Name user-a' }] }
  ] })
  assert.deepEqual(calls.find((call) => call.name === 'list_workitem_role_config')?.args, {
    project_key: 'space-a', work_item_type: 'issue', role_keys: ['operator', 'reporter'], page_num: 1
  })
})

test('role changes send only the selected role member differences and leave computed operators untouched', async () => {
  const { editor, state, writes } = setup()
  const result = await editor.updateRoleMembers(state.id, 'issue', 'reporter', ['user-b'])
  assert.equal(result.state, 'confirmed')
  assert.deepEqual(writes(), [{ name: 'update_field', write: true, args: {
    project_key: 'space-a', work_item_id: state.id,
    role_operate: [{ op: 'remove', role_key: 'reporter', user_keys: ['user-a'] }, { op: 'add', role_key: 'reporter', user_keys: ['user-b'] }]
  } }])
  assert.deepEqual(state.operators, ['user-a'])
  assert.deepEqual((await editor.options(state.id, 'issue')).roles?.options.map((role) => ({ key: role.key, users: role.userKeys })), [
    { key: 'operator', users: [] }, { key: 'reporter', users: ['user-b'] }
  ])
})

test('clearing uses explicit previous members, while empty and unchanged role plans do not write', async () => {
  const { editor, state, writes } = setup()
  assert.equal((await editor.updateRoleMembers(state.id, 'issue', 'operator', [])).state, 'confirmed')
  assert.equal((await editor.updateRoleMembers(state.id, 'issue', 'reporter', ['user-a'])).state, 'confirmed')
  assert.deepEqual(writes(), [])
  assert.equal((await editor.updateRoleMembers(state.id, 'issue', 'reporter', [])).state, 'confirmed')
  assert.deepEqual(writes()[0].args.role_operate, [{ op: 'remove', role_key: 'reporter', user_keys: ['user-a'] }])
  assert.equal(JSON.stringify(writes()).includes('_all'), false)
  assert.equal((await editor.updateRoleMembers(state.id, 'issue', 'reporter', [])).state, 'confirmed')
  assert.equal(writes().length, 1)
})

test('roles reject unknown role keys, unavailable additions, duplicates and wildcard member operations', async () => {
  const { editor, state, writes } = setup()
  await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'other-role', ['user-a']), /网页/)
  await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'operator', ['_all']), /网页/)
  await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'operator', ['user-a', 'user-a']), /网页/)
  state.unavailableUsers = ['user-b']
  await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'operator', ['user-b']), /重新搜索/)
  assert.deepEqual(writes(), [])
})

test('malformed or partial native roles never become editable', async () => {
  for (const native of [undefined, null, {}, [{ key: 'operator', name: '经办人', members: null }],
    [{ key: 'operator', name: '经办人', members: [{ name: 'Missing key' }] }],
    [{ key: 'operator', name: '经办人' }, { key: 'operator', name: 'Repeated' }],
    [{ key: 'operator', name: '经办人', members: [{ key: 'user-a' }, { key: 'user-a' }] }]]) {
    const { editor, state, writes } = setup()
    state.roles = native
    assert.equal((await editor.options(state.id, 'issue')).roles?.state, 'browserOnly')
    await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'operator', ['user-b']), /网页/)
    assert.deepEqual(writes(), [])
  }
})

test('native role choices stay scoped when configuration returns extra template roles across pages', async () => {
  const { editor, state } = setup()
  state.roleConfigPages = {
    1: { list: [{ role_id: 'operator', role_name: '经办人' }, { role_id: 'not-attached', role_name: '其他角色' }], pagination: { page_num: 1, has_more: true } },
    2: { list: [{ role_id: 'reporter', role_name: '报告人' }], pagination: { page_num: 2, has_more: false } }
  }
  const options = (await editor.options(state.id, 'issue')).roles
  assert.equal(options?.state, 'available')
  assert.deepEqual(options?.options.map((role) => role.key), ['operator', 'reporter'])
  state.roleConfigPages[2] = { list: [], pagination: { page_num: 2, has_more: false } }
  assert.equal((await editor.options(state.id, 'issue')).roles?.state, 'browserOnly')
})

test('roles fail closed for unsupported schemas, renamed configuration or incomplete pagination', async () => {
  for (const change of ['schema', 'label', 'pagination'] as const) {
    const { editor, state, writes } = setup()
    if (change === 'schema') {
      const tool = state.tools.find((tool) => tool.name === 'update_field')!
      ;(tool.inputSchema as { required: string[] }).required.push('fields')
    } else if (change === 'label') {
      state.roleConfig = { list: [{ role_id: 'operator', role_name: '不同角色' }, { role_id: 'reporter', role_name: '报告人' }], pagination: { has_more: false } }
    } else state.roleConfig = { list: [{ role_id: 'operator', role_name: '经办人' }] }
    assert.equal((await editor.options(state.id, 'issue')).roles?.state, 'browserOnly')
    await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'operator', ['user-b']), /网页/)
    assert.deepEqual(writes(), [])
  }
})

test('a role change during member lookup is rejected again at the guarded send', async () => {
  const { editor, state, writes } = setup()
  state.onUserLookup = () => { state.roles = [{ key: 'operator', name: '经办人', members: [{ key: 'user-c', name: 'New owner' }] }, { key: 'reporter', name: '报告人', members: [{ key: 'user-a', name: 'Name user-a' }] }] }
  await assert.rejects(() => editor.updateRoleMembers(state.id, 'issue', 'operator', ['user-b']), /角色配置或成员已变化/)
  assert.deepEqual(writes(), [])
})

test('a reported role error is confirmed only when exact target members read back successfully', async () => {
  for (const code of ['MCP_TOOL_ERROR', 'WRITE_UNVERIFIED']) {
    const { editor, state, writes } = setup()
    state.roleWriteError = code
    assert.equal((await editor.updateRoleMembers(state.id, 'issue', 'reporter', ['user-b'])).state, 'confirmed')
    assert.equal(writes().length, 1)
  }
})

test('partial role errors stay unverified while an exactly unchanged target preserves the original error', async () => {
  const partial = setup()
  partial.state.roleApplyLimit = 1
  partial.state.roleWriteError = 'MCP_TOOL_ERROR'
  assert.deepEqual(await partial.editor.updateRoleMembers(partial.state.id, 'issue', 'reporter', ['user-b']), { state: 'unverified' })
  assert.equal(partial.writes().length, 1)
  const unchanged = setup()
  unchanged.state.roleApplyLimit = 0
  unchanged.state.roleWriteError = 'MCP_TOOL_ERROR'
  await assert.rejects(() => unchanged.editor.updateRoleMembers(unchanged.state.id, 'issue', 'reporter', ['user-b']), /Role update failed/)
  assert.equal(unchanged.writes().length, 1)
})

test('lost role writes stay structurally unverified when immediate reads are old or partial', async () => {
  for (const error of [new MeegoApiError('WRITE_UNVERIFIED', 'Response lost'), new Error('Transport lost'), new MeegoApiError('MCP_NETWORK', 'Unknown network outcome')]) {
    for (const applied of [0, 1]) {
      const { editor, state, writes } = setup()
      state.roleApplyLimit = applied
      state.roleThrownError = error
      assert.deepEqual(await editor.updateRoleMembers(state.id, 'issue', 'reporter', ['user-b']), { state: 'unverified' })
      assert.equal(writes().length, 1)
    }
  }
})

test('partial success or unreadable role readbacks cannot authorize another automatic write', async () => {
  const partial = setup()
  partial.state.roleApplyLimit = 1
  assert.deepEqual(await partial.editor.updateRoleMembers(partial.state.id, 'issue', 'reporter', ['user-b']), { state: 'unverified' })
  assert.equal(partial.writes().length, 1)
  const unknown = setup()
  unknown.state.malformedRoleReadback = true
  assert.deepEqual(await unknown.editor.updateRoleMembers(unknown.state.id, 'issue', 'operator', ['user-b']), { state: 'unverified' })
  assert.equal(unknown.writes().length, 1)
})

test('unknown required tool inputs, incompatible field types and nodes remain browser only', async () => {
  const { editor, state, writes } = setup()
  state.mode = '节点流'
  assert.equal((await editor.options(state.id, 'issue')).status.state, 'browserOnly')
  await assert.rejects(() => editor.updateCurrentOperators(state.id, 'issue', ['user-b']), /网页/)
  const update = state.tools.find((tool) => tool.name === 'update_field')!
  const schema = update.inputSchema as { required: string[] }
  schema.required.push('unknown_input')
  assert.equal((await editor.options(state.id, 'issue')).priority.state, 'browserOnly')
  await assert.rejects(() => editor.updatePriority(state.id, 'issue', 'p1'), /网页/)
  state.tools = catalog()
  state.fields.find((field) => field.field_key === 'priority')!.field_type = 'vote-option'
  assert.equal((await editor.options(state.id, 'issue')).priority.state, 'browserOnly')
  assert.equal(writes().length, 0)
})

test('permission denials become explicit capabilities and a source mismatch prevents writes', async () => {
  const { editor, state, writes } = setup()
  state.deniedTool = 'get_transitable_states'
  const options = await editor.options(state.id, 'issue')
  assert.equal(options.status.state, 'browserOnly')
  assert.equal(options.priority.state, 'available')
  state.deniedTool = 'list_workitem_field_config'
  assert.equal((await editor.options(state.id, 'issue')).priority.state, 'browserOnly')
  state.deniedTool = ''
  state.nativeProject = 'space-b'
  await assert.rejects(() => editor.updatePriority(state.id, 'issue', 'p1'), /来源/)
  assert.equal(writes().length, 0)
})

test('unverified readbacks return uncertainty and do not repeat a write', async () => {
  const { editor, state, writes } = setup()
  state.apply = false
  assert.deepEqual(await editor.updatePriority(state.id, 'issue', 'p1'), { state: 'unverified' })
  assert.deepEqual(await editor.updateText(state.id, 'issue', { description: '# After' }), { state: 'unverified' })
  assert.equal(writes().length, 2)
})

test('write permission failures propagate and uncertain transport outcomes never retry', async () => {
  const { editor, state, writes } = setup()
  state.deniedTool = 'update_field'
  await assert.rejects(() => editor.updatePriority(state.id, 'issue', 'p1'), /Permission denied/)
  state.deniedTool = ''
  state.uncertainTool = 'update_field'
  assert.deepEqual(await editor.updatePriority(state.id, 'issue', 'p1'), { state: 'unverified' })
  assert.equal(writes().length, 2)
})

test('text updates use one field and verify the normalized detail', async () => {
  const { editor, state, writes } = setup()
  assert.equal((await editor.updateText(state.id, 'issue', { name: 'Updated title' })).state, 'confirmed')
  assert.deepEqual(writes()[0].args.fields, [{ field_key: 'name', field_value: 'Updated title' }])
  assert.equal((await editor.updateText(state.id, 'issue', { description: '# After' })).state, 'confirmed')
  await assert.rejects(() => editor.updateText(state.id, 'issue', { name: 'One', description: 'Two' }), /网页/)
  assert.equal(writes().length, 2)
})

test('requirement receipts fail closed for unknown or unfinished structures', () => {
  assert.equal(requirementsComplete({}), true)
  assert.equal(requirementsComplete({ tasks: [], form_items: null }), true)
  assert.equal(requirementsComplete(null), false)
  assert.equal(requirementsComplete({ success: true }), false)
  assert.equal(requirementsComplete({ tasks: [{ finished: false }] }), false)
})
