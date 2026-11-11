import { MeegoApiError, requireWorkItemId, type RawWorkItem } from './client'
import type { McpManagementTool } from './mcp-client'
import type { WorkItemId } from '../protocol'
import { sameWorkItemId } from './work-item-id'
import {
  object, text, key, supports, STRING, STRINGS, SCOPE, FIELDS, ROLE_OPERATE,
  fieldRows, fieldKey, fieldType, optionsOf, nativeFields,
  nativeOperators, nativePriority, nativeRoleMembers, roleConfigPage, transitionsOf, requirementsComplete,
  type NativeRoleMembers
} from './work-item-edit-metadata'

type RecordValue = Record<string, unknown>
type ToolCall = (name: string, args: RecordValue, write?: boolean, beforeSend?: () => Promise<void>) => Promise<unknown>
type Capability = { state: 'available' | 'browserOnly'; reason?: string }

export interface WorkItemEditOption {
  key: string
  label: string
}

export interface WorkItemStateTransition {
  id: string
  label: string
  targetStateKey: string
}

export interface WorkItemRoleOption {
  key: string
  label: string
  userKeys: string[]
  users?: { key: string; name: string }[]
}

export interface WorkItemEditOptions {
  priority: Capability & { currentKey: string | null; options: WorkItemEditOption[] }
  status: Capability & { currentKey: string | null; transitions: WorkItemStateTransition[] }
  operators: Capability & { userKeys: string[]; multiple: boolean }
  roles?: Capability & { options: WorkItemRoleOption[] }
  text: { title: Capability; description: Capability }
}

export type WorkItemEditResult = { state: 'confirmed'; item: RawWorkItem } | { state: 'unverified' }

interface EditorDependencies {
  projectKey: string
  userKey: string
  call: ToolCall
  catalog: () => Promise<McpManagementTool[]>
  readWorkItem: (id: WorkItemId, typeKey: string) => Promise<RawWorkItem | null>
}

function browserOnly(reason: string): Capability {
  return { state: 'browserOnly', reason }
}

const CURRENT_OPERATORS_READ_ONLY = '当前负责人是流程计算字段，不能直接修改；可在「角色成员」调整实际角色，或到飞书项目网页中处理。'
const ROLE_CONFIG = { project_key: STRING, work_item_type: STRING, role_keys: STRINGS, page_num: { type: 'number' } }
const ROLE_UPDATE = { ...SCOPE, role_operate: ROLE_OPERATE }
const USER_LOOKUP = { project_key: STRING, user_keys: STRINGS, need_all_status: { type: 'boolean' } }

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key))
}

function unavailable(reason = '此项修改需要在飞书项目网页中完成，请刷新详情后重试。'): never {
  throw new MeegoApiError('EDIT_UNAVAILABLE', reason)
}

/** Edits stay scoped to one authenticated account and space. */
export class MeegoWorkItemEditor {
  constructor(private readonly dependencies: EditorDependencies) {
    if (!dependencies.projectKey || !dependencies.userKey) unavailable()
  }

  private async optionalRead(name: string, args: RecordValue): Promise<unknown> {
    try {
      return await this.dependencies.call(name, args)
    } catch (error) {
      if (error instanceof MeegoApiError && ['MCP_FORBIDDEN', 'MCP_TOOL_ERROR'].includes(String(error.code))) return undefined
      throw error
    }
  }

  private args(id: WorkItemId): RecordValue {
    return { project_key: this.dependencies.projectKey, work_item_id: String(requireWorkItemId(id)) }
  }

  private async read(id: WorkItemId, typeKey: string): Promise<RawWorkItem> {
    const item = await this.dependencies.readWorkItem(requireWorkItemId(id), typeKey)
    if (!item || !sameWorkItemId(item.id, id) || item.typeKey !== typeKey || item.projectKey !== this.dependencies.projectKey) {
      throw new MeegoApiError('WORK_ITEM_UNAVAILABLE', '工作项已变化，请刷新详情。')
    }
    return item
  }

  private async metadata(typeKey: string): Promise<RecordValue[]> {
    const fields: RecordValue[] = []
    for (let page = 1; page <= 10; page += 1) {
      const payload = await this.optionalRead('list_workitem_field_config', {
        project_key: this.dependencies.projectKey, work_item_type: typeKey,
        field_keys: ['priority', 'current_status_operator', 'work_item_status', 'name', 'description'], page_num: page
      })
      if (payload === undefined) return []
      fields.push(...fieldRows(payload))
      if (object(object(payload).pagination).has_more !== true && object(payload).has_more !== true) return fields
    }
    throw new MeegoApiError('BAD_EDIT_OPTIONS', '字段编辑配置分页过多，请在飞书项目中修改。')
  }

  private async snapshot(id: WorkItemId, typeKey: string) {
    const item = await this.read(id, typeKey)
    const catalog = await this.dependencies.catalog()
    const metadataSupported = supports(catalog, 'list_workitem_field_config', {
      project_key: STRING, work_item_type: STRING, field_keys: STRINGS, page_num: { type: 'number' }
    })
    const fields = metadataSupported ? await this.metadata(typeKey) : []
    const nativeSupported = supports(catalog, 'get_workitem_brief', { ...SCOPE, fields: STRINGS })
    const native = nativeSupported ? await this.optionalRead('get_workitem_brief', {
      ...this.args(id), fields: fields.map(fieldKey).filter((field) => field !== 'work_item_status')
    }) : undefined
    const payload = object(native)
    const attribute = object(payload.work_item_attribute)
    if (native !== undefined && (!sameWorkItemId(key(attribute.work_item_id), id) ||
      text(object(attribute.owned_project).key) !== this.dependencies.projectKey || text(object(attribute.work_item_type).key) !== typeKey)) {
      throw new MeegoApiError('WORK_ITEM_UNAVAILABLE', '工作项来源已变化，请刷新详情。')
    }
    return { item, catalog, fields: native === undefined ? [] : fields, attribute, values: nativeFields(payload), roles: nativeRoleMembers(attribute) }
  }

  private async roleOptions(typeKey: string, catalog: McpManagementTool[], native: NativeRoleMembers[] | null): Promise<NonNullable<WorkItemEditOptions['roles']>> {
    const unavailable = { ...browserOnly('当前连接未提供完整的角色成员编辑配置，请在飞书项目网页中修改。'), options: native ?? [] }
    if (native === null || native.length === 0 || native.length > 100 || !supports(catalog, 'update_field', ROLE_UPDATE) ||
      !supports(catalog, 'list_workitem_role_config', ROLE_CONFIG) || !supports(catalog, 'search_user_info', USER_LOOKUP)) return unavailable
    const configured = new Map<string, string>()
    for (let page = 1; page <= 10; page += 1) {
      const payload = await this.optionalRead('list_workitem_role_config', {
        project_key: this.dependencies.projectKey, work_item_type: typeKey,
        role_keys: native.map((role) => role.key), page_num: page
      })
      const result = roleConfigPage(payload, page)
      if (!result) return unavailable
      for (const role of result.roles) {
        if (configured.has(role.key)) return unavailable
        configured.set(role.key, role.label)
      }
      // The first-party tool may ignore role_keys and return the entire type's
      // catalog. Only native roles already attached to this item are exposed.
      if (!result.hasMore) return native.every((role) => configured.get(role.key) === role.label)
        ? { state: 'available', options: native } : unavailable
    }
    return unavailable
  }

  async options(id: WorkItemId, typeKey: string): Promise<WorkItemEditOptions> {
    const { catalog, fields, attribute, values, roles } = await this.snapshot(id, typeKey)
    const writable = supports(catalog, 'update_field', { ...SCOPE, fields: FIELDS })
    const capability = (supported: boolean): Capability => supported && writable
      ? { state: 'available' } : browserOnly('当前连接未提供该字段的完整编辑能力，请在飞书项目中修改。')
    const priority = fields.find((field) => fieldKey(field) === 'priority')
    const options = optionsOf(priority)
    const currentPriority = nativePriority(values.get('priority'))
    const operatorField = fields.find((field) => fieldKey(field) === 'current_status_operator')
    const operatorType = fieldType(operatorField ?? {})
    const operators = nativeOperators(values.get('current_status_operator'))
    const name = fields.find((field) => fieldKey(field) === 'name')
    const description = fields.find((field) => fieldKey(field) === 'description')
    const priorityEditable = Boolean(priority && ['select', 'radio'].includes(fieldType(priority)) &&
      options.length && values.has('priority') && currentPriority !== undefined)
    const statusKey = text(object(attribute.work_item_status).key) || null
    let status: WorkItemEditOptions['status'] = { ...browserOnly('请在飞书项目中操作当前流程。'), currentKey: statusKey, transitions: [] }
    if (attribute.work_item_mod === '状态流' && statusKey && supports(catalog, 'get_transitable_states', {
      ...SCOPE, work_item_type: STRING, user_key: STRING
    }) && supports(catalog, 'transition_state', { ...SCOPE, transition_id: STRING }) &&
      supports(catalog, 'get_transition_required', { ...SCOPE, state_key: STRING, mode: STRING })) {
      const payload = await this.optionalRead('get_transitable_states', {
        ...this.args(id), work_item_type: typeKey, user_key: this.dependencies.userKey
      })
      const transitions = transitionsOf(payload, statusKey)
      status = transitions === null ? status : { state: 'available', currentKey: statusKey, transitions }
    }
    return {
      priority: { ...capability(priorityEditable), currentKey: currentPriority ?? null, options },
      status,
      // This field is a computed read model. A generic multi-user schema and
      // update_field tool do not authorize changing its source roles or workflow.
      operators: { ...browserOnly(attribute.work_item_mod === '节点流' ? '当前负责人由节点流程计算，请在「角色成员」或「流程节点」中调整，或到飞书项目网页中处理。' : CURRENT_OPERATORS_READ_ONLY), userKeys: operators ?? [], multiple: operatorType === 'multi-user' },
      roles: await this.roleOptions(typeKey, catalog, roles),
      text: {
        title: capability(Boolean(name && ['text', '-name'].includes(fieldType(name)))),
        description: capability(Boolean(description && ['multi-text', 'multi-pure-text', 'text'].includes(fieldType(description))))
      }
    }
  }

  async searchUsers(query: string): Promise<{ key: string; name: string }[]> {
    if (!query.trim()) return []
    return this.users([query.trim()])
  }

  private async users(queries: string[]): Promise<{ key: string; name: string }[]> {
    const catalog = await this.dependencies.catalog()
    if (!supports(catalog, 'search_user_info', { project_key: STRING, user_keys: STRINGS, need_all_status: { type: 'boolean' } })) unavailable()
    const data = await this.dependencies.call('search_user_info', { project_key: this.dependencies.projectKey, user_keys: queries, need_all_status: false })
    const rows = Array.isArray(data) ? data : object(data).list
    if (!Array.isArray(rows)) throw new MeegoApiError('BAD_EDIT_OPTIONS', '飞书项目没有返回人员列表。')
    return rows.map(object).flatMap((user) => {
      const userKey = text(user.user_key)
      const name = text(user.name_cn) || text(user.name_en) || text(user.name)
      return userKey && name ? [{ key: userKey, name }] : []
    })
  }

  private async mutate(id: WorkItemId, name: string, args: RecordValue, verify: () => Promise<RawWorkItem | null>): Promise<WorkItemEditResult> {
    try {
      await this.dependencies.call(name, { ...this.args(id), ...args }, true)
    } catch (error) {
      if (error instanceof MeegoApiError && error.code === 'WRITE_UNVERIFIED') return { state: 'unverified' }
      throw error
    }
    try {
      const item = await verify()
      return item ? { state: 'confirmed', item } : { state: 'unverified' }
    } catch {
      return { state: 'unverified' }
    }
  }

  async updatePriority(id: WorkItemId, typeKey: string, optionKey: string): Promise<WorkItemEditResult> {
    const options = await this.options(id, typeKey)
    if (options.priority.state !== 'available' || !options.priority.options.some((option) => option.key === optionKey)) unavailable()
    return this.mutate(id, 'update_field', { fields: [{ field_key: 'priority', field_value: optionKey }] }, async () => {
      const snapshot = await this.snapshot(id, typeKey)
      return nativePriority(snapshot.values.get('priority')) === optionKey ? snapshot.item : null
    })
  }

  async updateCurrentOperators(_id: WorkItemId, _typeKey: string, _userKeys: string[]): Promise<WorkItemEditResult> {
    // Keep stale panel requests from bypassing the read-only capability. Role
    // changes are separate operations and cannot be inferred from these keys.
    unavailable(CURRENT_OPERATORS_READ_ONLY)
  }

  async updateRoleMembers(id: WorkItemId, typeKey: string, roleKey: string, userKeys: string[]): Promise<WorkItemEditResult> {
    if (typeof roleKey !== 'string' || !roleKey.trim() || roleKey === '_all' || !Array.isArray(userKeys) || userKeys.length > 20 ||
      userKeys.some((value) => typeof value !== 'string' || !value.trim() || value === '_all') || new Set(userKeys).size !== userKeys.length) unavailable()
    const desired = [...userKeys]
    const before = await this.snapshot(id, typeKey)
    const options = await this.roleOptions(typeKey, before.catalog, before.roles)
    const role = options.options.find((row) => row.key === roleKey)
    if (options.state !== 'available' || !role) unavailable()
    if (sameMembers(role.userKeys, desired)) return { state: 'confirmed', item: before.item }
    const removed = role.userKeys.filter((key) => !desired.includes(key))
    const added = desired.filter((key) => !role.userKeys.includes(key))
    const verifyMembers = async () => {
      if (!added.length) return
      const users = await this.users(added)
      if (added.some((key) => !users.some((user) => user.key === key))) unavailable('角色成员已不可用，请重新搜索后选择。')
    }
    await verifyMembers()
    let preSendFailure: unknown
    let preSendFailed = false
    const beforeSend = async () => {
      try {
        const fresh = await this.snapshot(id, typeKey)
        const options = await this.roleOptions(typeKey, fresh.catalog, fresh.roles)
        const selected = options.options.find((row) => row.key === roleKey)
        if (options.state !== 'available' || !selected || selected.label !== role.label || !sameMembers(selected.userKeys, role.userKeys)) {
          throw new MeegoApiError('conflict', '角色配置或成员已变化，请刷新后重新选择。')
        }
        await verifyMembers()
      } catch (error) {
        preSendFailed = true
        preSendFailure = error
        throw error
      }
    }
    const role_operate = [
      ...(removed.length ? [{ op: 'remove', role_key: roleKey, user_keys: removed }] : []),
      ...(added.length ? [{ op: 'add', role_key: roleKey, user_keys: added }] : [])
    ]
    let failed = false
    let originalError: unknown
    try {
      await this.dependencies.call('update_field', { ...this.args(id), role_operate }, true, beforeSend)
    } catch (error) {
      if (preSendFailed && error === preSendFailure) throw error
      failed = true
      originalError = error
    }
    let after: Awaited<ReturnType<MeegoWorkItemEditor['snapshot']>>
    try {
      after = await this.snapshot(id, typeKey)
    } catch {
      return { state: 'unverified' }
    }
    const current = after.roles?.find((row) => row.key === roleKey)
    if (!current) return { state: 'unverified' }
    if (sameMembers(current.userKeys, desired)) return { state: 'confirmed', item: after.item }
    // An old read cannot disprove a late write after transport loss. Only an
    // explicit API rejection plus an unchanged target is a definitive failure.
    const explicitlyRejected = originalError instanceof MeegoApiError &&
      ['MCP_TOOL_ERROR', 'MCP_FORBIDDEN', 'MCP_RATE_LIMIT', 'MCP_HTTP'].includes(String(originalError.code))
    if (failed && explicitlyRejected && sameMembers(current.userKeys, role.userKeys)) throw originalError
    return { state: 'unverified' }
  }

  async transition(id: WorkItemId, typeKey: string, transitionId: string): Promise<WorkItemEditResult> {
    const options = await this.options(id, typeKey)
    const transition = options.status.transitions.find((entry) => entry.id === transitionId)
    if (options.status.state !== 'available' || !transition) unavailable()
    const required = await this.dependencies.call('get_transition_required', { ...this.args(id), state_key: transition.targetStateKey, mode: 'unfinished' })
    if (!requirementsComplete(required)) throw new MeegoApiError('TRANSITION_REQUIRED', '当前流转需要补全表单、子任务或交付物，请在飞书项目中完成。')
    return this.mutate(id, 'transition_state', { transition_id: transition.id }, async () => {
      const snapshot = await this.snapshot(id, typeKey)
      return text(object(snapshot.attribute.work_item_status).key) === transition.targetStateKey &&
        snapshot.item.status === transition.label ? snapshot.item : null
    })
  }

  async updateText(id: WorkItemId, typeKey: string, updates: { name?: string; description?: string }): Promise<WorkItemEditResult> {
    const entries = Object.entries(updates)
    if (entries.length !== 1) unavailable()
    const [field, value] = entries[0]
    if (!['name', 'description'].includes(field) || typeof value !== 'string' || (field === 'name' && !value.trim())) unavailable()
    const options = await this.options(id, typeKey)
    if (options.text[field === 'name' ? 'title' : 'description'].state !== 'available') unavailable()
    return this.mutate(id, 'update_field', { fields: [{ field_key: field, field_value: value }] }, async () => {
      const item = await this.read(id, typeKey)
      const matches = (field === 'name' ? item.name : item.description).replaceAll('\r\n', '\n') === value.replaceAll('\r\n', '\n')
      return matches ? item : null
    })
  }
}
