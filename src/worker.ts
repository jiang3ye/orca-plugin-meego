// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state,
// so caches are tied to the active client and durable data stays in Orca storage.
import type { OrcaWorkerApi } from 'orca/worker'
import type { ListWorkItemsOutput, WorkItemDetail, WorkItemId, WorkItemSummary } from './protocol'
import { MAX_COMMENT_LENGTH } from './protocol'
import { MeegoApiError, MeegoClient, type RawWorkItem } from './meego/client'
import { cacheFor, invalidateLists, LIST_TTL_MS, projectCache, readCache, TYPES_TTL_MS } from './meego/cache'
import { buildWorkItemUrl, parseWorkItemLink, verifiedWorkItemUrl, type MeegoConfig } from './meego/config'
import { MeegoConnection, RequestError, type ProjectClient } from './meego/connection'
import { MeegoOAuthError } from './meego/oauth'
import { FIELD_VALUE_LIMIT } from './meego/prompt'
import { parseWorkItemId, sameWorkItemId } from './meego/work-item-id'
import { registerWorkspaceCreation } from './meego/workspace-create'
import { registerWorkItemEdits } from './worker-item-edits'
import { registerWorkspaceActions } from './worker-workspace-actions'

const PAGE_SIZE = 50
const MAX_FIELD_ROWS = 12

async function safeCall<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call()
  } catch {
    return fallback
  }
}

function fieldValueToString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value.map((entry) => fieldValueToString(entry)).filter((part) => part !== '').join('、')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['label', 'name', 'text', 'value', 'title']) {
      if (typeof record[key] === 'string') return record[key] as string
    }
    if (Array.isArray(record.options)) return fieldValueToString(record.options)
  }
  return ''
}

function toSummary(raw: RawWorkItem, userNames: Map<string, string>): WorkItemSummary {
  return {
    id: raw.id,
    typeKey: raw.typeKey,
    name: raw.name,
    status: raw.status,
    statusState: raw.statusState,
    ownerKeys: raw.ownerKeys,
    ownerNames: raw.ownerKeys.map((key) => userNames.get(key) ?? key),
    updatedAt: raw.updatedAt
  }
}

function fieldRows(raw: RawWorkItem): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  for (const field of raw.fields) {
    if (field.key === 'description' || field.typeKey === 'multi_text') continue
    let value = fieldValueToString(field.value).trim()
    if (value === '') continue
    if (value.length > FIELD_VALUE_LIMIT) value = `${value.slice(0, FIELD_VALUE_LIMIT)}…`
    rows.push({ label: field.alias === '' ? field.key : field.alias, value })
  }
  return rows.slice(0, MAX_FIELD_ROWS)
}

function toDetail(raw: RawWorkItem, userNames: Map<string, string>, config: MeegoConfig): WorkItemDetail {
  return {
    ...toSummary(raw, userNames),
    url: verifiedWorkItemUrl(raw.url, config, raw) ?? buildWorkItemUrl(config, raw),
    source: { baseUrl: config.baseUrl, projectKey: config.projectKey },
    ...(config.spaceName ? { spaceName: config.spaceName } : {}),
    description: raw.description,
    ...(raw.workflowMode ? { workflowMode: raw.workflowMode } : {}),
    fields: fieldRows(raw)
  }
}

async function resolveUserNames(client: ProjectClient['client'], items: RawWorkItem[]): Promise<Map<string, string>> {
  const keys = [...new Set(items.flatMap((item) => item.ownerKeys))]
  if (keys.length === 0) return new Map()
  return safeCall(() => client.queryUsers(keys), new Map())
}

function validateItem(value: WorkItemId, typeKey: string): WorkItemId {
  const id = parseWorkItemId(value)
  if (id === null || typeof typeKey !== 'string' || typeKey.trim() === '') {
    throw new RequestError('invalid_input', '工作项编号或类型无效。')
  }
  return id
}

async function fetchWorkItemDetail({ config, client }: ProjectClient, value: WorkItemId, typeKey: string): Promise<WorkItemDetail> {
  const id = validateItem(value, typeKey)
  const raw = 'getWorkItem' in client
    ? await client.getWorkItem(id, typeKey)
    : (await client.filterWorkItems({ typeKey, pageNum: 1, pageSize: 1, workItemIds: [id], needMultiText: true })).items.find((item) => sameWorkItemId(item.id, id))
  if (raw == null || !sameWorkItemId(raw.id, id) || (raw.typeKey && raw.typeKey !== typeKey) || (raw.projectKey && raw.projectKey !== config.projectKey)) {
    throw new RequestError('not_found', `当前连接无法读取工作项 #${id}，请检查来源空间和访问权限。`)
  }
  return toDetail({ ...raw, typeKey }, await resolveUserNames(client, [raw]), config)
}

export default function activate(orca: OrcaWorkerApi): void {
  const connection = new MeegoConnection(orca)
  registerWorkspaceActions(orca, connection, { read: fetchWorkItemDetail, validate: validateItem })
  registerWorkItemEdits(orca, connection, { read: fetchWorkItemDetail, detail: toDetail, users: resolveUserNames })
  registerWorkspaceCreation(orca, { resolve: async (ref) => {
    const project = await connection.project(ref.source, ref.expectedUserKey)
    return { item: await fetchWorkItemDetail(project, ref.id, ref.typeKey), accountKey: project.config.userKey }
  } })
  orca.panels.handle('meego.status', () => connection.status())
  orca.panels.handle('meego.beginAuthorization', () => connection.begin())
  orca.panels.handle('meego.pollAuthorization', async () => {
    const result = await connection.poll().catch((error: unknown) => {
      if (!(error instanceof MeegoOAuthError) || error.code !== 'oauth_network') throw error
      return { state: 'network_error' as const, message: error.message }
    })
    if (result.state === 'authorized') orca.panels.post('meego.connectionChanged', { reason: 'authorized' })
    return result
  })
  orca.panels.handle('meego.cancelAuthorization', () => {
    connection.oauth.cancel()
    return { ok: true }
  })
  orca.panels.handle('meego.disconnect', async () => {
    await connection.disconnect()
    orca.panels.post('meego.connectionChanged', { reason: 'disconnected' })
    return { ok: true }
  })
  orca.panels.handle('meego.removeConnection', async () => {
    let removed = false
    try {
      await connection.remove()
      removed = true
      return { ok: true }
    } finally {
      orca.panels.post('meego.connectionChanged', { reason: removed ? 'removed' : 'configuration' })
    }
  })
  orca.panels.handle('meego.listSpaces', (input) => connection.listSpaces(input?.search?.trim(), input?.page))
  orca.panels.handle('meego.selectSpace', async ({ key }) => {
    await connection.selectSpace(key)
    orca.panels.post('meego.connectionChanged', { reason: 'space' })
    return { ok: true }
  })

  orca.panels.handle('meego.saveCredentials', async ({ pluginId, pluginSecret }) => {
    if (typeof pluginId !== 'string' || typeof pluginSecret !== 'string' || !pluginId.trim() || !pluginSecret.trim()) {
      throw new RequestError('invalid_input', 'Plugin ID 和 Plugin Secret 都不能为空。')
    }
    await connection.saveCredentials(pluginId.trim(), pluginSecret.trim())
    return { ok: true }
  })

  orca.panels.handle('meego.testConnection', async () => {
    const { config, client } = await connection.legacyProject()
    const types = await client.workItemTypes()
    await connection.useLegacy(config)
    orca.panels.post('meego.connectionChanged', { reason: 'enterprise' })
    return { ok: true, projectKey: config.projectKey, userKey: config.userKey, typeCount: types.length }
  })

  orca.panels.handle('meego.listTypes', async (input) => {
    const { client } = await connection.project(input?.source, input?.expectedUserKey)
    const cache = projectCache(client)
    const cached = readCache(cache.types)
    if (cached !== null) return cached
    const output = { types: await client.workItemTypes() }
    cache.types = cacheFor(output, TYPES_TTL_MS)
    return output
  })

  orca.panels.handle('meego.listWorkItems', async (input): Promise<ListWorkItemsOutput> => {
    const { config, client } = await connection.project(input.source, input.expectedUserKey)
    const page = Number.isSafeInteger(input.page) ? Math.max(1, input.page ?? 1) : 1
    const cacheable = page === 1 && !input.search && input.onlyMine !== true && !input.statusKeys?.length
    const lists = projectCache(client).lists
    if (cacheable && !input.force) {
      const cached = readCache(lists.get(input.typeKey))
      if (cached !== null) return { ...cached, fromCache: true }
    }
    const search = input.search?.trim()
    const id = search ? parseWorkItemId(search.replace(/^#/, '')) : null
    if (id === null && search && /^#?[1-9]\d*$/.test(search)) {
      throw new RequestError('invalid_input', '工作项编号超出飞书项目支持的范围。')
    }
    const result = await client.filterWorkItems({
      typeKey: input.typeKey,
      pageNum: page,
      pageSize: PAGE_SIZE,
      search: id === null || 'getWorkItem' in client ? search : undefined,
      workItemIds: id === null || 'getWorkItem' in client ? undefined : [id],
      userKeys: input.onlyMine === true ? [config.userKey] : undefined,
      statusKeys: input.statusKeys
    })
    const userNames = await resolveUserNames(client, result.items)
    const output: ListWorkItemsOutput = {
      items: result.items.map((raw) => toSummary(raw, userNames)),
      total: result.total,
      page,
      hasMore: page * PAGE_SIZE < result.total,
      fromCache: false
    }
    if (cacheable) lists.set(input.typeKey, cacheFor(output, LIST_TTL_MS))
    return output
  })

  orca.panels.handle('meego.getWorkItem', async ({ id, typeKey, source, expectedUserKey }) => ({
    item: await fetchWorkItemDetail(await connection.project(source, expectedUserKey), id, typeKey)
  }))

  orca.panels.handle('meego.statusOptions', async ({ typeKey, source, expectedUserKey }) => {
    if (typeof typeKey !== 'string' || !typeKey.trim()) throw new RequestError('invalid_input', '请选择工作项类型。')
    const { client } = await connection.project(source, expectedUserKey)
    return { options: await client.statusOptions(typeKey), canCombinePersonal: 'getWorkItem' in client }
  })

  orca.panels.handle('meego.openWorkItemLink', async ({ url, expectedUserKey }) => {
    if (typeof url !== 'string') throw new RequestError('invalid_link', '请粘贴飞书项目工作项详情链接。')
    const status = await connection.status()
    const parsed = parseWorkItemLink(url, status.baseUrl)
    if (parsed === null) throw new RequestError('invalid_link', '请粘贴当前连接中的飞书项目工作项详情链接。')
    let projectKey = parsed.space
    if (parsed.canonical) {
      if (status.connection?.state === 'connected' || status.connection?.state === 'choose_space') {
        const space = await connection.findSpaceBySlug(parsed.space, expectedUserKey)
        if (space === null) throw new RequestError('space_unavailable', '当前账号无法识别或访问链接中的空间。')
        projectKey = space.key
      } else {
        // Legacy connections have no space discovery. Compare the configured project's
        // generated URL before resolving a slug to its configured key.
        const { config } = await connection.legacyProject()
        const expected = parseWorkItemLink(buildWorkItemUrl(config, parsed), config.baseUrl)
        if (expected?.canonical !== true || expected.space !== parsed.space) {
          throw new RequestError('space_unavailable', '高级连接只能打开已配置空间的链接。请检查工作项链接模板。')
        }
        projectKey = config.projectKey
      }
    }
    const project = await connection.project({ baseUrl: status.baseUrl, projectKey }, expectedUserKey)
    const item = await fetchWorkItemDetail(project, parsed.id, parsed.typeKey)
    return { item: { ...item, url: parsed.url } }
  })

  orca.panels.handle('meego.listComments', async ({ id, typeKey, source, expectedUserKey, page, cursor }) => {
    const workItemId = validateItem(id, typeKey)
    const { client } = await connection.project(source, expectedUserKey)
    const pageNumber = Number.isSafeInteger(page) ? Math.max(1, page ?? 1) : 1
    return client instanceof MeegoClient
      ? await client.listComments(typeKey, workItemId, typeof cursor === 'string' ? cursor : undefined)
      : await client.listComments(typeKey, workItemId, pageNumber)
  })

  orca.panels.handle('meego.addComment', async ({ id, typeKey, content, source, expectedUserKey }) => {
    const workItemId = validateItem(id, typeKey)
    const body = typeof content === 'string' ? content.trim() : ''
    if (body === '' || body.length > MAX_COMMENT_LENGTH) throw new RequestError('invalid_input', `请输入 1 到 ${MAX_COMMENT_LENGTH} 字的评论。`)
    const { client } = await connection.project(source, expectedUserKey)
    try {
      await client.addComment(typeKey, workItemId, body)
      return { ok: true } as const
    } catch (error) {
      if (!(error instanceof MeegoApiError) || error.code !== 'WRITE_UNVERIFIED') throw error
      return { state: 'unverified' } as const
    }
  })

  orca.panels.handle('meego.createForm', async ({ typeKey, source, expectedUserKey }) => {
    if (typeof typeKey !== 'string' || !typeKey.trim()) throw new RequestError('invalid_input', '请选择工作项类型。')
    const { client } = await connection.project(source, expectedUserKey)
    return { form: await client.createForm(typeKey) }
  })

  orca.panels.handle('meego.createWorkItem', async ({ typeKey, name, description, templateId, fieldValues, source, expectedUserKey }) => {
    const title = typeof name === 'string' ? name.trim() : ''
    if (!title || typeof typeKey !== 'string' || !typeKey.trim()) throw new RequestError('invalid_input', '请选择类型并填写标题。')
    const { client } = await connection.project(source, expectedUserKey)
    const input = { typeKey, name: title, description, templateId, fieldValues }
    const id = await client.createWorkItem(input).catch((error: unknown) => {
      if (!(error instanceof MeegoApiError) || error.code !== 'WRITE_UNVERIFIED') throw error
      return null
    })
    invalidateLists(client)
    if (id === null) return { state: 'unverified' } as const
    if (typeof id === 'object') return id
    const item: WorkItemSummary = { id, typeKey, name: title, status: '', statusState: 'unknown', ownerKeys: [], ownerNames: [], updatedAt: null }
    return { item }
  })

}
