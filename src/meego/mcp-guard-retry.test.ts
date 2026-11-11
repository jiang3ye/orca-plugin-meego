import { assert, test } from 'orca/testing'
import { MeegoApiError, type FetchLike, type FetchResponse } from './client'
import type { MeegoConfig } from './config'
import { MeegoMcpClient } from './mcp-client'

const config: MeegoConfig = {
  baseUrl: 'https://project.feishu.cn', projectKey: 'edit-space', userKey: 'edit-user',
  pluginId: '', pluginSecret: '', agentCommand: 'claude', webUrlTemplate: ''
}
const workItemId = '9007199254740993'
const originalTime = '2026-11-11T00:00:00.000Z'
const newerTime = '2026-11-11T00:00:01.000Z'
const string = { type: 'string' }
const strings = { type: 'array', items: string }
const scope = { project_key: string, work_item_id: string }
const tools = [
  { name: 'get_workitem_brief', properties: { ...scope, fields: strings } },
  { name: 'list_workitem_field_config', properties: {
    project_key: string, work_item_type: string, field_keys: strings, page_num: { type: 'number' }
  } },
  { name: 'update_field', properties: { ...scope, fields: {
    type: 'array', items: { type: 'object', properties: { field_key: string, field_value: string } }
  } } }
].map(({ name, properties }) => ({ name, inputSchema: { type: 'object', properties } }))

type BusinessState = { name: string; priority: string; updatedAt: string }
type RpcRequest = { jsonrpc: string; id: number; method: string; params: { name: string; arguments: Record<string, unknown> } }
type UpdateAttempt = { authorization: string | null; arguments: Record<string, unknown> }

function response(status: number, body: unknown): FetchResponse {
  return { ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Unauthorized', text: async () => JSON.stringify(body) }
}

function businessServer(onRefresh: (state: BusinessState) => void) {
  const state: BusinessState = { name: 'Original title', priority: 'p2', updatedAt: originalTime }
  const updates: UpdateAttempt[] = []
  const reads: { authorization: string | null; updatedAt: string }[] = []
  let accessToken = 'expired-access'
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, `${config.baseUrl}/mcp_server/v1`)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    const request = JSON.parse(String(init?.body)) as RpcRequest
    assert.equal(request.jsonrpc, '2.0')
    const authorization = new Headers(init?.headers).get('Authorization')
    if (request.method === 'tools/list') {
      return response(200, { jsonrpc: '2.0', id: request.id, result: { tools } })
    }
    assert.equal(request.method, 'tools/call')
    const { name, arguments: args } = request.params
    assert.equal(args.project_key, config.projectKey)
    let data: unknown
    if (name === 'get_workitem_brief') {
      assert.equal(args.work_item_id, workItemId)
      reads.push({ authorization, updatedAt: state.updatedAt })
      data = {
        work_item_attribute: {
          work_item_id: workItemId, work_item_name: state.name,
          owned_project: { key: config.projectKey }, work_item_type: { key: 'issue' },
          update_time: state.updatedAt
        },
        work_item_fields: [{ key: 'priority', value: { value: state.priority, label: state.priority } }]
      }
    } else if (name === 'list_workitem_field_config') {
      data = { list: [
        { field_key: 'name', field_type: '_name' },
        { field_key: 'priority', field_type: 'select', option: [
          { option_id: 'p1', option_name: 'High' }, { option_id: 'p2', option_name: 'Normal' }
        ] }
      ], pagination: { has_more: false } }
    } else if (name === 'update_field') {
      assert.equal(args.work_item_id, workItemId)
      updates.push({ authorization, arguments: args })
      if (authorization === 'Bearer expired-access') return response(401, {})
      assert.equal(authorization, 'Bearer refreshed-access')
      const fields = args.fields as { field_key: 'name' | 'priority'; field_value: string }[]
      assert.equal(fields.length, 1)
      state[fields[0].field_key] = fields[0].field_value
      state.updatedAt = newerTime
      data = { ok: true }
    } else {
      throw new Error(`Unexpected business tool ${name}`)
    }
    return response(200, {
      jsonrpc: '2.0', id: request.id,
      result: { content: [{ type: 'text', text: JSON.stringify(data) }] }
    })
  }
  const client = new MeegoMcpClient({
    config, fetchImpl,
    token: async (rejectedToken) => {
      if (rejectedToken !== undefined) {
        assert.equal(rejectedToken, 'expired-access')
        accessToken = 'refreshed-access'
        onRefresh(state)
      }
      return accessToken
    }
  })
  return { client, state, updates, reads }
}

test('a title edit rechecks the real version after OAuth refresh and never sends a stale retry', async () => {
  const { client, state, updates, reads } = businessServer((current) => {
    current.name = 'Title changed by another editor'
    current.updatedAt = newerTime
  })
  const conflict = new MeegoApiError('conflict', 'The displayed work item version is stale')
  const editor = client.editor(async () => {
    const item = await client.getWorkItem(workItemId, 'issue')
    if (item?.updatedAt !== Date.parse(originalTime)) throw conflict
  })
  const error = await editor.updateText(workItemId, 'issue', { name: 'Requested title' }).then(() => undefined, (cause: unknown) => cause)
  assert.equal(error, conflict)
  assert.equal((error as MeegoApiError).code, 'conflict')
  assert.deepEqual(updates, [{
    authorization: 'Bearer expired-access',
    arguments: { project_key: config.projectKey, work_item_id: workItemId, fields: [{ field_key: 'name', field_value: 'Requested title' }] }
  }])
  assert.ok(reads.some((read) => read.authorization === 'Bearer refreshed-access' && read.updatedAt === newerTime))
  assert.equal(state.name, 'Title changed by another editor')
  assert.equal(state.updatedAt, newerTime)
})

test('a priority edit cancelled during OAuth refresh keeps its cancellation and sends no second update', async () => {
  const controller = new AbortController()
  const cancelled = new MeegoApiError('cancelled', 'The edit was cancelled while refreshing authorization')
  const { client, state, updates } = businessServer(() => controller.abort(cancelled))
  const editor = client.editor(async () => {
    controller.signal.throwIfAborted()
    const item = await client.getWorkItem(workItemId, 'issue')
    assert.equal(item?.updatedAt, Date.parse(originalTime))
    controller.signal.throwIfAborted()
  })
  const error = await editor.updatePriority(workItemId, 'issue', 'p1').then(() => undefined, (cause: unknown) => cause)
  assert.equal(error, cancelled)
  assert.equal((error as MeegoApiError).code, 'cancelled')
  assert.deepEqual(updates, [{
    authorization: 'Bearer expired-access',
    arguments: { project_key: config.projectKey, work_item_id: workItemId, fields: [{ field_key: 'priority', field_value: 'p1' }] }
  }])
  assert.deepEqual(state, { name: 'Original title', priority: 'p2', updatedAt: originalTime })
})

test('an unchanged title edit can retry with the refreshed token and confirms the actual server update', async () => {
  const { client, state, updates } = businessServer(() => {})
  const editor = client.editor(async () => {
    const item = await client.getWorkItem(workItemId, 'issue')
    assert.equal(item?.updatedAt, Date.parse(originalTime))
  })
  const result = await editor.updateText(workItemId, 'issue', { name: 'Requested title' })
  assert.equal(result.state, 'confirmed')
  if (result.state !== 'confirmed') throw new Error('The business server accepted the edit')
  assert.equal(result.item.name, 'Requested title')
  assert.equal(result.item.updatedAt, Date.parse(newerTime))
  const args = { project_key: config.projectKey, work_item_id: workItemId, fields: [{ field_key: 'name', field_value: 'Requested title' }] }
  assert.deepEqual(updates, [
    { authorization: 'Bearer expired-access', arguments: args },
    { authorization: 'Bearer refreshed-access', arguments: args }
  ])
  assert.equal(state.name, 'Requested title')
})
