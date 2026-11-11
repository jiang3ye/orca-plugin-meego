import type { OrcaWorkerApi } from 'orca/worker'
import type { MeegoConfig } from './meego/config'
import { RequestError, type MeegoConnection, type ProjectClient } from './meego/connection'
import type { MeegoMcpClient } from './meego/mcp-client'
import type { RawWorkItem } from './meego/client'
import { invalidateLists } from './meego/cache'
import { parseWorkItemId } from './meego/work-item-id'
import type { WorkItemEditResult } from './meego/work-item-edit'
import type { WorkItemDetail, WorkItemEditOptions, WorkItemId, WorkItemNode, WorkItemNodeList, WorkItemReference } from './protocol'

interface Projection {
  read(project: ProjectClient, id: WorkItemId, typeKey: string): Promise<WorkItemDetail>
  detail(raw: RawWorkItem, users: Map<string, string>, config: MeegoConfig): WorkItemDetail
  users(client: ProjectClient['client'], items: RawWorkItem[]): Promise<Map<string, string>>
}

interface EditSession {
  client: MeegoMcpClient
  config: MeegoConfig
  id: WorkItemId
  beforeWrite(): Promise<void>
}

function browserOptions(reason: string): WorkItemEditOptions {
  const blocked = { state: 'browserOnly' as const, reason }
  return {
    priority: { ...blocked, currentKey: null, options: [] },
    status: { ...blocked, currentKey: null, transitions: [] },
    operators: { ...blocked, userKeys: [], users: [], multiple: false },
    text: { title: blocked, description: blocked }
  }
}

function versionedNode(node: WorkItemNode, item: WorkItemDetail): WorkItemNode {
  if (item.updatedAt !== null) return node
  const blocked = { state: 'browserOnly' as const, reason: '无法确认工作项版本，请在飞书项目中操作。' }
  return { ...node, actions: { confirm: blocked, rollback: blocked, owners: blocked } }
}

/** Field and node writes share one scope lock and repeat their version check before each send. */
export function registerWorkItemEdits(orca: OrcaWorkerApi, connection: MeegoConnection, projection: Projection): void {
  const editing = new Set<string>()

  async function perform<T>(input: WorkItemReference & { expectedUpdatedAt: number | null }, signal: AbortSignal | undefined, effect: (session: EditSession) => Promise<T>): Promise<T> {
    const project = await connection.project(input.source, input.expectedUserKey)
    const { client, config } = project
    if (!('editor' in client)) throw new RequestError('unsupported', '当前企业连接请在飞书项目中修改详情。')
    const id = parseWorkItemId(input.id)
    if (id === null || typeof input.typeKey !== 'string' || !input.typeKey.trim()) throw new RequestError('invalid_input', '工作项编号或类型无效。')
    const lock = JSON.stringify([config.baseUrl, config.projectKey, config.userKey, input.typeKey, String(id)])
    if (editing.has(lock)) throw new RequestError('busy', '此工作项正在保存，请稍候。')
    editing.add(lock)
    try {
      return await effect({ client, config, id, beforeWrite: async () => {
        signal?.throwIfAborted()
        const current = await connection.project(input.source, input.expectedUserKey)
        if (current.client !== client) throw new RequestError('conflict', '连接已变化，请重新打开工作项。')
        const baseline = await projection.read(current, id, input.typeKey)
        if (typeof input.expectedUpdatedAt !== 'number' || !Number.isFinite(input.expectedUpdatedAt) || baseline.updatedAt === null || baseline.updatedAt !== input.expectedUpdatedAt) {
          throw new RequestError('conflict', '无法确认工作项版本，或内容已被更新，请刷新后再修改。')
        }
        signal?.throwIfAborted()
      } })
    } finally {
      editing.delete(lock)
      invalidateLists(client)
    }
  }

  async function describe(item: RawWorkItem, client: ProjectClient['client'], config: MeegoConfig): Promise<WorkItemDetail> {
    return projection.detail(item, await projection.users(client, [item]), config)
  }

  async function namedNodes(client: MeegoMcpClient, list: WorkItemNodeList, item: WorkItemDetail): Promise<WorkItemNodeList> {
    const keys = [...new Set(list.nodes.flatMap((node) => node.owners.map((owner) => owner.key)))]
    const names = await client.queryUsers(keys).catch(() => new Map<string, string>())
    return { ...list, nodes: list.nodes.map((node) => versionedNode({ ...node,
      owners: node.owners.map((owner) => ({ ...owner, name: names.get(owner.key) || owner.name || '成员信息暂不可用' }))
    }, item)) }
  }

  orca.panels.handle('meego.editOptions', async (ref) => {
    const project = await connection.project(ref.source, ref.expectedUserKey)
    const baseline = await projection.read(project, ref.id, ref.typeKey)
    if (!('editor' in project.client)) return { options: browserOptions('当前企业连接的详情编辑请在飞书项目中完成。') }
    if (baseline.updatedAt === null) return { options: browserOptions('无法确认此工作项的更新时间，请在飞书项目中修改。') }
    const { roles, ...options } = await project.client.editor().options(ref.id, ref.typeKey)
    if (baseline.description.length > 10_000) options.text.description = { state: 'browserOnly', reason: '现有描述超过侧栏的编辑长度，请在飞书项目中完整修改。' }
    const names = await project.client.queryUsers([...new Set([...options.operators.userKeys, ...(roles?.options.flatMap((role) => role.userKeys) ?? [])])]).catch(() => new Map<string, string>())
    return { options: { ...options, operators: { ...options.operators,
      users: options.operators.userKeys.map((key) => ({ key, name: names.get(key) ?? key }))
    }, ...(roles ? { roles: { ...roles, options: roles.options.map((role) => ({ ...role, users: role.userKeys.map((key) => ({ key, name: names.get(key) ?? role.users?.find((user) => user.key === key)?.name ?? '成员信息暂不可用' })) })) } } : {}) } }
  })

  orca.panels.handle('meego.searchMembers', async ({ query, ...ref }) => {
    const project = await connection.project(ref.source, ref.expectedUserKey)
    if (typeof query !== 'string' || query.trim().length > 100) throw new RequestError('invalid_input', '搜索成员名称过长。')
    await projection.read(project, ref.id, ref.typeKey)
    return { users: 'editor' in project.client ? await project.client.editor().searchUsers(query) : [] }
  })

  orca.panels.handle('meego.editWorkItem', (input, { signal }) => perform(input, signal, async ({ client, config, id, beforeWrite }) => {
    const editor = client.editor(beforeWrite, signal)
    let result: WorkItemEditResult
    switch (input.operation) {
      case 'priority': result = await editor.updatePriority(id, input.typeKey, input.value); break
      case 'status': result = await editor.transition(id, input.typeKey, input.transitionId); break
      case 'operators': result = await editor.updateCurrentOperators(id, input.typeKey, input.userKeys); break
      case 'roleMembers': result = await editor.updateRoleMembers(id, input.typeKey, input.roleKey, input.userKeys); break
      case 'name':
      case 'description':
        if (typeof input.value !== 'string' || input.value.length > (input.operation === 'name' ? 200 : 10_000)) throw new RequestError('invalid_input', '字段内容过长。')
        result = await editor.updateText(id, input.typeKey, { [input.operation]: input.value }); break
      default: throw new RequestError('invalid_input', '请选择要修改的字段。')
    }
    if (result.state === 'unverified') return result
    return { state: 'confirmed' as const, item: await describe(result.item, client, config) }
  }))

  orca.panels.handle('meego.workflowNodes', async (ref) => {
    const project = await connection.project(ref.source, ref.expectedUserKey)
    const item = await projection.read(project, ref.id, ref.typeKey)
    if (!('nodes' in project.client)) return { state: 'browserOnly' as const, reason: '当前企业连接的节点流程请在飞书项目中操作。', nodes: [] }
    return namedNodes(project.client, await project.client.nodes().list(ref.id, ref.typeKey), item)
  })

  orca.panels.handle('meego.inspectWorkflowNode', async ({ nodeKey, ...ref }) => {
    if (typeof nodeKey !== 'string' || !nodeKey || nodeKey.length > 256) throw new RequestError('invalid_input', '请选择流程节点。')
    const project = await connection.project(ref.source, ref.expectedUserKey)
    const item = await projection.read(project, ref.id, ref.typeKey)
    if (!('nodes' in project.client)) throw new RequestError('unsupported', '当前连接请在飞书项目中操作节点。')
    const node = await project.client.nodes().inspect(ref.id, ref.typeKey, nodeKey)
    const named = await namedNodes(project.client, { state: 'available', nodes: [node] }, item)
    return { node: named.nodes[0] }
  })

  orca.panels.handle('meego.editWorkflowNode', (input, { signal }) => perform(input, signal, async ({ client, config, id, beforeWrite }) => {
    if (typeof input.nodeKey !== 'string' || !input.nodeKey || input.nodeKey.length > 256 || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new RequestError('invalid_input', '请选择并刷新流程节点。')
    const nodes = client.nodes(beforeWrite, signal)
    const target = { nodeKey: input.nodeKey, expectedRevision: input.expectedRevision }
    const result = input.operation === 'owners'
      ? await nodes.updateOwners(id, input.typeKey, { ...target, userKeys: input.userKeys })
      : input.operation === 'confirm' || input.operation === 'rollback'
        ? await nodes.transition(id, input.typeKey, { ...target, action: input.operation, reason: input.reason })
        : (() => { throw new RequestError('invalid_input', '请选择节点操作。') })()
    if (result.state === 'unverified') return result
    const item = await describe(result.item, client, config)
    return { state: 'confirmed' as const, item, nodes: await namedNodes(client, result.nodes, item) }
  }))
}
