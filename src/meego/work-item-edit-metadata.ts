import { MeegoApiError } from './client'
import type { McpManagementTool } from './mcp-client'
import type { WorkItemEditOption, WorkItemStateTransition } from './work-item-edit'

type RecordValue = Record<string, unknown>

export function object(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function key(value: unknown): string {
  return text(value) || (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '')
}

// Unknown unions and additional required inputs need a reviewed adapter.
function schemaMatches(actual: unknown, expected: unknown): boolean {
  const schema = object(actual)
  const contract = object(expected)
  if (schema.type !== contract.type || schema.$ref || schema.anyOf || schema.oneOf || schema.allOf || schema.enum !== undefined) return false
  if (contract.type === 'array') return schemaMatches(schema.items, contract.items)
  if (contract.type !== 'object') return true
  const properties = object(schema.properties)
  const wanted = object(contract.properties)
  const required = schema.required ?? []
  return Array.isArray(required) && required.every((name) => typeof name === 'string' && name in wanted) &&
    Object.entries(wanted).every(([name, type]) => schemaMatches(properties[name], type))
}

export const STRING = { type: 'string' }
export const STRINGS = { type: 'array', items: STRING }
export const SCOPE = { project_key: STRING, work_item_id: STRING }
export const FIELDS = { type: 'array', items: { type: 'object', properties: { field_key: STRING, field_value: STRING } } }
export const ROLE_OPERATE = { type: 'array', items: {
  type: 'object', properties: { op: STRING, role_key: STRING, user_keys: STRINGS }
} }

export interface NativeRoleMembers {
  key: string
  label: string
  userKeys: string[]
  users: { key: string; name: string }[]
}

/** A complete native role array is required; missing members means an empty role. */
export function nativeRoleMembers(attribute: RecordValue): NativeRoleMembers[] | null {
  if (!Array.isArray(attribute.role_members)) return null
  const roles: NativeRoleMembers[] = []
  for (const value of attribute.role_members) {
    const row = object(value)
    const roleKey = text(row.key)
    const label = text(row.name)
    if (!roleKey.trim() || roleKey === '_all' || !label.trim() ||
      (row.members !== undefined && !Array.isArray(row.members)) || roles.some((role) => role.key === roleKey)) return null
    const userKeys: string[] = []
    const users: NativeRoleMembers['users'] = []
    for (const value of row.members as unknown[] | undefined ?? []) {
      const member = object(value)
      const memberKey = text(member.key)
      if (!memberKey.trim() || memberKey === '_all' || userKeys.includes(memberKey)) return null
      userKeys.push(memberKey)
      if (text(member.name).trim()) users.push({ key: memberKey, name: text(member.name) })
    }
    roles.push({ key: roleKey, label, userKeys, users })
  }
  return roles
}

export function roleConfigPage(payload: unknown, page: number): { roles: { key: string; label: string }[]; hasMore: boolean } | null {
  const record = object(payload)
  const pagination = object(record.pagination)
  if (!Array.isArray(record.list) || typeof pagination.has_more !== 'boolean' ||
    (pagination.page_num !== undefined && pagination.page_num !== page)) return null
  const roles: { key: string; label: string }[] = []
  for (const value of record.list) {
    const row = object(value)
    const roleKey = text(row.role_id)
    const label = text(row.role_name)
    if (!roleKey.trim() || roleKey === '_all' || !label.trim() || roles.some((role) => role.key === roleKey)) return null
    roles.push({ key: roleKey, label })
  }
  return { roles, hasMore: pagination.has_more }
}

export function supports(catalog: McpManagementTool[], name: string, properties: RecordValue): boolean {
  const tool = catalog.find((entry) => entry.name === name)
  return tool !== undefined && schemaMatches(tool.inputSchema, { type: 'object', properties })
}

export function fieldRows(payload: unknown): RecordValue[] {
  const record = object(payload)
  const rows = Array.isArray(payload) ? payload : record.list ?? record.fields ?? record.FieldConfList
  if (!Array.isArray(rows)) throw new MeegoApiError('BAD_EDIT_OPTIONS', '飞书项目没有返回字段编辑配置。')
  return rows.map(object)
}

export function fieldKey(field: RecordValue): string {
  return text(field.field_key ?? field.key)
}

export function fieldType(field: RecordValue): string {
  return text(field.field_type_key ?? field.type_key ?? field.field_type ?? field.type).replaceAll('_', '-')
}

export function optionsOf(field: RecordValue | undefined): WorkItemEditOption[] {
  const rows = field?.options ?? field?.option
  if (!Array.isArray(rows)) return []
  const options = rows.map(object).filter((option) => option.disabled !== true && option.disabled !== 1 && option.is_disabled !== true && option.is_disabled !== 1)
    .map((option) => ({ key: key(option.option_id ?? option.value ?? option.key), label: text(option.option_name ?? option.label ?? option.name) }))
  if (options.some((option) => !option.key || !option.label) || new Set(options.map((option) => option.key)).size !== options.length) return []
  return options
}

export function nativeFields(payload: RecordValue): Map<string, unknown> {
  const rows = payload.work_item_fields
  if (!Array.isArray(rows)) return new Map()
  return new Map(rows.map(object).map((field) => [fieldKey(field), field.value ?? field.field_value ?? null]))
}

export function nativePriority(value: unknown): string | null | undefined {
  if (value === null) return null
  return key(value) || key(object(value).value ?? object(value).option_id ?? object(value).key) || undefined
}

export function nativeOperators(value: unknown): string[] | null {
  if (value === null) return []
  if (typeof value === 'string' && value) return [value]
  if (!Array.isArray(value)) return null
  const keys = value.map((entry) => key(entry) || text(object(entry).key ?? object(entry).user_key))
  return keys.every(Boolean) && new Set(keys).size === keys.length ? keys : null
}

export function transitionsOf(payload: unknown, currentKey: string): WorkItemStateTransition[] | null {
  const record = object(payload)
  if (record.state_key !== currentKey || !Array.isArray(record.transition)) return null
  const transitions = record.transition.map(object).map((entry) => ({
    id: key(entry.id), targetStateKey: text(entry.state_key), label: text(entry.state_name)
  }))
  if (transitions.some((entry) => !entry.id || !entry.targetStateKey || !entry.label) || new Set(transitions.map((entry) => entry.id)).size !== transitions.length) return null
  return transitions
}

export function requirementsComplete(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const record = object(payload)
  // The first-party tool omits empty requirement categories and returns {} when clear.
  return Object.values(record).every((value) => value === null || (Array.isArray(value) && value.length === 0))
}
