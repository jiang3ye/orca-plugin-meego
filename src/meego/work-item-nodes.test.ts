import { assert, test } from 'orca/testing'
import { MeegoApiError, type RawWorkItem } from './client'
import type { McpManagementTool } from './mcp-client'
import { MeegoWorkItemNodes } from './work-item-nodes'

const string = { type: 'string' }
const strings = { type: 'array', items: string }
const scope = { project_key: string, work_item_id: string }

function catalog(): McpManagementTool[] {
  const tool = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({ name, inputSchema: { type: 'object', properties, required } })
  return [
    tool('get_workitem_brief', scope),
    tool('get_node_detail', { ...scope, node_id_list: strings, need_sub_task: { type: 'boolean' }, page_num: { type: 'number' } }),
    tool('get_transition_required', { ...scope, state_key: string, mode: string }, ['state_key']),
    tool('transition_node', { ...scope, node_id: string, action: string, rollback_reason: string }, ['project_key', 'work_item_id', 'node_id', 'action']),
    tool('update_node', { ...scope, node_id: string, node_owners: strings }),
    tool('search_user_info', { project_key: string, user_keys: strings, need_all_status: { type: 'boolean' } }, ['user_keys'])
  ]
}

function node(key: string, status: string) {
  return {
    basic: { node_uuid: `node-${key}`, node_key: key, name: `Node ${key}`, status, pre_node_keys: [] as string[], next_node_keys: [] as string[] },
    assignees: { owners: [{ user_key: 'owner-a', name: 'Owner A' }], role_assignees: {} as Record<string, unknown>, node_owner_mode: undefined as number | undefined },
    schedule: { actual_begin_time: 1, actual_finish_time: null as number | null },
    form_items: [] as unknown[], sub_tasks: null, sub_workitems: []
  }
}

function setup() {
  const state = {
    id: '9223372036854775807', project: 'project-a', type: 'story', mode: '节点流', version: 12,
    rows: [node('start', 'finished'), node('build', 'doing'), node('end', 'not_started')],
    required: {} as unknown, tools: catalog(), apply: true, unknown: false, deny: '',
    beforeSend: null as (() => void) | null, beforeRetry: null as (() => void) | null,
    afterWrite: null as (() => void) | null,
    page: null as ((page: number, keys: string[]) => unknown) | null
  }
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const committed: { name: string; args: Record<string, unknown> }[] = []
  let guardRuns = 0
  const raw = (): RawWorkItem => ({ id: state.id, projectKey: state.project, typeKey: state.type, name: 'Example story', status: 'In progress',
    statusState: 'unknown', ownerKeys: ['aggregate-owner'], fields: [], description: '', updatedAt: 100 })
  const nodes = new MeegoWorkItemNodes({
    projectKey: 'project-a', userKey: 'caller', catalog: async () => state.tools,
    readWorkItem: async () => raw(),
    call: async (name, args, write = false, beforeSend) => {
      calls.push({ name, args })
      if (state.deny === name) throw new MeegoApiError('MCP_FORBIDDEN', 'Permission denied')
      if (name === 'get_workitem_brief') return { work_item_attribute: {
        work_item_id: state.id, owned_project: { key: state.project }, work_item_type: { key: state.type }, work_item_mod: state.mode
      } }
      if (name === 'get_node_detail') {
        const selected = args.node_id_list as string[]
        if (state.page) return state.page(Number(args.page_num), selected)
        return { workflow_template: { template_id: 100, template_version: state.version }, list: structuredClone(state.rows.filter((row) => selected.includes('_all') || selected.includes(row.basic.node_key))),
          pagination: { page_num: 1, page_size: 20, total: state.rows.length, has_more: false } }
      }
      if (name === 'get_transition_required') return state.required
      if (name === 'search_user_info') return (args.user_keys as string[]).map((user_key) => ({ user_key, name_cn: user_key }))
      if (write) {
        assert.equal(typeof beforeSend, 'function')
        state.beforeSend?.()
        guardRuns += 1
        await beforeSend!()
        if (state.beforeRetry) {
          state.beforeRetry()
          guardRuns += 1
          await beforeSend!()
        }
        const row = state.rows.find((entry) => entry.basic.node_key === args.node_id)!
        committed.push({ name, args })
        if (state.apply) {
          if (name === 'transition_node') {
            row.basic.status = args.action === 'confirm' ? 'finished' : 'doing'
            row.schedule.actual_finish_time = args.action === 'confirm' ? 5 : null
          } else if (name === 'update_node') {
            row.assignees.owners = (args.node_owners as string[]).map((user_key) => ({ user_key, name: user_key }))
          }
        }
        state.afterWrite?.()
        if (state.unknown) throw new MeegoApiError('WRITE_UNVERIFIED', 'Check the remote result')
        return { state: 'confirmed' }
      }
      throw new Error(`Unexpected tool ${name}`)
    }
  })
  return { nodes, state, calls, committed, guardRuns: () => guardRuns }
}

test('nodes list preserves actual node states and waits for an explicit inspection', async () => {
  const { nodes, state, calls } = setup()
  const result = await nodes.list(state.id, 'story')
  assert.equal(result.state, 'available')
  assert.deepEqual(result.nodes.map(({ key, status }) => [key, status]), [['start', 'finished'], ['build', 'doing'], ['end', 'not_started']])
  assert.equal(result.nodes[1].actions.confirm.state, 'browserOnly')
  assert.match(result.nodes[1].revision, /^[0-9a-f]{64}$/)
  assert.equal(calls.some((call) => call.name === 'get_transition_required'), false)
  assert.deepEqual(calls.find((call) => call.name === 'get_node_detail')?.args, {
    project_key: 'project-a', work_item_id: '9223372036854775807', node_id_list: ['_all'], need_sub_task: false, page_num: 1
  })
})

test('node confirmation targets the explicitly selected node and verifies finished state', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  assert.equal(selected.actions.confirm.state, 'available')
  assert.equal((await nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' })).state, 'confirmed')
  assert.deepEqual(committed, [{ name: 'transition_node', args: { project_key: 'project-a', work_item_id: state.id, node_id: 'build', action: 'confirm' } }])
  assert.equal(state.rows[2].basic.status, 'not_started')
})

test('node rollback requires a reason and confirms the selected finished node is reopened', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'start')
  assert.equal(selected.actions.rollback.state, 'available')
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'start', expectedRevision: selected.revision, action: 'rollback', reason: '  ' }), /原因/)
  assert.equal(committed.length, 0)
  assert.equal((await nodes.transition(state.id, 'story', { nodeKey: 'start', expectedRevision: selected.revision, action: 'rollback', reason: 'Needs another review' })).state, 'confirmed')
  assert.deepEqual(committed[0].args, { project_key: 'project-a', work_item_id: state.id, node_id: 'start', action: 'rollback', rollback_reason: 'Needs another review' })
})

test('unfinished tasks, deliverables and unrecognized requirements make transitions browser only', async () => {
  const { nodes, state, committed } = setup()
  for (const required of [{ tasks: [{ finished: false }] }, { deliverables: [{ id: 'artifact' }] }, { unknown: true }, null]) {
    state.required = required
    const selected = await nodes.inspect(state.id, 'story', 'build')
    assert.equal(selected.actions.confirm.state, 'browserOnly')
    await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /飞书项目/)
  }
  assert.equal(committed.length, 0)
})

test('a node changed while refreshing authorization is rejected by the per-send guard', async () => {
  const { nodes, state, committed, guardRuns } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  state.beforeRetry = () => { state.rows[1].assignees.owners = [{ user_key: 'someone-else', name: 'Another owner' }] }
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /已变化/)
  assert.equal(guardRuns(), 2)
  assert.deepEqual(committed, [])
})

test('a new requirement during token refresh is rejected immediately before the second send', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  state.beforeRetry = () => { state.required = { tasks: [{ finished: false }] } }
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /流转条件已变化/)
  assert.deepEqual(committed, [])
})

test('node template changes reject stale revisions before a write', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  state.version += 1
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /已变化/)
  assert.deepEqual(committed, [])
})

test('node revision tracks form values and schedules while ignoring owner display names', async () => {
  const { nodes, state, committed } = setup()
  state.rows[1].form_items = [{ form_item_type: 'node_field', field_key: 'estimate', field_type: 'number', is_required: false, value: 1 }]
  const selected = await nodes.inspect(state.id, 'story', 'build')
  state.rows[1].assignees.owners[0].name = 'Updated display name'
  assert.equal((await nodes.inspect(state.id, 'story', 'build')).revision, selected.revision)
  state.rows[1].form_items = [{ form_item_type: 'node_field', field_key: 'estimate', field_type: 'number', is_required: false, value: 2 }]
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /已变化/)
  const afterForm = await nodes.inspect(state.id, 'story', 'build')
  Object.assign(state.rows[1].schedule, { estimate_start_time: 100 })
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: afterForm.revision, action: 'confirm' }), /已变化/)
  assert.deepEqual(committed, [])
})

test('plain node owners use only node_owners and preserve other nodes and aggregate owners', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  assert.equal(selected.actions.owners.state, 'available')
  assert.equal((await nodes.updateOwners(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, userKeys: ['new-owner'] })).state, 'confirmed')
  assert.deepEqual(committed[0], { name: 'update_node', args: { project_key: 'project-a', work_item_id: state.id, node_id: 'build', node_owners: ['new-owner'] } })
  assert.deepEqual(state.rows[0].assignees.owners, [{ user_key: 'owner-a', name: 'Owner A' }])
  const fresh = await nodes.inspect(state.id, 'story', 'build')
  assert.equal((await nodes.updateOwners(state.id, 'story', { nodeKey: 'build', expectedRevision: fresh.revision, userKeys: [] })).state, 'confirmed')
  assert.deepEqual(committed[1].args.node_owners, [])
})

test('role-linked node owners stay browser only with the real first-party mode-3 shape', async () => {
  const { nodes, state, committed } = setup()
  state.rows[1].assignees.node_owner_mode = 3
  state.rows[1].assignees.owners = Array.from({ length: 5 }, (_, index) => ({ user_key: `owner-${index}`, name: '' }))
  state.rows[1].assignees.role_assignees = { engineering: state.rows[1].assignees.owners }
  const selected = await nodes.inspect(state.id, 'story', 'build')
  assert.equal(selected.actions.confirm.state, 'available')
  assert.equal(selected.actions.owners.state, 'browserOnly')
  await assert.rejects(() => nodes.updateOwners(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, userKeys: ['new-owner'] }), /负责人/)
  assert.deepEqual(committed, [])
})

test('unknown node schemas and actor or item scope mismatches never write', async () => {
  const { nodes, state, committed } = setup()
  state.project = 'different-project'
  await assert.rejects(() => nodes.list(state.id, 'story'), /来源/)
  state.project = 'project-a'
  state.rows[1].assignees.node_owner_mode = 99
  assert.equal((await nodes.inspect(state.id, 'story', 'build')).actions.confirm.state, 'browserOnly')
  state.rows[1].assignees.node_owner_mode = undefined
  Object.assign(state.rows[1].assignees, { role_assignees: undefined })
  assert.equal((await nodes.inspect(state.id, 'story', 'build')).actions.owners.state, 'browserOnly')
  const tool = state.tools.find((tool) => tool.name === 'transition_node')!
  const schema = tool.inputSchema as { required: string[] }
  schema.required.push('unknown_input')
  assert.equal((await nodes.inspect(state.id, 'story', 'start')).actions.rollback.state, 'browserOnly')
  assert.deepEqual(committed, [])
})

test('node pagination retains all pages and refuses a changed template or overlapping page', async () => {
  const { nodes, state } = setup()
  state.page = (page) => ({ workflow_template: { template_id: 100, template_version: 12 }, list: [node(page === 1 ? 'a' : 'b', 'finished')], pagination: { has_more: page === 1 } })
  assert.deepEqual((await nodes.list(state.id, 'story')).nodes.map((entry) => entry.key), ['a', 'b'])
  state.page = (page) => ({ workflow_template: { template_id: 100, template_version: page }, list: [node(`n${page}`, 'finished')], pagination: { has_more: page === 1 } })
  await assert.rejects(() => nodes.list(state.id, 'story'), /版本/)
  state.page = (page) => ({ workflow_template: { template_id: 100, template_version: 12 }, list: [node('same', 'finished')], pagination: { has_more: page === 1 } })
  assert.equal((await nodes.list(state.id, 'story')).state, 'browserOnly')
})

test('large workflows have a bounded list while an explicit node can still be inspected', async () => {
  const { nodes, state } = setup()
  state.page = (page, keys) => ({ workflow_template: { template_id: 100, template_version: 12 },
    list: [node(keys.includes('_all') ? `page-${page}` : 'build', 'doing')], pagination: { has_more: keys.includes('_all'), total: 120 } })
  const list = await nodes.list(state.id, 'story')
  assert.equal(list.state, 'browserOnly')
  assert.match(list.reason ?? '', /5 页/)
  assert.equal((await nodes.inspect(state.id, 'story', 'build')).actions.confirm.state, 'available')
})

test('null node responses stay browser only', async () => {
  const { nodes, state } = setup()
  state.page = () => null
  assert.deepEqual((await nodes.list(state.id, 'story')).nodes, [])
  assert.equal((await nodes.list(state.id, 'story')).state, 'browserOnly')
})

test('uncertain writes and unchanged readbacks stay unverified without repeating the mutation', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  state.apply = false
  assert.deepEqual(await nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), { state: 'unverified' })
  state.unknown = true
  assert.deepEqual(await nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), { state: 'unverified' })
  assert.equal(committed.length, 2)
})

test('a rollback that immediately finishes again stays unverified without repeating the rollback', async () => {
  const { nodes, state, committed } = setup()
  state.rows[0].basic.node_key = 'started'
  const selected = await nodes.inspect(state.id, 'story', 'started')
  state.afterWrite = () => { state.rows[0].basic.status = 'finished' }
  const result = await nodes.transition(state.id, 'story', {
    nodeKey: 'started', expectedRevision: selected.revision, action: 'rollback', reason: 'Recheck the previous step'
  })
  assert.deepEqual(result, { state: 'unverified' })
  assert.deepEqual(committed, [{ name: 'transition_node', args: {
    project_key: 'project-a', work_item_id: state.id, node_id: 'started', action: 'rollback', rollback_reason: 'Recheck the previous step'
  } }])
})

test('cancelled or forbidden pre-send operations remain definitive failures', async () => {
  const { nodes, state, committed } = setup()
  const selected = await nodes.inspect(state.id, 'story', 'build')
  state.beforeSend = () => { throw new MeegoApiError('cancelled', 'Cancelled before send') }
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /Cancelled before send/)
  state.beforeSend = null
  state.deny = 'transition_node'
  await assert.rejects(() => nodes.transition(state.id, 'story', { nodeKey: 'build', expectedRevision: selected.revision, action: 'confirm' }), /Permission denied/)
  assert.deepEqual(committed, [])
})
