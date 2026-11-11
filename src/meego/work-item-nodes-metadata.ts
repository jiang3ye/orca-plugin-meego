import { MeegoApiError } from './client'
import { createHash } from 'node:crypto'
import { key, object, text } from './work-item-edit-metadata'
import type { WorkItemNode, WorkItemNodeCapability } from './work-item-nodes'

type RecordValue = Record<string, unknown>

export interface NodeRecord {
  node: WorkItemNode
  ownersEditable: boolean
}

export function nodeBrowserOnly(reason: string): WorkItemNodeCapability {
  return { state: 'browserOnly', reason }
}

function malformed(): never {
  throw new MeegoApiError('BAD_NODE_RESPONSE', '飞书项目没有返回可识别的节点配置，请在网页中查看。')
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry !== '') ? value : null
}

function nodeOwners(value: unknown): WorkItemNode['owners'] | null {
  if (!Array.isArray(value)) return null
  const owners = value.map(object).map((owner) => ({ key: text(owner.user_key), name: text(owner.name) || text(owner.user_key) }))
  if (owners.some((owner) => !owner.key) || new Set(owners.map((owner) => owner.key)).size !== owners.length) return null
  return owners
}

function roleOwners(value: unknown): [string, string[]][] | null {
  if (value === null || value === undefined) return []
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const result: [string, string[]][] = []
  for (const [role, users] of Object.entries(value)) {
    const owners = nodeOwners(users)
    if (!owners) return null
    result.push([role, owners.map((owner) => owner.key).sort()])
  }
  return result.sort(([left], [right]) => left.localeCompare(right))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]))
  return value
}

function parseNode(value: unknown, template: RecordValue): NodeRecord {
  const row = object(value)
  const basic = object(row.basic)
  const nodeKey = text(basic.node_key)
  const name = text(basic.name)
  if (!nodeKey || nodeKey === '_all' || !name) malformed()
  const state = text(basic.status)
  const status = state === 'doing' || state === 'finished' || state === 'not_started' ? state : 'unknown'
  const assignees = object(row.assignees)
  const owners = nodeOwners(assignees.owners)
  const roles = roleOwners(assignees.role_assignees)
  const before = strings(basic.pre_node_keys)
  const after = strings(basic.next_node_keys)
  const uuid = text(basic.node_uuid)
  const formItems = row.form_items
  const formKnown = Array.isArray(formItems) && formItems.every((entry) => {
    const field = object(entry)
    return typeof field.form_item_type === 'string' && typeof field.field_key === 'string' && typeof field.is_required === 'boolean'
  })
  const ownerModeKnown = assignees.node_owner_mode === undefined || assignees.node_owner_mode === 3
  const revisionKnown = Boolean(uuid && owners && roles && before && after && formKnown && ownerModeKnown && status !== 'unknown')
  const revisionValue = revisionKnown ? [
    key(template.template_id), key(template.template_version), uuid, nodeKey, status,
    before!.slice().sort(), after!.slice().sort(), owners!.map((owner) => owner.key).sort(), roles, assignees.node_owner_mode ?? null,
    canonical(row.schedule ?? null),
    Array.isArray(row.assignee_schedule_list) ? row.assignee_schedule_list.map((entry) => {
      const schedule = object(entry)
      return JSON.stringify([text(object(schedule.assignee).user_key), canonical(schedule.schedule_info ?? null)])
    }).sort() : canonical(row.assignee_schedule_list ?? null),
    (formItems as RecordValue[]).map((field) => JSON.stringify([field.form_item_type, field.field_key, field.field_type, field.is_required, canonical(field.value ?? null)])).sort(),
    canonical(row.sub_tasks ?? null), canonical(row.sub_workitems ?? null)
  ] : null
  const revision = revisionValue === null ? '' : createHash('sha256').update(JSON.stringify(revisionValue)).digest('hex')
  // Bound roles use role_assignee in OpenAPI, which this MCP catalog does not expose.
  const ownersEditable = revisionKnown && roles!.length === 0 && assignees.role_assignees != null && assignees.node_owner_mode === undefined
  const unavailable = nodeBrowserOnly(revisionKnown ? '选择节点后检查流转条件。' : '节点配置不完整，请在飞书项目中操作。')
  return {
    node: {
      key: nodeKey, name, status, owners: owners ?? [], revision,
      actions: { confirm: unavailable, rollback: unavailable, owners: nodeBrowserOnly('此节点的负责人分配方式需要在飞书项目中修改。') }
    },
    ownersEditable
  }
}

export function parseNodePage(payload: unknown): { records: NodeRecord[]; hasMore: boolean; templateRevision: string } {
  const data = object(payload)
  const template = object(data.workflow_template)
  if (!key(template.template_id) || !key(template.template_version) || !Array.isArray(data.list)) malformed()
  const pagination = object(data.pagination)
  if (typeof pagination.has_more !== 'boolean') malformed()
  const records = data.list.map((node) => parseNode(node, template))
  if (new Set(records.map(({ node }) => node.key)).size !== records.length) malformed()
  return { records, hasMore: pagination.has_more, templateRevision: JSON.stringify([template.template_id, template.template_version]) }
}
