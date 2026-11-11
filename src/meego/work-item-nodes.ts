import { MeegoApiError, requireWorkItemId, type RawWorkItem } from './client'
import type { McpManagementTool } from './mcp-client'
import type { WorkItemId, WorkItemNode, WorkItemNodeList } from '../protocol'
import { sameWorkItemId } from './work-item-id'
import { object, text, key, supports, STRING, STRINGS, SCOPE, requirementsComplete } from './work-item-edit-metadata'
import { nodeBrowserOnly, parseNodePage, type NodeRecord } from './work-item-nodes-metadata'

type RecordValue = Record<string, unknown>

export type { WorkItemNode, WorkItemNodeList } from '../protocol'
export type WorkItemNodeCapability = WorkItemNode['actions']['confirm']

export type WorkItemNodeEditResult = { state: 'confirmed'; item: RawWorkItem; nodes: WorkItemNodeList } | { state: 'unverified' }

interface NodeDependencies {
  projectKey: string
  userKey: string
  call: (name: string, args: RecordValue, write?: boolean, beforeSend?: () => Promise<void>) => Promise<unknown>
  catalog: () => Promise<McpManagementTool[]>
  readWorkItem: (id: WorkItemId, typeKey: string) => Promise<RawWorkItem | null>
}

interface NodeTarget {
  nodeKey: string
  expectedRevision: string
}

const NODE_READ = { ...SCOPE, node_id_list: STRINGS, need_sub_task: { type: 'boolean' }, page_num: { type: 'number' } }
const TRANSITION_READ = { ...SCOPE, state_key: STRING, mode: STRING }
const TRANSITION_WRITE = { ...SCOPE, node_id: STRING, action: STRING, rollback_reason: STRING }
const OWNER_WRITE = { ...SCOPE, node_id: STRING, node_owners: STRINGS }
const USER_READ = { project_key: STRING, user_keys: STRINGS, need_all_status: { type: 'boolean' } }
const MAX_NODE_LIST_PAGES = 5

function unavailable(reason = '此节点需要在飞书项目网页中操作。'): never {
  throw new MeegoApiError('NODE_UNAVAILABLE', reason)
}

export class MeegoWorkItemNodes {
  constructor(private readonly dependencies: NodeDependencies) {
    if (!dependencies.projectKey || !dependencies.userKey) unavailable()
  }

  private args(id: WorkItemId): RecordValue {
    return { project_key: this.dependencies.projectKey, work_item_id: String(requireWorkItemId(id)) }
  }

  private async item(id: WorkItemId, typeKey: string): Promise<RawWorkItem> {
    const item = await this.dependencies.readWorkItem(requireWorkItemId(id), typeKey)
    if (!item || !sameWorkItemId(item.id, id) || item.typeKey !== typeKey || item.projectKey !== this.dependencies.projectKey) {
      throw new MeegoApiError('WORK_ITEM_UNAVAILABLE', '工作项来源已变化，请刷新详情。')
    }
    return item
  }

  private async context(id: WorkItemId, typeKey: string): Promise<McpManagementTool[]> {
    await this.item(id, typeKey)
    const catalog = await this.dependencies.catalog()
    if (!supports(catalog, 'get_workitem_brief', SCOPE) || !supports(catalog, 'get_node_detail', NODE_READ)) unavailable()
    const payload = object(await this.dependencies.call('get_workitem_brief', this.args(id)))
    const attribute = object(payload.work_item_attribute)
    if (!sameWorkItemId(key(attribute.work_item_id), id) || text(object(attribute.work_item_type).key) !== typeKey ||
      text(object(attribute.owned_project).key) !== this.dependencies.projectKey) {
      throw new MeegoApiError('WORK_ITEM_UNAVAILABLE', '工作项来源已变化，请刷新详情。')
    }
    if (attribute.work_item_mod !== '节点流') unavailable('当前工作项不是可识别的节点流。')
    return catalog
  }

  private async records(id: WorkItemId, nodeKey?: string): Promise<NodeRecord[]> {
    const result = new Map<string, NodeRecord>()
    let template: string | undefined
    for (let page = 1; page <= MAX_NODE_LIST_PAGES; page += 1) {
      const data = await this.dependencies.call('get_node_detail', {
        ...this.args(id), node_id_list: nodeKey ? [nodeKey] : ['_all'], need_sub_task: false, page_num: page
      })
      const parsed = parseNodePage(data)
      if (template !== undefined && template !== parsed.templateRevision) throw new MeegoApiError('conflict', '节点流程版本已变化，请重新加载。')
      template = parsed.templateRevision
      for (const record of parsed.records) {
        if (result.has(record.node.key)) throw new MeegoApiError('BAD_NODE_RESPONSE', '节点分页返回了重复记录，请重新加载。')
        result.set(record.node.key, record)
        if (result.size > MAX_NODE_LIST_PAGES * 20) throw new MeegoApiError('BAD_NODE_RESPONSE', '节点数量过多，请在飞书项目中查看完整流程。')
      }
      if (!parsed.hasMore) return [...result.values()]
    }
    throw new MeegoApiError('BAD_NODE_RESPONSE', '节点分页超过 5 页，请在飞书项目中查看完整流程。')
  }

  private ownersCapability(record: NodeRecord, catalog: McpManagementTool[]): WorkItemNodeCapability {
    return record.ownersEditable && supports(catalog, 'update_node', OWNER_WRITE) && supports(catalog, 'search_user_info', USER_READ)
      ? { state: 'available' } : record.node.actions.owners
  }

  async list(id: WorkItemId, typeKey: string): Promise<WorkItemNodeList> {
    try {
      const catalog = await this.context(id, typeKey)
      const records = await this.records(id)
      return { state: 'available', nodes: records.map((record) => ({
        ...record.node, actions: { ...record.node.actions, owners: this.ownersCapability(record, catalog) }
      })) }
    } catch (error) {
      if (error instanceof MeegoApiError && ['NODE_UNAVAILABLE', 'BAD_NODE_RESPONSE', 'MCP_FORBIDDEN', 'MCP_TOOL_ERROR'].includes(String(error.code))) {
        return { ...nodeBrowserOnly(error.message), nodes: [] }
      }
      throw error
    }
  }

  private async selected(id: WorkItemId, typeKey: string, nodeKey: string) {
    if (typeof nodeKey !== 'string' || !nodeKey || nodeKey === '_all') unavailable('请选择一个具体节点。')
    const catalog = await this.context(id, typeKey)
    const rows = await this.records(id, nodeKey)
    if (rows.length !== 1 || rows[0].node.key !== nodeKey) unavailable('所选节点已变化，请重新选择。')
    return { record: rows[0], catalog }
  }

  async inspect(id: WorkItemId, typeKey: string, nodeKey: string): Promise<WorkItemNode> {
    const { record, catalog } = await this.selected(id, typeKey, nodeKey)
    const node = record.node
    node.actions.owners = this.ownersCapability(record, catalog)
    if (!node.revision || !supports(catalog, 'transition_node', TRANSITION_WRITE) || !supports(catalog, 'get_transition_required', TRANSITION_READ)) return node
    let required: unknown
    try {
      required = await this.dependencies.call('get_transition_required', { ...this.args(id), state_key: nodeKey, mode: 'unfinished' })
    } catch (error) {
      if (!(error instanceof MeegoApiError) || !['MCP_FORBIDDEN', 'MCP_TOOL_ERROR'].includes(String(error.code))) throw error
    }
    if (!requirementsComplete(required)) {
      const blocked = nodeBrowserOnly('此节点需要补齐表单、子任务或交付物，请在飞书项目中完成。')
      node.actions.confirm = blocked
      node.actions.rollback = blocked
      return node
    }
    node.actions.confirm = node.status === 'doing' ? { state: 'available' } : nodeBrowserOnly('只有进行中的节点可以完成。')
    node.actions.rollback = node.status === 'finished' ? { state: 'available' } : nodeBrowserOnly('只有已完成的节点可以回退。')
    return node
  }

  private assertRevision(node: WorkItemNode, expected: string): void {
    if (!expected || !node.revision || node.revision !== expected) throw new MeegoApiError('conflict', '节点状态或负责人已变化，请刷新后重新选择。')
  }

  private async write(id: WorkItemId, typeKey: string, target: NodeTarget, name: string, args: RecordValue, matches: (node: WorkItemNode) => boolean): Promise<WorkItemNodeEditResult> {
    const beforeSend = async () => {
      const { record, catalog } = await this.selected(id, typeKey, target.nodeKey)
      this.assertRevision(record.node, target.expectedRevision)
      if (name === 'transition_node') {
        if (!supports(catalog, 'get_transition_required', TRANSITION_READ) || !supports(catalog, name, TRANSITION_WRITE)) unavailable()
        const required = await this.dependencies.call('get_transition_required', { ...this.args(id), state_key: target.nodeKey, mode: 'unfinished' })
        if (!requirementsComplete(required)) throw new MeegoApiError('conflict', '节点流转条件已变化，请重新检查必填信息。')
        const latest = await this.records(id, target.nodeKey)
        if (latest.length !== 1) unavailable('所选节点已变化，请重新选择。')
        this.assertRevision(latest[0].node, target.expectedRevision)
      } else if (this.ownersCapability(record, catalog).state !== 'available') {
        unavailable(record.node.actions.owners.reason)
      }
    }
    try {
      await this.dependencies.call(name, { ...this.args(id), ...args }, true, beforeSend)
    } catch (error) {
      if (error instanceof MeegoApiError && error.code === 'WRITE_UNVERIFIED') return { state: 'unverified' }
      throw error
    }
    try {
      const { record } = await this.selected(id, typeKey, target.nodeKey)
      if (!record.node.revision || !matches(record.node)) return { state: 'unverified' }
      const item = await this.item(id, typeKey)
      return { state: 'confirmed', item, nodes: await this.list(id, typeKey) }
    } catch {
      return { state: 'unverified' }
    }
  }

  async transition(id: WorkItemId, typeKey: string, target: NodeTarget & { action: 'confirm' | 'rollback'; reason?: string }): Promise<WorkItemNodeEditResult> {
    if (target.action !== 'confirm' && target.action !== 'rollback') unavailable()
    const node = await this.inspect(id, typeKey, target.nodeKey)
    this.assertRevision(node, target.expectedRevision)
    if (node.actions[target.action].state !== 'available') unavailable(node.actions[target.action].reason)
    if (target.action === 'rollback' && (typeof target.reason !== 'string' || !target.reason.trim())) unavailable('请填写节点回退原因。')
    const args = { node_id: target.nodeKey, action: target.action, ...(target.action === 'rollback' ? { rollback_reason: target.reason!.trim() } : {}) }
    return this.write(id, typeKey, target, 'transition_node', args, (current) => current.status === (target.action === 'confirm' ? 'finished' : 'doing'))
  }

  async updateOwners(id: WorkItemId, typeKey: string, target: NodeTarget & { userKeys: string[] }): Promise<WorkItemNodeEditResult> {
    const keys = target.userKeys
    if (!Array.isArray(keys) || keys.length > 20 || keys.some((value) => typeof value !== 'string' || !value.trim()) || new Set(keys).size !== keys.length) unavailable('请从当前空间选择节点负责人。')
    const { record, catalog } = await this.selected(id, typeKey, target.nodeKey)
    this.assertRevision(record.node, target.expectedRevision)
    if (this.ownersCapability(record, catalog).state !== 'available') unavailable(record.node.actions.owners.reason)
    if (keys.length) {
      const data = await this.dependencies.call('search_user_info', { project_key: this.dependencies.projectKey, user_keys: keys, need_all_status: false })
      const users = Array.isArray(data) ? data : object(data).list
      if (!Array.isArray(users) || keys.some((userKey) => !users.some((user) => object(user).user_key === userKey))) unavailable('负责人已不可用，请重新选择。')
    }
    return this.write(id, typeKey, target, 'update_node', { node_id: target.nodeKey, node_owners: keys },
      (node) => node.owners.length === keys.length && node.owners.every((owner) => keys.includes(owner.key)))
  }
}
