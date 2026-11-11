// Meego (飞书项目) OpenAPI client.
//
// Auth is Meego's own: plugin_id + plugin_secret are exchanged for a plugin token
// (POST /open_api/authen/plugin_token, ~87 min validity), then every call carries
// X-PLUGIN-TOKEN (and X-USER-KEY, which the work item APIs require). Rate limit is
// roughly 15 QPS, so keep calls sequential and cache where the worker can.
import { currentFetch } from './fetch-provider'
import type { MeegoConfig } from './config'
import { buildCreateForm, validateCreateForm } from './create-form'
import { parseMeegoJson, parseWorkItemId } from './work-item-id'
import type { CreateWorkItemForm, CreateWorkItemInput, WorkItemComment, WorkItemId, WorkItemType } from '../protocol'

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
const STATUS_OPTIONS_TTL_MS = 60_000
const MAX_STATUS_CATALOGS = 16

export interface FetchResponse {
  ok: boolean
  status: number
  statusText: string
  text(): Promise<string>
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponse>

export class MeegoApiError extends Error {
  readonly code: number | string
  readonly hint?: string

  constructor(code: number | string, message: string, hint?: string) {
    super(message)
    this.name = 'MeegoApiError'
    this.code = code
    this.hint = hint
  }
}

interface MeegoEnvelopeError {
  code?: number | string
  msg?: string
  message?: string
}

interface MeegoEnvelope<T> {
  data?: T
  error?: MeegoEnvelopeError
  err?: MeegoEnvelopeError
  err_code?: number | string
  err_msg?: string
  next_cursor?: string
  pagination?: { total?: number; page_num?: number; page_size?: number }
}

interface OpenApiComment {
  comment_id?: unknown
  creator?: string
  status?: string
  content?: {
    text?: string
    create_time?: number
    rich_text?: { doc_text?: string; markdown_content?: { markdown?: string } }
  }
}

/** A work item as the filter API returns it, normalized into a stable shape. */
export interface RawWorkItem {
  workflowMode?: 'state' | 'node'
  id: WorkItemId
  name: string
  typeKey: string
  projectKey: string | null
  status: string
  statusState: 'unstarted' | 'in_progress' | 'done' | 'blocked' | 'unknown'
  ownerKeys: string[]
  updatedAt: number | null
  fields: RawWorkItemField[]
  description: string
  url?: string
}

export interface RawWorkItemField {
  key: string
  alias: string
  typeKey: string
  value: unknown
}

export interface FilterWorkItemsParams {
  typeKey: string
  pageNum: number
  pageSize: number
  search?: string
  userKeys?: string[]
  statusKeys?: string[]
  workItemIds?: WorkItemId[]
  needMultiText?: boolean
}

export interface WorkItemStatusOption {
  key: string
  label: string
}

export function requireStatusFilterKeys(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string' || key.trim() === '')) {
    throw new MeegoApiError('INVALID_STATUS_FILTER', '请选择有效的工作项状态。')
  }
  if (value.includes('systemEnded') || value.includes('closed')) {
    throw new MeegoApiError('STATUS_FILTER_UNSUPPORTED', '已终止工作项需要单独查询，请在飞书项目中筛选。')
  }
  return [...new Set(value as string[])].sort()
}

export interface FilterWorkItemsResult {
  items: RawWorkItem[]
  total: number
}

interface RawWorkItemPayload {
  id?: WorkItemId
  work_item_id?: WorkItemId
  name?: string
  work_item_type_key?: string
  project_key?: string
  updated_at?: number
  created_at?: number
  owners?: unknown
  current_nodes?: unknown
  fields?: unknown
  [key: string]: unknown
}

function toNumberCode(code: unknown): number {
  const parsed = typeof code === 'number' ? code : Number(code)
  return Number.isFinite(parsed) ? parsed : -1
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function meegoError(err: MeegoEnvelopeError): MeegoApiError {
  const code = err.code ?? -1
  const text = err.msg ?? err.message ?? '未知错误'
  const message = `Meego API 错误 ${code}：${text}`
  if (Number(code) === 10204) return new MeegoApiError(code, `${message}。插件密钥不正确（在开发者后台重置 secret 后，旧密钥会立即失效）。`)
  if (Number(code) === 10301) return new MeegoApiError(code, `${message}。请在开发者后台确认已申请 API 权限并重新发布插件。`)
  if (Number(code) === 20039) return new MeegoApiError(code, `${message}。请在 Orca 设置 → 插件 → Meego 中填写 User Key。`)
  if (/project not exist/i.test(text)) {
    return new MeegoApiError(
      code,
      `${message}。这通常是权限问题而不是 key 写错：请确认插件已发布并安装到该空间，且完成了数据授权。`,
      'check-data-scope'
    )
  }
  return new MeegoApiError(code, message)
}

function envelopeError(envelope: MeegoEnvelope<unknown>): MeegoEnvelopeError | undefined {
  const details = [envelope.err, envelope.error].find((error) => error?.code !== undefined && toNumberCode(error.code) !== 0)
  if (details) return { ...details, msg: details.msg ?? details.message ?? envelope.err_msg }
  if (envelope.err_code !== undefined && toNumberCode(envelope.err_code) !== 0) {
    return { code: envelope.err_code, msg: envelope.err_msg }
  }
}

export function requireWorkItemId(value: WorkItemId): WorkItemId {
  const id = parseWorkItemId(value)
  if (id === null) throw new MeegoApiError('INVALID_WORK_ITEM_ID', '工作项编号无效。')
  return id
}

export function commentIdOf(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : ''
}

function commentObject(typeKey: string, id: WorkItemId) {
  return { type: 'WORKITEM', work_item_type_key: typeKey, work_item_id: String(requireWorkItemId(id)) }
}

function encodeWorkItemFilter(body: Record<string, unknown>, workItemIds?: WorkItemId[]): string {
  const json = JSON.stringify(body)
  if (!workItemIds?.length) return json
  // The OpenAPI schema uses int64 literals. Emit validated decimal digits for this field.
  const ids = workItemIds.map(requireWorkItemId)
  return `${json.slice(0, -1)},"work_item_ids":[${ids.join(',')}]}`
}

function encodeStatusSearch(params: FilterWorkItemsParams, statusKeys: string[], expand: unknown): string {
  const conditions = [JSON.stringify({ param_key: 'work_item_status', operator: 'HAS ANY OF', value: statusKeys })]
  if (params.search?.trim()) conditions.push(JSON.stringify({ param_key: 'name', operator: '~', value: params.search.trim() }))
  if (params.workItemIds?.length) {
    const ids = params.workItemIds.map(requireWorkItemId)
    conditions.push(`{"param_key":"work_item_id","operator":"HAS ANY OF","value":[${ids.join(',')}]}`)
  }
  const body = JSON.stringify({ page_num: params.pageNum, page_size: params.pageSize, expand })
  return `${body.slice(0, -1)},"search_group":{"conjunction":"AND","search_params":[${conditions.join(',')}],"search_groups":[]}}`
}

export function unverifiedWrite(): MeegoApiError {
  return new MeegoApiError('WRITE_UNVERIFIED', '无法确认写入是否成功，请在飞书项目中核对后再重试。')
}

/** Meego timestamps are unix seconds; convert to milliseconds for <RelativeTime>. */
function toMilliseconds(timestamp: unknown): number | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null
  return timestamp < 1e12 ? timestamp * 1000 : timestamp
}

function multiTextToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    return value
      .map((segment) => {
        if (typeof segment === 'string') return segment
        if (segment && typeof segment === 'object') {
          const record = segment as Record<string, unknown>
          if (typeof record.text === 'string') return record.text
          if (typeof record.content === 'string') return record.content
        }
        return ''
      })
      .filter((part) => part !== '')
      .join('\n')
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
  }
  return ''
}

function userKeysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const key = typeof entry === 'string' ? entry : (entry as { user_key?: unknown } | null)?.user_key
    return typeof key === 'string' && key !== '' ? [key] : []
  })
}

function ownerKeysOf(raw: RawWorkItemPayload): string[] {
  const top = userKeysOf(raw.owners)
  const nodes = Array.isArray(raw.current_nodes)
    ? raw.current_nodes.flatMap((node: CurrentNodePayload | null) => userKeysOf(node?.owners)) : []
  const fields = Array.isArray(raw.fields) ? raw.fields : []
  const owners = fields.find((field) => field?.field_key === 'owners' || field?.field_key === 'owner')
  const keys = top.length ? top : nodes.length ? nodes : userKeysOf(owners?.field_value)
  return [...new Set(keys)]
}

interface CurrentNodePayload {
  name?: unknown
  current_node_status?: unknown
  [key: string]: unknown
}

function statusOf(raw: RawWorkItemPayload): { status: string; state: RawWorkItem['statusState'] } {
  const nodes = Array.isArray(raw.current_nodes) ? (raw.current_nodes as CurrentNodePayload[]) : []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const status = node.current_node_status
    if (status && typeof status === 'object') {
      const record = status as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : ''
      if (name !== '') return { status: name, state: normalizeState(record.state) }
    }
    if (typeof node.name === 'string' && node.name !== '') return { status: node.name, state: 'unknown' }
  }
  const item = raw.work_item_status as { name?: unknown; label?: unknown; state_key?: unknown; is_init_state?: unknown; is_archived_state?: unknown } | null
  const status = [item?.name, item?.label, item?.state_key].find((value): value is string => typeof value === 'string' && value !== '') ?? ''
  const state = item?.is_archived_state === true ? 'done' : item?.is_init_state === true ? 'unstarted' : normalizeState(item?.state_key)
  return { status, state }
}

function normalizeState(state: unknown): RawWorkItem['statusState'] {
  if (typeof state !== 'string') return 'unknown'
  const normalized = state.trim().toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')
  if (normalized === 'done' || normalized === 'completed' || normalized === 'finished') return 'done'
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'processing') return 'in_progress'
  if (normalized === 'unstarted' || normalized === 'not_started' || normalized === 'pending') return 'unstarted'
  if (normalized === 'blocked' || normalized === 'terminated') return 'blocked'
  return 'unknown'
}

function descriptionOf(raw: RawWorkItemPayload): string {
  const fields = Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>[]) : []
  let fallback = ''
  for (const field of fields) {
    if (!field || typeof field !== 'object') continue
    const key = typeof field.field_key === 'string' ? field.field_key : ''
    const typeKey = typeof field.field_type_key === 'string' ? field.field_type_key : ''
    if (key !== 'description' && typeKey !== 'multi_text' && typeKey !== 'multi-text') continue
    const markdown = (field.field_value_markdown as { markdown?: unknown } | null)?.markdown
    const richText = (field.field_value as { doc_text?: unknown } | null)?.doc_text
    const text = (typeof markdown === 'string' ? markdown : typeof richText === 'string' ? richText : multiTextToString(field.field_value)).trim()
    if (key === 'description' && text !== '') return text
    if (fallback === '') fallback = text
  }
  return fallback
}

function normalizeWorkItem(raw: RawWorkItemPayload): RawWorkItem | null {
  const id = parseWorkItemId(raw.id) ?? parseWorkItemId(raw.work_item_id)
  if (id === null) return null
  const typeKey = typeof raw.work_item_type_key === 'string' ? raw.work_item_type_key : ''
  const status = statusOf(raw)
  const fields = Array.isArray(raw.fields) ? (raw.fields as Record<string, unknown>[]).map((field) => ({
    key: typeof field.field_key === 'string' ? field.field_key : '',
    alias: typeof field.field_alias === 'string' ? field.field_alias : '',
    typeKey: typeof field.field_type_key === 'string' ? field.field_type_key : '',
    value: field.field_value
  })) : []
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : `#${id}`,
    typeKey,
    projectKey: typeof raw.project_key === 'string' ? raw.project_key : null,
    status: status.status,
    statusState: status.state,
    ownerKeys: ownerKeysOf(raw),
    updatedAt: toMilliseconds(raw.updated_at ?? raw.created_at),
    fields,
    description: descriptionOf(raw)
  }
}

function normalizeTypes(data: unknown): WorkItemType[] {
  const list = Array.isArray(data) ? data : []
  const types: WorkItemType[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (record.is_disable === 1 || record.is_disable === '1') continue
    const key = typeof record.key === 'string' && record.key !== ''
      ? record.key
      : typeof record.type_key === 'string'
        ? record.type_key
        : typeof record.work_item_type_key === 'string'
          ? record.work_item_type_key
          : ''
    if (key === '') continue
    const name = typeof record.name === 'string' && record.name !== '' ? record.name : typeof record.chinese_name === 'string' ? record.chinese_name : key
    types.push({ key, name })
  }
  return types
}

function normalizeUsers(data: unknown): Map<string, string> {
  const names = new Map<string, string>()
  const take = (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || key === '') return
    if (typeof value === 'string' && value !== '') names.set(key, value)
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      const name = typeof record.name_cn === 'string' && record.name_cn !== ''
        ? record.name_cn
        : typeof record.name === 'string' && record.name !== ''
          ? record.name
          : typeof record.nickname === 'string' && record.nickname !== ''
            ? record.nickname
            : typeof record.email === 'string'
              ? record.email
              : ''
      if (name !== '') names.set(key, name)
    }
  }
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      take(record.user_key ?? record.key, record)
    }
  } else if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) take(key, value)
  }
  return names
}

export class MeegoClient {
  private readonly config: MeegoConfig
  private readonly fetchImpl: FetchLike
  private readonly now: () => number
  private token: { value: string; expiresAt: number } | null = null
  private tokenRequest: Promise<string> | null = null
  private readonly statusCatalogs = new Map<string, { result: Promise<WorkItemStatusOption[]>; expiresAt: number }>()

  constructor(options: { config: MeegoConfig; fetchImpl?: FetchLike; now?: () => number }) {
    this.config = options.config
    this.fetchImpl = options.fetchImpl ?? currentFetch()
    this.now = options.now ?? Date.now
  }

  /** Exchanges plugin_id/secret for a plugin token, cached until shortly before expiry. */
  private async fetchToken(): Promise<string> {
    let base: URL
    try {
      base = new URL(this.config.baseUrl)
    } catch {
      throw new MeegoApiError('INVALID_BASE_URL', '请为飞书项目配置有效的 HTTPS API 地址。')
    }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
      throw new MeegoApiError('INVALID_BASE_URL', '请为飞书项目配置有效的 HTTPS API 地址。')
    }
    const url = `${this.config.baseUrl}/open_api/authen/plugin_token`
    let response: FetchResponse
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plugin_id: this.config.pluginId, plugin_secret: this.config.pluginSecret, type: 0 }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
    } catch (cause) {
      throw new MeegoApiError('NETWORK_ERROR', `网络错误：无法访问 ${this.config.baseUrl}（${messageOf(cause)}）`)
    }
    const envelope = await this.parseEnvelope(response)
    if (envelope.error) throw meegoError(envelope.error)
    const data = (envelope.data ?? {}) as { token?: unknown; expire_time?: unknown }
    if (typeof data.token !== 'string' || data.token === '') {
      throw new MeegoApiError('BAD_TOKEN_RESPONSE', '获取 plugin token 失败：响应中没有 token。请检查 Plugin ID / Plugin Secret。')
    }
    const expireSeconds = typeof data.expire_time === 'number' && data.expire_time > 0 ? data.expire_time : 3600
    this.token = {
      value: data.token,
      expiresAt: this.now() + expireSeconds * 1000 - Math.min(TOKEN_REFRESH_MARGIN_MS, expireSeconds * 100)
    }
    return this.token.value
  }

  private async getToken(): Promise<string> {
    if (this.token !== null && this.now() < this.token.expiresAt) return this.token.value
    this.tokenRequest ??= this.fetchToken().finally(() => { this.tokenRequest = null })
    return await this.tokenRequest
  }

  private async parseEnvelope(response: FetchResponse): Promise<MeegoEnvelope<unknown>> {
    const text = await response.text()
    let body: unknown
    try {
      body = parseMeegoJson(text)
    } catch {
      throw new MeegoApiError('BAD_RESPONSE', `Meego 返回了无法解析的内容（HTTP ${response.status}）。`)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new MeegoApiError('BAD_RESPONSE', 'Meego 返回了无效的响应。')
    }
    const envelope = body as MeegoEnvelope<unknown>
    const error = envelopeError(envelope)
    if (!response.ok && !error) {
      throw new MeegoApiError('HTTP_ERROR', `Meego 请求失败：HTTP ${response.status} ${response.statusText}`)
    }
    return { ...envelope, error }
  }

  private async apiCall<T>(path: string, init: { method?: 'GET' | 'POST'; body?: Record<string, unknown> | string; write?: boolean } = {}, retried = false): Promise<MeegoEnvelope<T>> {
    const token = await this.getToken()
    const headers: Record<string, string> = {
      'X-PLUGIN-TOKEN': token,
      'Content-Type': 'application/json'
    }
    if (this.config.userKey !== '') headers['X-USER-KEY'] = this.config.userKey
    const url = `${this.config.baseUrl}${path}`
    let response: FetchResponse
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'POST',
        headers,
        body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      })
    } catch (cause) {
      if (init.write) throw unverifiedWrite()
      throw new MeegoApiError('NETWORK_ERROR', `网络错误：无法访问 ${this.config.baseUrl}（${messageOf(cause)}）`)
    }
    if (response.status === 401 && !retried) {
      if (this.token?.value === token) this.token = null
      return this.apiCall<T>(path, init, true)
    }
    if (init.write && (response.status === 408 || response.status >= 500)) throw unverifiedWrite()
    const envelope = await this.parseEnvelope(response).catch((error: unknown) => {
      if (init.write && response.ok) {
        throw unverifiedWrite()
      }
      throw error
    })
    const error = envelope.error
    if (error) {
      // Re-authenticate once only on clear token failures; other errors surface as-is.
      const expired = toNumberCode(error.code) === 10203
      if (expired && !retried) {
        if (this.token?.value === token) this.token = null
        return await this.apiCall<T>(path, init, true)
      }
      throw meegoError(error)
    }
    return envelope as MeegoEnvelope<T>
  }

  /** GET /open_api/{project_key}/work_item/all-types — the space's work item types. */
  async workItemTypes(): Promise<WorkItemType[]> {
    const { data } = await this.apiCall<unknown>(`/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/all-types`, { method: 'GET' })
    return normalizeTypes(data)
  }

  async statusOptions(typeKey: string): Promise<WorkItemStatusOption[]> {
    let cached = this.statusCatalogs.get(typeKey)
    if (!cached || cached.expiresAt <= this.now()) {
      this.statusCatalogs.delete(typeKey)
      if (this.statusCatalogs.size >= MAX_STATUS_CATALOGS) {
        const oldest = this.statusCatalogs.keys().next().value
        if (oldest !== undefined) this.statusCatalogs.delete(oldest)
      }
      const result = this.loadStatusOptions(typeKey).catch((error: unknown) => {
        if (this.statusCatalogs.get(typeKey)?.result === result) this.statusCatalogs.delete(typeKey)
        throw error
      })
      cached = { result, expiresAt: this.now() + STATUS_OPTIONS_TTL_MS }
      this.statusCatalogs.set(typeKey, cached)
    }
    return (await cached.result).map((option) => ({ ...option }))
  }

  private async loadStatusOptions(typeKey: string): Promise<WorkItemStatusOption[]> {
    if (!typeKey.trim()) throw new MeegoApiError('INVALID_STATUS_FILTER', '请选择工作项类型。')
    const { data } = await this.apiCall<unknown>(`/open_api/${encodeURIComponent(this.config.projectKey)}/field/all`, {
      body: { work_item_type_key: typeKey }
    })
    if (!Array.isArray(data)) throw new MeegoApiError('BAD_RESPONSE', '飞书项目没有返回状态字段配置。')
    const field = data.find((entry) => entry !== null && typeof entry === 'object' && entry.field_key === 'work_item_status')
    const options = new Map<string, string>()
    if (Array.isArray(field?.options)) {
      for (const option of field.options) {
        if (!option || option.is_disabled === 1 || option.is_disabled === true || option.is_disabled === '1' ||
          option.value === 'systemEnded' || option.value === 'closed' ||
          (option.work_item_type_key && option.work_item_type_key !== typeKey)) continue
        if (typeof option.value !== 'string' || !option.value || typeof option.label !== 'string' || !option.label) {
          throw new MeegoApiError('BAD_RESPONSE', '飞书项目返回的状态选项缺少有效标识。')
        }
        if (options.has(option.value) && options.get(option.value) !== option.label) {
          throw new MeegoApiError('BAD_RESPONSE', '飞书项目返回了重复的状态标识。')
        }
        options.set(option.value, option.label)
      }
    }
    if (!options.size) throw new MeegoApiError('STATUS_FILTER_UNSUPPORTED', '此工作项类型没有可筛选的普通状态，请在飞书项目中筛选。')
    return [...options].map(([key, label]) => ({ key, label }))
  }

  /** POST /open_api/{project_key}/work_item/filter — the main work item query. */
  async filterWorkItems(params: FilterWorkItemsParams): Promise<FilterWorkItemsResult> {
    const statusKeys = requireStatusFilterKeys(params.statusKeys)
    if (statusKeys.length) {
      if (params.userKeys?.length) {
        throw new MeegoApiError('STATUS_FILTER_UNSUPPORTED', '企业插件连接暂不支持同时按负责人和状态筛选，请在飞书项目中筛选。')
      }
      if (params.pageSize > 50) throw new MeegoApiError('INVALID_STATUS_FILTER', '按状态筛选时每页最多显示 50 项。')
      const options = await this.statusOptions(params.typeKey)
      if (statusKeys.some((key) => !options.some((option) => option.key === key))) {
        throw new MeegoApiError('INVALID_STATUS_FILTER', '状态选项已变化，请重新选择。')
      }
    }
    const body: Record<string, unknown> = {
      work_item_type_keys: [params.typeKey],
      page_num: params.pageNum,
      page_size: params.pageSize,
      expand: {
        need_multi_text: params.needMultiText ?? false,
        need_rich_text_mark_down: params.needMultiText ?? false,
        need_user_detail: false,
        need_workflow: false,
        need_sub_task_parent: false
      }
    }
    if (params.search !== undefined && params.search !== '') body.work_item_name = params.search
    if (params.userKeys !== undefined && params.userKeys.length > 0) body.user_keys = params.userKeys
    const path = statusKeys.length
      ? `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/${encodeURIComponent(params.typeKey)}/search/params`
      : `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/filter`
    const { data, pagination: envelopePagination } = await this.apiCall<unknown>(path, {
      body: statusKeys.length ? encodeStatusSearch(params, statusKeys, body.expand) : encodeWorkItemFilter(body, params.workItemIds)
    })
    const record = (Array.isArray(data) ? { items: data } : (data ?? {})) as Record<string, unknown>
    const list = Array.isArray(record.items) ? record.items : Array.isArray(record.work_items) ? record.work_items : []
    const items: RawWorkItem[] = []
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const normalized = normalizeWorkItem(entry as RawWorkItemPayload)
      if (normalized !== null) items.push(normalized)
    }
    const pagination = (record.pagination ?? {}) as { total?: unknown }
    const total = envelopePagination?.total ?? (typeof pagination.total === 'number' ? pagination.total : (params.pageNum - 1) * params.pageSize + items.length)
    return { items, total }
  }

  async createForm(typeKey: string): Promise<CreateWorkItemForm> {
    const { data } = await this.apiCall<{ field_type_key?: string }[]>(
      `/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/${encodeURIComponent(typeKey)}/meta`,
      { method: 'GET' }
    )
    // OpenAPI's signal field uses bool/null, whereas MCP accepts option IDs.
    const metadata = data?.map((field) => field?.field_type_key === 'signal' ? { ...field, field_type_key: 'openapi-signal' } : field)
    return buildCreateForm(metadata, [], new URL(this.config.baseUrl).origin)
  }

  async createWorkItem(input: CreateWorkItemInput): Promise<WorkItemId | null> {
    const body: Record<string, unknown> = { work_item_type_key: input.typeKey, name: input.name, required_mode: 1 }
    const fields: Record<string, unknown>[] = []
    if (input.description) fields.push({ field_key: 'description', field_value_markdown: { markdown: input.description } })
    if (input.templateId !== undefined || input.fieldValues !== undefined) {
      const form = await this.createForm(input.typeKey)
      const validated = validateCreateForm(form, input, new URL(this.config.baseUrl).hostname === 'project.feishu.cn')
      const template = Number(validated.templateId)
      if (!/^\d+$/.test(validated.templateId) || !Number.isSafeInteger(template) || template <= 0) {
        throw new MeegoApiError('TEMPLATE_REQUIRED', '飞书项目没有返回有效的流程模板编号。')
      }
      body.template_id = template
      for (const { field, value } of validated.fields) {
        let fieldValue: unknown = value
        if (field.kind === 'select') fieldValue = { value }
        if (field.kind === 'boolean') fieldValue = value === 'true'
        if (field.kind === 'number' || field.kind === 'date') fieldValue = Number(value)
        fields.push({ field_key: field.key, field_value: fieldValue })
      }
    }
    if (fields.length) body.field_value_pairs = fields
    const { data } = await this.apiCall<unknown>(`/open_api/${encodeURIComponent(this.config.projectKey)}/work_item/create`, { body, write: true })
    const record = (data ?? {}) as Record<string, unknown>
    const nested = (record.work_item ?? {}) as Record<string, unknown>
    for (const candidate of [data, record.id, record.work_item_id, nested.id, nested.work_item_id]) {
      const id = parseWorkItemId(candidate)
      if (id !== null) return id
    }
    return null
  }

  async listComments(typeKey: string, id: WorkItemId, cursor?: string): Promise<{ comments: WorkItemComment[]; hasMore: boolean; nextCursor?: string }> {
    const { data, next_cursor } = await this.apiCall<{
      comments?: OpenApiComment[]
      next_cursor?: string
    }>('/open_api/comment/query', { body: {
      project_key: this.config.projectKey,
      object: commentObject(typeKey, id),
      paginator: { direction: 'DESC', page_size: 20, ...(cursor ? { cursor } : {}) },
      need_rich_text_mark_down: true
    } })
    if (!Array.isArray(data?.comments)) throw new MeegoApiError('BAD_RESPONSE', '飞书项目没有返回评论列表。')
    const rows = data.comments.flatMap((row) => {
      const commentId = commentIdOf(row?.comment_id)
      return commentId && row.status !== 'DELETED' ? [{ ...row, comment_id: commentId }] : []
    })
    const creators = [...new Set(rows.flatMap((row) => typeof row.creator === 'string' && row.creator ? [row.creator] : []))]
    const names = await this.queryUsers(creators).catch(() => new Map<string, string>())
    const comments = rows.map((row): WorkItemComment => ({
      id: row.comment_id,
      author: (row.creator && names.get(row.creator)) || '飞书用户',
      content: row.content?.rich_text?.markdown_content?.markdown ?? row.content?.text ?? row.content?.rich_text?.doc_text ?? '请在飞书项目查看此条评论。',
      createdAt: toMilliseconds(row.content?.create_time)
    }))
    const nextCursor = data.next_cursor ?? next_cursor
    return { comments, hasMore: Boolean(nextCursor && nextCursor !== cursor), ...(nextCursor && nextCursor !== cursor ? { nextCursor } : {}) }
  }

  async addComment(typeKey: string, id: WorkItemId, content: string): Promise<void> {
    const { data } = await this.apiCall<{ comment_id?: unknown }>('/open_api/comment/create', { body: {
      project_key: this.config.projectKey,
      object: commentObject(typeKey, id),
      content: { type: 'RICHTEXT', markdown: content }
    }, write: true })
    if (!commentIdOf(data?.comment_id)) throw new MeegoApiError('WRITE_UNVERIFIED', '飞书项目没有返回评论编号，请先刷新确认是否已发布。')
  }

  /** POST /open_api/user/query — resolve user keys to display names. */
  async queryUsers(userKeys: string[]): Promise<Map<string, string>> {
    if (userKeys.length === 0) return new Map()
    const { data } = await this.apiCall<unknown>('/open_api/user/query', { body: { user_keys: userKeys } })
    return normalizeUsers(data)
  }
}
