import { assert, test } from 'orca/testing'
import { MeegoClient, type FetchLike } from './client'
import type { MeegoConfig } from './config'
import { parseMeegoJson } from './work-item-id'

const config: MeegoConfig = {
  baseUrl: 'https://project.feishu.cn', projectKey: 'space-a', userKey: 'user-a',
  pluginId: 'plugin-a', pluginSecret: 'secret-a', agentCommand: 'codex', webUrlTemplate: ''
}

function statusClient() {
  const calls: { url: string; body: string }[] = []
  let now = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: String(init?.body) })
    const input = parseMeegoJson(String(init?.body)) as Record<string, unknown>
    let data: unknown = []
    if (url.endsWith('/plugin_token')) data = { token: 'access', expire_time: 3600 }
    if (url.endsWith('/field/all')) data = [{ field_key: 'work_item_status', options: [
      { value: 'systemEnded', label: '已终止' }, { value: 'closed', label: '节点流已终止' },
      { value: `${input.work_item_type_key}-open`, label: '待处理' },
      { value: `${input.work_item_type_key}-done`, label: '已处理' },
      { value: 'disabled', label: '已停用', is_disabled: 1 },
      { value: 'foreign', label: '其他类型', work_item_type_key: 'foreign-type' }
    ] }]
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ data, pagination: { total: 0 } }) }
  }
  return { client: new MeegoClient({ config, fetchImpl, now: () => now }), calls, advance: () => { now += 60_001 } }
}

test('OpenAPI discovers scoped status values, isolates types and refreshes the short-lived catalog', async () => {
  const { client, calls, advance } = statusClient()
  const options = await client.statusOptions('story')
  assert.deepEqual(options, [{ key: 'story-open', label: '待处理' }, { key: 'story-done', label: '已处理' }])
  options[0].key = 'mutated'
  assert.equal((await client.statusOptions('story'))[0].key, 'story-open')
  assert.equal((await client.statusOptions('issue'))[0].key, 'issue-open')
  advance()
  await client.statusOptions('story')
  const metadata = calls.filter(({ url }) => url.endsWith('/field/all'))
  assert.deepEqual(metadata.map(({ body }) => JSON.parse(body)), [
    { work_item_type_key: 'story' }, { work_item_type_key: 'issue' }, { work_item_type_key: 'story' }
  ])
})

test('OpenAPI combines validated status values, title and int64 IDs in the official search group', async () => {
  const { client, calls } = statusClient()
  await client.filterWorkItems({
    typeKey: 'story', pageNum: 2, pageSize: 50, statusKeys: ['story-open', 'story-done'],
    search: "O'Neil", workItemIds: ['9007199254740993']
  })
  const search = calls.at(-1)!
  assert.equal(search.url, 'https://project.feishu.cn/open_api/space-a/work_item/story/search/params')
  const body = parseMeegoJson(search.body) as Record<string, unknown>
  assert.deepEqual(body.search_group, {
    conjunction: 'AND', search_params: [
      { param_key: 'work_item_status', operator: 'HAS ANY OF', value: ['story-done', 'story-open'] },
      { param_key: 'name', operator: '~', value: "O'Neil" },
      { param_key: 'work_item_id', operator: 'HAS ANY OF', value: ['9007199254740993'] }
    ], search_groups: []
  })
  assert.ok(search.body.includes('"value":[9007199254740993]'))
  assert.equal(body.page_num, 2)
  assert.equal(body.page_size, 50)
})

test('OpenAPI rejects stale, terminated and unsupported combined filters before querying work items', async () => {
  const { client, calls } = statusClient()
  await client.statusOptions('story')
  const before = calls.length
  const base = { typeKey: 'story', pageNum: 1, pageSize: 50 }
  await assert.rejects(() => client.filterWorkItems({ ...base, statusKeys: ['unknown'] }), /状态选项已变化/)
  await assert.rejects(() => client.filterWorkItems({ ...base, statusKeys: ['systemEnded'] }), /已终止工作项需要单独查询/)
  await assert.rejects(() => client.filterWorkItems({ ...base, statusKeys: ['closed'] }), /已终止工作项需要单独查询/)
  await assert.rejects(() => client.filterWorkItems({ ...base, statusKeys: ['story-open'], userKeys: ['user-a'] }), /不支持同时按负责人和状态筛选/)
  assert.equal(calls.length, before)
})
