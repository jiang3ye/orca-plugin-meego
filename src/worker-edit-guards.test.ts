import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as workerModule from './worker'
import { setFetch } from './meego/fetch-provider'

const baseUrl = 'https://project.feishu.cn'
const source = { baseUrl, projectKey: 'edit-space' }
const actor = 'edit-user'
const id = '1234'
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

test('worker rejects missing or stale edit versions before updating the business server', async () => {
  let updatedAt: string | undefined
  let name = 'Original title'
  const writes: unknown[] = []
  setFetch(async (url, init) => {
    assert.equal(url, `${baseUrl}/mcp_server/v1`)
    const request = JSON.parse(String(init?.body))
    let result: unknown
    if (request.method === 'tools/list') {
      result = { tools }
    } else {
      const { name: tool, arguments: args } = request.params
      assert.equal(args.project_key, source.projectKey)
      let data: unknown
      if (tool === 'get_workitem_brief') {
        assert.equal(args.work_item_id, id)
        data = {
          work_item_attribute: {
            work_item_id: id, work_item_name: name,
            owned_project: { key: source.projectKey }, work_item_type: { key: 'issue' },
            ...(updatedAt ? { update_time: updatedAt } : {})
          },
          work_item_fields: []
        }
      } else if (tool === 'list_workitem_field_config') {
        data = { list: [{ field_key: 'name', field_type: '_name' }], pagination: { has_more: false } }
      } else if (tool === 'update_field') {
        writes.push(args)
        name = args.fields[0].field_value
        data = { ok: true }
      } else {
        throw new Error(`Unexpected business tool ${tool}`)
      }
      result = { content: [{ type: 'text', text: JSON.stringify(data) }] }
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) }
  })
  const host = mockHost({
    settings: { base_url: baseUrl },
    secrets: { meego_oauth_session: JSON.stringify({
      origin: baseUrl, clientId: 'edit-client', accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 100_000
    }) },
    storage: { 'meego.account': { baseUrl, sessionId: 'edit-client', user: { key: actor, name: 'Editor' }, space: { key: source.projectKey, name: 'Edit space' } } }
  })
  const worker = await mountWorker(workerModule, { host })
  const input = { id, typeKey: 'issue', source, expectedUserKey: actor, operation: 'name' as const, value: 'Updated title' }
  try {
    const { options } = await worker.request('meego.editOptions', { id, typeKey: 'issue', source, expectedUserKey: actor })
    assert.deepEqual([options.text.title.state, options.text.description.state, options.priority.state, options.operators.state, options.status.state], [
      'browserOnly', 'browserOnly', 'browserOnly', 'browserOnly', 'browserOnly'
    ])
    await assert.rejects(() => worker.request('meego.editWorkItem', { ...input, expectedUpdatedAt: null }), /版本|更新时间/)
    assert.deepEqual(writes, [])
    updatedAt = newerTime
    await assert.rejects(() => worker.request('meego.editWorkItem', { ...input, expectedUpdatedAt: Date.parse(originalTime) }), /版本|更新/)
    assert.deepEqual(writes, [])
    const saved = await worker.request('meego.editWorkItem', { ...input, expectedUpdatedAt: Date.parse(newerTime) })
    assert.equal(saved.state, 'confirmed')
    assert.deepEqual(writes, [{ project_key: source.projectKey, work_item_id: id, fields: [{ field_key: 'name', field_value: 'Updated title' }] }])
  } finally {
    setFetch(null)
    await worker.deactivate()
  }
})
