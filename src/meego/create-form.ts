import type { CreateWorkItemField, CreateWorkItemForm, CreateWorkItemInput } from '../protocol'

type RecordValue = Record<string, unknown>

export class CreateFormError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CreateFormError'
  }
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

const CREATE_BUILTINS = new Set(['name', 'description', 'template'])
const TEXT_FIELD_TYPES = new Set(['text', 'multi-pure-text', 'multi-text', 'link'])
const SELECT_FIELD_TYPES = new Set(['select', 'radio', 'tree-select', 'signal'])

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function wireId(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : string(value)
}

function metadataRows(data: unknown): RecordValue[] {
  const record = object(data)
  const pagination = object(record.pagination)
  const rows = records(data, 'FieldConfList', 'fields', 'list', 'field_configs', 'work_item_fields', 'field_meta_list', 'field_list') ??
    (fieldKey(record) ? [record] : record.list === null && pagination.total === 0 ? [] : undefined)
  if (!rows) throw new CreateFormError('BAD_CREATE_FORM', '飞书项目没有返回创建字段配置。')
  return rows.map(object)
}

function fieldKey(field: RecordValue): string {
  return string(field.field_key, field.key)
}

function fieldType(field: RecordValue): string {
  return string(field.field_type_key, field.type_key, field.field_type, field.type)
}

function optionId(option: RecordValue): string {
  return wireId(option.option_id ?? option.id ?? option.value ?? option.key)
}

function optionLabel(option: RecordValue): string {
  return string(option.option_name, option.name, option.label, optionId(option))
}

function fieldOptions(field: RecordValue | undefined): unknown[] | undefined {
  return records(field?.option) ?? records(field?.options)
}

function selectOptions(options: unknown[], depth = 0): NonNullable<CreateWorkItemField['options']> {
  if (depth > 10) return []
  const result = new Map<string, string>()
  for (const row of options) {
    const option = object(row)
    if (isTrue(option.disabled)) continue
    const id = optionId(option)
    const label = optionLabel(option)
    const children = records(option.children) ?? []
    if (children.length) {
      for (const child of selectOptions(children, depth + 1)) result.set(child.value, `${label} / ${child.label}`)
    } else if (id) {
      result.set(id, label)
    }
  }
  return Array.from(result, ([value, label]) => ({ value, label }))
}

function createField(meta: RecordValue, config: RecordValue, accountUserKey: string): CreateWorkItemField | null {
  const key = fieldKey(meta)
  const label = string(meta.field_name, meta.field_alias, meta.name, meta.label, config.field_name, key)
  const field = { key, label, required: true }
  const type = fieldType(meta) || fieldType(config)
  if (TEXT_FIELD_TYPES.has(type)) return { ...field, kind: 'text' }
  if (type === 'number' || type === 'date') return { ...field, kind: type }
  if (type === 'bool' || type === 'boolean') return { ...field, kind: 'boolean' }
  if (accountUserKey && (type === 'user' || type === 'multi_user' || type === 'multi-user')) {
    return { ...field, kind: type === 'user' ? 'user' : 'multi-user', options: [{ value: accountUserKey, label: '我（当前飞书账号）' }] }
  }
  if (SELECT_FIELD_TYPES.has(type) || (accountUserKey && (type === 'business' || type === '_business'))) {
    const options = selectOptions(fieldOptions(config) ?? fieldOptions(meta) ?? [])
    if (options.length) return { ...field, kind: 'select', options }
  }
  return null
}

function formatCreateValue(field: CreateWorkItemField, value: string, domestic: boolean): string {
  if (field.kind === 'text') return value
  if (field.options?.some((option) => option.value === value)) return field.kind === 'multi-user' ? JSON.stringify([value]) : value
  if (field.kind === 'boolean' && (value === 'true' || value === 'false')) return value
  if (field.kind === 'number' && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))) return value
  if (field.kind === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const utc = Date.parse(`${value}T00:00:00Z`)
    if (Number.isFinite(utc) && new Date(utc).toISOString().slice(0, 10) === value) {
      // The domestic API's date examples represent midnight in UTC+08:00.
      return String(utc - (domestic ? 8 * 60 * 60 * 1000 : 0))
    }
  }
  throw new CreateFormError('INVALID_CREATE_FIELD', `请检查「${field.label}」的值。`)
}

export function requiredCreateFieldKeys(metadata: unknown): string[] {
  const keys = metadataRows(metadata)
    .filter((field) => isTrue(field.is_required ?? field.required))
    .map(fieldKey)
    .filter((key) => key && !CREATE_BUILTINS.has(key))
  return [...new Set(keys)]
}

export function buildCreateForm(metadata: unknown, configurations: readonly unknown[], browserUrl?: string, accountUserKey = ''): CreateWorkItemForm {
  const rows = metadataRows(metadata)
  const required = rows.filter((field) => isTrue(field.is_required ?? field.required))
  const configured = new Map(configurations.flatMap(metadataRows).map((field) => [fieldKey(field), field]))
  const template = configured.get('template') ?? rows.find((field) => fieldKey(field) === 'template')
  const templates = new Map<string, CreateWorkItemForm['templates'][number]>()
  for (const row of fieldOptions(template) ?? []) {
    const option = object(row)
    if (isTrue(option.disabled)) continue
    const id = optionId(option)
    if (id) templates.set(id, { id, name: optionLabel(option), ...(isTrue(option.is_default) ? { isDefault: true } : {}) })
  }
  const fields = new Map<string, CreateWorkItemField>()
  const unsupportedRequired = new Set<string>()
  for (const meta of required) {
    const key = fieldKey(meta)
    if (CREATE_BUILTINS.has(key)) continue
    const field = key ? createField(meta, configured.get(key) ?? {}, accountUserKey) : null
    if (field) {
      fields.set(key, field)
    } else {
      unsupportedRequired.add(string(meta.field_name, meta.field_alias, meta.name, key, '未命名字段'))
    }
  }
  return {
    templates: [...templates.values()], fields: [...fields.values()], unsupportedRequired: [...unsupportedRequired],
    ...(required.some((field) => fieldKey(field) === 'description') ? { descriptionRequired: true } : {}),
    ...(browserUrl ? { browserUrl } : {})
  }
}

export function validateCreateForm(form: CreateWorkItemForm, input: CreateWorkItemInput, domestic: boolean): {
  templateId: string
  fields: { field: CreateWorkItemField; value: string }[]
} {
  if (form.unsupportedRequired.length) {
    throw new CreateFormError('UNSUPPORTED_CREATE_FIELDS', `请在飞书项目网页填写：${form.unsupportedRequired.join('、')}。`)
  }
  const defaults = form.templates.filter((item) => item.isDefault)
  const template = input.templateId || (form.templates.length === 1 ? form.templates[0].id : defaults.length === 1 ? defaults[0].id : '')
  if (!form.templates.some((item) => item.id === template)) {
    throw new CreateFormError('TEMPLATE_REQUIRED', '请选择该工作项类型的可用创建模板。')
  }
  if (form.descriptionRequired && !input.description?.trim()) {
    throw new CreateFormError('INVALID_CREATE_FIELD', '请填写「描述」。')
  }
  const values = input.fieldValues ?? {}
  const known = new Set(form.fields.map((field) => field.key))
  if (Object.keys(values).some((key) => !known.has(key))) {
    throw new CreateFormError('INVALID_CREATE_FIELD', '创建字段已变化，请重新打开创建表单。')
  }
  const fields = form.fields.flatMap((field) => {
    const value = values[field.key]
    if (typeof value !== 'string' || !value.trim()) {
      if (field.required) throw new CreateFormError('INVALID_CREATE_FIELD', `请填写「${field.label}」。`)
      return []
    }
    return [{ field, value: formatCreateValue(field, value.trim(), domestic) }]
  })
  return { templateId: template, fields }
}
