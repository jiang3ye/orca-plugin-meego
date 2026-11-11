// Meegle's first-party MCP transport and tool names match the official Meegle CLI.
import { commentIdOf, MeegoApiError, requireStatusFilterKeys, requireWorkItemId, unverifiedWrite, type FetchLike, type FilterWorkItemsParams, type FilterWorkItemsResult, type RawWorkItem, type RawWorkItemField, type WorkItemStatusOption } from './client'
import { parseWorkItemLink, type MeegoConfig } from './config'
import { currentFetch } from './fetch-provider'
import { oauthOrigin } from './oauth'
import type { CreateWorkItemForm, CreateWorkItemInput, MeegoSpace, WorkItemComment, WorkItemId, WorkItemType } from '../protocol'
import { buildCreateForm, requiredCreateFieldKeys, validateCreateForm } from './create-form'
import { parseMeegoJson, parseWorkItemId, sameWorkItemId } from './work-item-id'
import { MeegoWorkItemEditor } from './work-item-edit'
import { MeegoWorkItemNodes } from './work-item-nodes'

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_LENGTH = 8 * 1024 * 1024
const MAX_QUERY_SESSIONS = 8
const QUERY_SESSION_MS = 2 * 60_000
const MQL_PAGE_SIZE = 50
const SPACE_PAGE_SIZE = 50
const SPACE_CATALOG_TTL_MS = 60_000
const MAX_SPACE_CATALOG_PAGES = 1_000
const USER_SEARCH_LIMIT = 20
const CREATE_FORM_TTL_MS = 60_000
const MAX_CREATE_FORMS = 16
const STATUS_OPTIONS_TTL_MS = 60_000
const MAX_STATUS_CATALOGS = 16
const MAX_FIELD_METADATA_PAGES = 10
const MANAGEMENT_TOOLS = new Set([
  'update_field', 'get_transitable_states', 'get_transition_required', 'transition_state',
  'get_node_detail', 'transition_node', 'update_node', 'get_workitem_field_meta',
  'list_workitem_field_config', 'list_workitem_role_config', 'list_node_field_config',
  'get_workitem_brief', 'search_user_info'
])
const MAX_TOOL_CATALOG_PAGES = 10
let nextRequestId = 0

type RecordValue = Record<string, unknown>

/** The tool succeeded, but did not provide a structured work item receipt. */
export interface McpWriteConfirmed {
  state: 'confirmed'
}

export interface McpManagementTool {
  name: string
  inputSchema: unknown
  outputSchema?: unknown
}

interface McpCallSuccess {
  data: unknown
}

interface QuerySession {
  id: string
  groupId: string
  total: number
  expiresAt: number
}

interface SpacePage {
  spaces: MeegoSpace[]
  hasMore: boolean
}

interface SpaceCatalog {
  expiresAt: number
  pages: Map<number, Promise<SpacePage>>
}

function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

function string(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? ''
}

function records(value: unknown, ...keys: string[]): unknown[] | undefined {
  if (Array.isArray(value)) return value
  const record = object(value)
  for (const key of keys) {
    const candidate = record[key]
    if (Array.isArray(candidate)) return candidate
  }
}

function validContentBlock(value: unknown): boolean {
  const block = object(value)
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string'
    case 'image':
    case 'audio':
      return typeof block.data === 'string' && typeof block.mimeType === 'string'
    case 'resource_link':
      return typeof block.uri === 'string' && typeof block.name === 'string'
    case 'resource': {
      const resource = object(block.resource)
      return typeof resource.uri === 'string' && (typeof resource.text === 'string' || typeof resource.blob === 'string')
    }
    default:
      return false
  }
}

function validToolSuccess(result: RecordValue): boolean {
  return Array.isArray(result.content) && result.content.every(validContentBlock) &&
    (result.isError === undefined || result.isError === false) &&
    (result.structuredContent === undefined || (result.structuredContent !== null &&
      typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)))
}

function safeCount(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined
}

function timestamp(value: unknown): number | null {
  const parsed = safeCount(value) ?? (typeof value === 'string' ? Date.parse(value) : NaN)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed < 1e12 && safeCount(value) !== undefined ? parsed * 1000 : parsed
}

function badResponse(message = '飞书项目返回了无法识别的响应。'): MeegoApiError {
  return new MeegoApiError('BAD_MCP_RESPONSE', message)
}

function spaceSearchKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]+/gu, '')
}

function canonicalItemLink(value: string, origin: string) {
  try {
    const url = new URL(value)
    if (oauthOrigin(url.origin) === origin) return parseWorkItemLink(url.href, url.origin)
  } catch {
    return null
  }
  return null
}

function statusLabel(value: unknown): string {
  const status = object(value)
  return string(value, status.label, status.name, status.state_key_name, status.end_state_key_name)
}

function userLabel(value: RecordValue): string {
  return string(value.name_cn, value.name_en, value.name, value.email, value.user_key)
}

function userKeys(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : records(value, 'value', 'users') ?? []
  return [...new Set(rows.map((row) => string(object(row).user_key, object(row).key, row)).filter(Boolean))]
}

function fieldsOf(value: unknown): RawWorkItemField[] {
  return (records(value) ?? []).flatMap((row) => {
    const field = object(row)
    const key = string(field.field_key, field.key)
    if (!key) return []
    return [{ key, alias: string(field.field_name, field.field_alias, field.name, field.label), typeKey: string(field.field_type_key, field.type_key, field.type), value: field.field_value ?? field.value }]
  })
}

function descriptionOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(descriptionOf).filter(Boolean).join('\n')
  const record = object(value)
  return string(record.markdown, record.text, record.content, record.value)
}

function normalizeWorkItem(payload: unknown, config: MeegoConfig, typeKey: string, origin: string): RawWorkItem {
  const result = object(payload)
  const item = { ...result, ...object(result.work_item_info), ...object(result.work_item_attribute) }
  const id = parseWorkItemId(item.work_item_id ?? item.id)
  if (id === null) throw badResponse('飞书项目返回的工作项缺少有效编号。')
  const fields = fieldsOf(item.work_item_fields ?? item.fields)
  const ownerField = fields.find((field) => field.key === 'current_status_operator' || field.key === 'owners')
  const nodes = records(item.work_item_current_node ?? item.current_nodes) ?? []
  const node = object(nodes[0])
  const nodeOwners = nodes.flatMap((entry) => records(object(entry).owners) ?? [])
  const owners = userKeys(item.current_status_operator ?? item.owners ?? ownerField?.value ?? nodeOwners)
  const status = statusLabel(item.work_item_status) || statusLabel(item.state_info) || statusLabel(node.current_node_status) || statusLabel(node)
  const type = string(item.work_item_type_key, object(item.work_item_type).key, item.work_item_type, typeKey)
  const project = object(item.owned_project)
  const slug = string(project.simple_name)
  const canonical = slug ? `${origin}/${encodeURIComponent(slug)}/${encodeURIComponent(type)}/detail/${id}` : ''
  const link = canonicalItemLink(string(item.work_item_url, item.url, canonical), origin)
  const url = link && sameWorkItemId(link.id, id) && link.typeKey === type ? link.url : undefined
  return {
    id,
    typeKey: type,
    projectKey: string(item.project_key, project.key, config.projectKey) || null,
    name: string(item.work_item_name, item.name) || `#${id}`,
    status,
    statusState: 'unknown',
    ownerKeys: owners,
    updatedAt: timestamp(item.updated_at ?? item.update_time ?? item.updated_time),
    fields,
    description: descriptionOf(item.description ?? fields.find((field) => field.key === 'description')?.value),
    ...(item.work_item_mod === '状态流' ? { workflowMode: 'state' as const } : item.work_item_mod === '节点流' ? { workflowMode: 'node' as const } : {}),
    ...(url ? { url } : {})
  }
}

function identifier(value: string): string {
  if (!value || /[`\x00-\x1f\x7f]/.test(value)) throw new MeegoApiError('INVALID_MQL', '空间或工作项类型标识无效。')
  return `\`${value}\``
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function mqlQuery(projectKey: string, params: FilterWorkItemsParams): string {
  const conditions: string[] = []
  const search = params.search?.trim()
  if (search) {
    if (/^#?\d+$/.test(search)) conditions.push(`\`work_item_id\` = ${requireWorkItemId(search.replace(/^#/, ''))}`)
    else conditions.push(`\`name\` LIKE ${literal(`%${search.replace(/[\\%_]/g, '\\$&')}%`)}`)
  }
  if (params.userKeys?.length) conditions.push('array_contains(`current_status_operator`, current_login_user())')
  if (params.statusKeys?.length) {
    conditions.push(`\`work_item_status\` IN (${params.statusKeys.map((key) => literal(`<id:${key}>`)).join(', ')})`)
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
  return 'SELECT `work_item_id`, `name`, `work_item_status`, `current_status_operator`, `updated_at` ' +
    `FROM ${identifier(projectKey)}.${identifier(params.typeKey)}${where} ORDER BY \`updated_at\` DESC`
}

function decodeMqlRow(row: unknown): unknown {
  const columns = records(object(row).moql_field_list)
  if (!columns) return row
  const values = new Map(columns.map((column) => {
    const field = object(column)
    return [string(field.key), object(field.value)]
  }))
  const status = records(values.get('work_item_status')?.key_label_value_list)?.[0]
  return {
    work_item_id: values.get('work_item_id')?.long_value,
    name: values.get('name')?.string_value,
    work_item_status: status,
    current_status_operator: values.get('current_status_operator')?.user_value_list,
    updated_at: values.get('updated_at')?.string_value ?? values.get('updated_at')?.long_value
  }
}

function queryRows(data: unknown, defaultGroupId = '1'): { rows: unknown[]; total?: number; sessionId: string; groupId: string } {
  const payload = object(data)
  const list = records(data, 'list', 'work_items', 'items')
  const first = object(list?.[0])
  const groups = records(first, 'group_infos') ?? records(payload, 'group_infos', 'group_pagination_list')
  const group = object(groups?.[0])
  const groupId = string(group.group_id) || defaultGroupId
  const total = safeCount(first.count ?? payload.total ?? object(payload.pagination).total)
  const groupedRows = object(payload.data)[groupId]
  if (Array.isArray(groupedRows)) {
    return { rows: groupedRows.map(decodeMqlRow), total, sessionId: string(payload.session_id), groupId }
  }
  const rows = records(group, 'work_items', 'work_item_list', 'items', 'list', 'group_data') ??
    records(first, 'work_items', 'work_item_list', 'items') ?? (groups === undefined ? list : undefined) ?? (total === 0 ? [] : undefined)
  if (!rows && payload.list === null && payload.data !== null && typeof payload.data === 'object' &&
    Object.keys(payload.data).length === 0 && typeof payload.session_id === 'string' && payload.search_status_info === null) {
    return { rows: [], total: 0, sessionId: payload.session_id, groupId }
  }
  if (!rows) throw badResponse('飞书项目没有返回工作项列表。')
  return { rows, total, sessionId: string(payload.session_id), groupId }
}

function normalizeComment(comment: RecordValue): (WorkItemComment & { authorKey: string }) | null {
  const id = commentIdOf(comment.comment_id) || commentIdOf(comment.id)
  if (!id) return null
  const author = comment.author ?? comment.created_by ?? comment.user ?? comment.creator
  const body = comment.content ?? comment.comment_content ?? comment.markdown
  const details = object(body)
  const content = string(object(details.rich_text_markdown).markdown, descriptionOf(body), object(details.rich_text).doc_text)
  return {
    id,
    author: string(userLabel(object(author)), comment.author, comment.author_name, comment.creator_name, comment.user_name),
    authorKey: string(object(author).user_key, object(author).key, comment.creator, comment.user_key),
    content: content || '请在飞书项目查看此条评论。',
    createdAt: timestamp(comment.created_at ?? comment.create_time ?? comment.created_time ?? details.create_time)
  }
}

export class MeegoMcpClient {
  private readonly config: MeegoConfig
  private readonly origin: string
  private readonly fetchImpl: FetchLike
  private readonly token: (rejectedToken?: string) => Promise<string>
  private readonly invalidate?: (rejectedToken: string) => Promise<void>
  private readonly querySessions = new Map<string, QuerySession>()
  private readonly createForms = new Map<string, { result: Promise<CreateWorkItemForm>; expiresAt: number }>()
  private readonly statusCatalogs = new Map<string, { result: Promise<WorkItemStatusOption[]>; expiresAt: number }>()
  private spaceCatalog: SpaceCatalog | null = null

  constructor(options: {
    config: MeegoConfig
    token: (rejectedToken?: string) => Promise<string>
    invalidate?: (rejectedToken: string) => Promise<void>
    fetchImpl?: FetchLike
  }) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? currentFetch()
    this.token = options.token
    this.invalidate = options.invalidate
    const origin = oauthOrigin(options.config.baseUrl)
    if (!origin) throw new MeegoApiError('INVALID_MCP_ORIGIN', '此地址不支持飞书项目账号连接。')
    this.origin = origin
  }

  private call(name: string, args: RecordValue, write: true, beforeWrite?: () => Promise<void>): Promise<McpCallSuccess>
  private call(name: string, args: RecordValue, write?: false): Promise<unknown>
  private call(name: string, args: RecordValue, write = false, beforeWrite?: () => Promise<void>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args }, write, beforeWrite)
  }

  private async request(method: 'tools/call' | 'tools/list', params: RecordValue, write = false, beforeWrite?: () => Promise<void>): Promise<unknown> {
    const unexpectedResponse = () => write ? unverifiedWrite() : badResponse()
    const id = ++nextRequestId
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const send = async (token: string) => {
      if (write) await beforeWrite?.()
      try {
        const response = await this.fetchImpl(`${this.origin}/mcp_server/v1`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body
        })
        if (!response.ok) return { status: response.status, text: '' }
        const text = await response.text()
        if (text.length > MAX_RESPONSE_LENGTH) throw badResponse()
        return { status: response.status, text }
      } catch {
        if (write) throw unverifiedWrite()
        throw new MeegoApiError('MCP_NETWORK', '无法读取飞书项目，请检查网络后重试。')
      }
    }
    let accessToken = await this.token()
    let response = await send(accessToken)
    if (response.status === 401) {
      accessToken = await this.token(accessToken)
      response = await send(accessToken)
    }
    if (response.status === 401) {
      await this.invalidate?.(accessToken)
      throw new MeegoApiError('consent_required', '飞书项目授权已失效，请重新连接。')
    }
    if (response.status === 403) throw new MeegoApiError('MCP_FORBIDDEN', '当前账号没有访问或操作该资源的权限。')
    if (response.status === 429) throw new MeegoApiError('MCP_RATE_LIMIT', '操作太频繁，请稍后重试。')
    if (write && (response.status === 408 || response.status >= 500)) throw unverifiedWrite()
    if (response.status < 200 || response.status >= 300) throw new MeegoApiError('MCP_HTTP', `飞书项目请求失败（HTTP ${response.status}）。`)
    let envelope: RecordValue
    try {
      envelope = object(parseMeegoJson(response.text))
    } catch {
      throw unexpectedResponse()
    }
    if (envelope.id !== id || envelope.jsonrpc !== '2.0') throw unexpectedResponse()
    const result = object(envelope.result)
    const messages = (records(result, 'content') ?? []).map(object)
      .filter((entry) => entry.type === 'text' && typeof entry.text === 'string' && !/^log_?id:/i.test(entry.text))
    const text = string(messages[0]?.text)
    if (write && Object.hasOwn(envelope, 'error')) {
      const error = object(envelope.error)
      if (Object.hasOwn(envelope, 'result') || !Number.isInteger(error.code) || typeof error.message !== 'string') throw unexpectedResponse()
    }
    if (write && object(envelope.error).code === -32603) throw unverifiedWrite()
    if (envelope.error || result.isError === true) {
      const message = string(object(envelope.error).message, text).replaceAll(accessToken, '[已隐藏]').slice(0, 400)
      if (/^error=ErrWorkItemNoPermission,/.test(message)) {
        throw new MeegoApiError('MCP_FORBIDDEN', '当前飞书账号没有执行此操作的权限，请在飞书项目中检查角色成员和操作权限。')
      }
      throw new MeegoApiError('MCP_TOOL_ERROR', message ? `飞书项目操作失败：${message}` : '飞书项目操作失败。')
    }
    if (method === 'tools/list') return result
    // MCP CallToolResult defines absent isError as successful. A receipt ID is
    // optional business data, so validate the protocol outcome before decoding it.
    if (write && (!validToolSuccess(result) || Object.hasOwn(envelope, 'error'))) throw unexpectedResponse()
    let data: unknown = null
    if (result.structuredContent !== undefined) {
      data = result.structuredContent
    } else if (text) {
      try {
        data = parseMeegoJson(text)
      } catch {
        data = text
      }
    } else if (!Array.isArray(result.content)) {
      throw unexpectedResponse()
    }
    return write ? { data } : data
  }

  nodes(beforeWrite?: () => Promise<void>, signal?: AbortSignal): MeegoWorkItemNodes {
    return new MeegoWorkItemNodes({
      projectKey: this.config.projectKey,
      userKey: this.config.userKey,
      catalog: () => this.managementToolCatalog(),
      readWorkItem: (id, typeKey) => this.getWorkItem(id, typeKey),
      call: (name, args, write, beforeNodeSend) => write
        ? this.call(name, args, true, async () => {
            await beforeWrite?.()
            await beforeNodeSend?.()
            signal?.throwIfAborted()
          })
        : this.call(name, args)
    })
  }

  editor(beforeWrite?: () => Promise<void>, signal?: AbortSignal): MeegoWorkItemEditor {
    return new MeegoWorkItemEditor({
      projectKey: this.config.projectKey,
      userKey: this.config.userKey,
      catalog: () => this.managementToolCatalog(),
      readWorkItem: (id, typeKey) => this.getWorkItem(id, typeKey),
      call: (name, args, write, beforeSend) => write
        ? this.call(name, args, true, async () => {
            await beforeWrite?.()
            await beforeSend?.()
            signal?.throwIfAborted()
          })
        : this.call(name, args)
    })
  }

  async managementToolCatalog(): Promise<McpManagementTool[]> {
    const tools = new Map<string, McpManagementTool>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_CATALOG_PAGES; page += 1) {
      const result = object(await this.request('tools/list', cursor ? { cursor } : {}))
      if (!Array.isArray(result.tools)) throw badResponse('飞书项目没有返回工具目录。')
      for (const entry of result.tools) {
        const tool = object(entry)
        if (typeof tool.name !== 'string' || !MANAGEMENT_TOOLS.has(tool.name)) continue
        tools.set(tool.name, {
          name: tool.name, inputSchema: tool.inputSchema,
          ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema })
        })
      }
      if (result.nextCursor === undefined || result.nextCursor === '') return [...tools.values()]
      if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor)) throw badResponse('飞书项目工具目录返回了无效的下一页。')
      cursor = result.nextCursor
      cursors.add(cursor)
    }
    throw badResponse('飞书项目工具目录页数过多。')
  }

  async currentUser(): Promise<{ key: string; name: string }> {
    const data = await this.call('search_user_info', { user_keys: ['current_login_user()'] })
    const user = object(records(data, 'list', 'users')?.[0] ?? data)
    const key = string(user.user_key)
    if (!key) throw badResponse('飞书项目没有返回当前账号信息。')
    return { key, name: userLabel(user) }
  }

  async listSpaces(search?: string, page = 1): Promise<SpacePage> {
    const term = search?.trim()
    if (!this.spaceCatalog || this.spaceCatalog.expiresAt <= Date.now() || (!term && page === 1)) {
      this.spaceCatalog = { expiresAt: Date.now() + SPACE_CATALOG_TTL_MS, pages: new Map() }
    }
    const catalog = this.spaceCatalog
    if (!term) return this.spacePage(catalog, page)

    const keyword = spaceSearchKey(term)
    if (!keyword) return { spaces: [], hasMore: false }
    const start = (page - 1) * SPACE_PAGE_SIZE
    const end = start + SPACE_PAGE_SIZE
    const matches = new Map<string, MeegoSpace>()
    const seenPages = new Set<string>()
    // The provider's project_key parameter performs exact lookup, so search the
    // account's unfiltered catalog until this page plus one match is available.
    for (let sourcePage = 1; matches.size <= end; sourcePage += 1) {
      if (sourcePage > MAX_SPACE_CATALOG_PAGES) throw badResponse('空间列表页数过多，请通过「更多空间」浏览。')
      const { spaces, hasMore } = await this.spacePage(catalog, sourcePage)
      for (const space of spaces) {
        if ([space.name, space.key, space.slug ?? ''].some((value) => spaceSearchKey(value).includes(keyword))) {
          matches.set(space.key, space)
        }
      }
      if (!hasMore) break
      if (spaces.length === 0) continue
      const signature = JSON.stringify(spaces.map(({ key }) => key))
      if (seenPages.has(signature)) throw badResponse('飞书项目重复返回同一页空间。请刷新后重试。')
      seenPages.add(signature)
    }
    return { spaces: [...matches.values()].slice(start, end), hasMore: matches.size > end }
  }

  async findSpaceBySlug(slug: string): Promise<MeegoSpace | null> {
    const { spaces } = await this.fetchSpacePage(1, slug)
    const matches = spaces.filter((space) => space.slug === slug)
    return matches.length === 1 ? matches[0] : null
  }

  private spacePage(catalog: SpaceCatalog, page: number): Promise<SpacePage> {
    const cached = catalog.pages.get(page)
    if (cached) return cached
    const request = this.fetchSpacePage(page).catch((error: unknown) => {
      catalog.pages.delete(page)
      throw error
    })
    catalog.pages.set(page, request)
    return request
  }

  private async fetchSpacePage(page: number, exactKey?: string): Promise<SpacePage> {
    const data = await this.call('search_project_info', { page_num: page, ...(exactKey ? { project_key: exactKey } : {}) })
    if (exactKey && data === null) return { spaces: [], hasMore: false }
    const result = object(data)
    const list = records(data, 'list', 'projects', 'project_list', 'project_infos') ?? (result.project_key ? [result] : undefined)
    if (!list) throw badResponse('飞书项目没有返回空间列表。')
    const spaces = list.flatMap((row) => {
      const space = object(row)
      const key = string(space.project_key)
      const slug = string(space.simple_name)
      return key ? [{ key, name: string(space.project_name, space.name, slug, key), ...(slug ? { slug } : {}) }] : []
    })
    if (list.length > 0 && spaces.length === 0) throw badResponse('飞书项目空间列表缺少有效标识。')
    const pagination = object(result.pagination)
    const hasMore = pagination.has_more ?? result.has_more
    const total = safeCount(pagination.total ?? result.total)
    const pageSize = safeCount(pagination.page_size ?? result.page_size) || SPACE_PAGE_SIZE
    return { spaces, hasMore: typeof hasMore === 'boolean' ? hasMore : total !== undefined ? page * pageSize < total : list.length === pageSize }
  }

  async workItemTypes(): Promise<WorkItemType[]> {
    const data = await this.call('list_workitem_types', { project_key: this.config.projectKey })
    const rows = records(data, 'list', 'work_item_types', 'work_item_type_list', 'types')
    if (!rows) throw badResponse('飞书项目没有返回工作项类型。')
    const types = rows.flatMap((row) => {
      const type = object(row)
      const key = string(type.work_item_type_key, type.type_key, type.key)
      return key ? [{ key, name: string(type.work_item_type_name, type.type_name, type.name, type.chinese_name, key) }] : []
    })
    if (rows.length > 0 && types.length === 0) throw badResponse('飞书项目工作项类型缺少有效标识。')
    return types
  }

  async getWorkItem(id: WorkItemId, typeKey: string): Promise<RawWorkItem | null> {
    // The default brief includes description and current owners without fetching every custom field.
    const data = await this.call('get_workitem_brief', { project_key: this.config.projectKey, work_item_id: String(requireWorkItemId(id)) })
    if (data === null) return null
    const item = normalizeWorkItem(data, this.config, typeKey, this.origin)
    if (!sameWorkItemId(item.id, id) || item.typeKey !== typeKey || item.projectKey !== this.config.projectKey) return null
    return item
  }

  /** Synthetic terminated state is omitted because MQL needs a different query. */
  async statusOptions(typeKey: string): Promise<WorkItemStatusOption[]> {
    identifier(typeKey)
    let cached = this.statusCatalogs.get(typeKey)
    if (!cached || cached.expiresAt <= Date.now()) {
      this.statusCatalogs.delete(typeKey)
      if (this.statusCatalogs.size >= MAX_STATUS_CATALOGS) {
        const oldest = this.statusCatalogs.keys().next().value
        if (oldest !== undefined) this.statusCatalogs.delete(oldest)
      }
      const result = this.loadStatusOptions(typeKey).catch((error: unknown) => {
        if (this.statusCatalogs.get(typeKey)?.result === result) this.statusCatalogs.delete(typeKey)
        throw error
      })
      cached = { result, expiresAt: Date.now() + STATUS_OPTIONS_TTL_MS }
      this.statusCatalogs.set(typeKey, cached)
    }
    return (await cached.result).map((option) => ({ ...option }))
  }

  private async loadStatusOptions(typeKey: string): Promise<WorkItemStatusOption[]> {
    const options = new Map<string, string>()
    for (let page = 1; page <= MAX_FIELD_METADATA_PAGES; page += 1) {
      const data = await this.call('list_workitem_field_config', {
        project_key: this.config.projectKey, work_item_type: typeKey,
        field_keys: ['work_item_status'], page_num: page
      })
      const result = object(data)
      const rows = records(data, 'list', 'fields', 'field_configs')
      if (!rows) throw badResponse('飞书项目没有返回状态字段配置。')
      for (const entry of rows) {
        const field = object(entry)
        if (string(field.field_key, field.key) !== 'work_item_status') continue
        const states = records(field.option ?? field.options)
        if (!states) throw badResponse('飞书项目没有返回状态选项。')
        for (const value of states) {
          const option = object(value)
          const key = string(option.option_id)
          const label = string(option.option_name)
          if (key === 'systemEnded' || key === 'closed' || option.disabled === true || option.disabled === 1 || option.disabled === '1') continue
          if (!key || !label) throw badResponse('飞书项目返回的状态选项缺少有效标识。')
          if (options.has(key) && options.get(key) !== label) throw badResponse('飞书项目返回了重复的状态标识。')
          options.set(key, label)
        }
      }
      const pagination = object(result.pagination)
      const total = safeCount(pagination.total ?? result.total)
      const pageSize = safeCount(pagination.page_size ?? result.page_size) || MQL_PAGE_SIZE
      const hasMore = pagination.has_more ?? result.has_more
      if (hasMore === false || (hasMore !== true && (total === undefined ? rows.length < pageSize : page * pageSize >= total))) {
        if (!options.size) throw new MeegoApiError('STATUS_FILTER_UNSUPPORTED', '此工作项类型没有可筛选的普通状态，请在飞书项目中筛选。')
        return [...options].map(([key, label]) => ({ key, label }))
      }
    }
    throw badResponse('飞书项目状态字段配置页数过多，请刷新后重试。')
  }

  async filterWorkItems(params: FilterWorkItemsParams): Promise<FilterWorkItemsResult> {
    const statusKeys = requireStatusFilterKeys(params.statusKeys)
    if (statusKeys.length) {
      const options = await this.statusOptions(params.typeKey)
      if (statusKeys.some((key) => !options.some((option) => option.key === key))) {
        throw new MeegoApiError('INVALID_STATUS_FILTER', '状态选项已变化，请重新选择。')
      }
    }
    if (params.workItemIds?.length) {
      if (statusKeys.length) throw new MeegoApiError('STATUS_FILTER_UNSUPPORTED', '按工作项编号读取详情时不能同时筛选状态。')
      const items: RawWorkItem[] = []
      for (const id of params.workItemIds) {
        const item = await this.getWorkItem(id, params.typeKey)
        if (item) items.push(item)
      }
      return { items, total: items.length }
    }
    const mql = mqlQuery(this.config.projectKey, { ...params, statusKeys })
    const project_key = this.config.projectKey
    let session = this.querySessions.get(mql)
    if (params.pageNum === 1 || !session || session.expiresAt <= Date.now()) {
      const query = queryRows(await this.call('search_by_mql', { project_key, mql }))
      session = { id: query.sessionId, groupId: query.groupId, total: query.total ?? query.rows.length, expiresAt: Date.now() + QUERY_SESSION_MS }
      this.querySessions.delete(mql)
      if (this.querySessions.size >= MAX_QUERY_SESSIONS) {
        const oldest = this.querySessions.keys().next().value
        if (oldest !== undefined) this.querySessions.delete(oldest)
      }
      this.querySessions.set(mql, session)
      if (params.pageNum === 1) return this.queryResult(query.rows, session.total, params.typeKey)
    }
    if ((params.pageNum - 1) * MQL_PAGE_SIZE >= session.total) return { items: [], total: session.total }
    if (!session.id) throw badResponse('飞书项目没有返回下一页查询所需的会话。')
    const query = queryRows(await this.call('search_by_mql', {
      project_key, session_id: session.id,
      group_pagination_list: [{ group_id: session.groupId, page_num: params.pageNum }]
    }), session.groupId)
    return this.queryResult(query.rows, session.total, params.typeKey)
  }

  private queryResult(rows: unknown[], total: number, typeKey: string): FilterWorkItemsResult {
    const items = rows.map((row) => normalizeWorkItem(row, this.config, typeKey, this.origin))
    return { items, total }
  }

  createForm(typeKey: string): Promise<CreateWorkItemForm> {
    const cached = this.createForms.get(typeKey)
    if (cached && cached.expiresAt > Date.now()) return cached.result
    this.createForms.delete(typeKey)
    if (this.createForms.size >= MAX_CREATE_FORMS) {
      const oldest = this.createForms.keys().next().value
      if (oldest !== undefined) this.createForms.delete(oldest)
    }
    const result = this.loadCreateForm(typeKey).catch((error: unknown) => {
      if (this.createForms.get(typeKey)?.result === result) this.createForms.delete(typeKey)
      throw error
    })
    this.createForms.set(typeKey, { result, expiresAt: Date.now() + CREATE_FORM_TTL_MS })
    return result
  }

  private async loadCreateForm(typeKey: string): Promise<CreateWorkItemForm> {
    const project_key = this.config.projectKey
    const work_item_type = typeKey
    const metadata = await this.call('get_workitem_field_meta', { project_key, work_item_type })
    const fieldKeys = ['template', ...requiredCreateFieldKeys(metadata)]
    const configurations: unknown[] = []
    for (let start = 0; start < fieldKeys.length; start += MQL_PAGE_SIZE) {
      const field_keys = fieldKeys.slice(start, start + MQL_PAGE_SIZE)
      configurations.push(await this.call('list_workitem_field_config', { project_key, work_item_type, page_num: 1, field_keys }))
    }
    const slug = this.config.spaceSlug
    const isPathSegment = (value: string) => value !== '.' && value !== '..' && /^[\p{L}\p{N}_.~-]+$/u.test(value)
    const browserUrl = slug && isPathSegment(slug) && isPathSegment(typeKey)
      ? `${this.origin}/${encodeURIComponent(slug)}/${encodeURIComponent(typeKey)}/create`
      : undefined
    return buildCreateForm(metadata, configurations, browserUrl, this.config.userKey)
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemId | McpWriteConfirmed | null> {
    const project_key = this.config.projectKey
    const work_item_type = input.typeKey
    const form = await this.createForm(work_item_type)
    const payload = validateCreateForm(form, input, this.origin === 'https://project.feishu.cn')
    const fields = [{ field_key: 'template', field_value: payload.templateId }, { field_key: 'name', field_value: input.name }]
    if (input.description) fields.push({ field_key: 'description', field_value: input.description })
    for (const { field, value } of payload.fields) fields.push({ field_key: field.key, field_value: value })
    const { data } = await this.call('create_workitem', { project_key, work_item_type, fields }, true)
    const created = object(records(data, 'list', 'work_items')?.[0] ?? data)
    const id = parseWorkItemId(created.work_item_id ?? created.id)
    if (created.project_key !== undefined && created.project_key !== project_key) return null
    const url = string(created.work_item_url, created.url)
    if (!url) return id ?? { state: 'confirmed' }
    const link = canonicalItemLink(url, this.origin)
    const knownSpace = link && (link.space === project_key ||
      (link.canonical && this.config.spaceSlug !== undefined && link.space === this.config.spaceSlug))
    if (!link || !knownSpace || link.typeKey !== work_item_type || (id !== null && !sameWorkItemId(id, link.id))) return null
    return link.id
  }

  async listComments(_typeKey: string, id: WorkItemId, page: number): Promise<{ comments: WorkItemComment[]; hasMore: boolean }> {
    const data = await this.call('list_workitem_comments', { project_key: this.config.projectKey, work_item_id: String(requireWorkItemId(id)), page_num: page })
    const result = object(data)
    const pagination = object(result.pagination)
    const total = safeCount(pagination.total ?? result.total)
    const rows = records(data, 'comments', 'comment_list', 'list', 'items') ?? (total === 0 ? [] : undefined)
    if (!rows) throw badResponse('飞书项目没有返回评论列表。')
    const visible = rows.map(object).filter((row) => row.status !== 'DELETED')
    const normalized = new Map<string, WorkItemComment & { authorKey: string }>()
    for (const row of visible) {
      const comment = normalizeComment(row)
      if (comment && !normalized.has(comment.id)) normalized.set(comment.id, comment)
    }
    if (visible.length && !normalized.size) throw badResponse('飞书项目返回的评论缺少有效编号。')
    const authorKeys = [...normalized.values()].flatMap(({ author, authorKey }) => !author && authorKey ? [authorKey] : [])
    const names = authorKeys.length ? await this.queryUsers(authorKeys).catch(() => new Map<string, string>()) : new Map<string, string>()
    const comments = [...normalized.values()].map(({ authorKey, ...comment }) => ({
      ...comment, author: comment.author || names.get(authorKey) || '飞书用户'
    }))
    const more = pagination.has_more ?? result.has_more
    const pageSize = safeCount(pagination.page_size ?? result.page_size)
    const hasMore = typeof more === 'boolean' ? more : total !== undefined && !!pageSize && page * pageSize < total
    return { comments, hasMore }
  }

  async addComment(_typeKey: string, id: WorkItemId, content: string): Promise<void> {
    await this.call('add_comment', { project_key: this.config.projectKey, work_item_id: String(requireWorkItemId(id)), content }, true)
  }

  async queryUsers(keys: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    const uniqueKeys = [...new Set(keys)]
    for (let start = 0; start < uniqueKeys.length; start += USER_SEARCH_LIMIT) {
      const data = await this.call('search_user_info', {
        project_key: this.config.projectKey, user_keys: uniqueKeys.slice(start, start + USER_SEARCH_LIMIT)
      })
      const users = records(data, 'list', 'users')
      if (!users) throw badResponse('飞书项目没有返回用户列表。')
      for (const entry of users) {
        const user = object(entry)
        const key = string(user.user_key)
        if (key) names.set(key, userLabel(user))
      }
    }
    return names
  }
}
