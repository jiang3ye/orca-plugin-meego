import type { OrcaWorkerApi } from 'orca/worker'
import type { MeegoStatus, WorkItemDetail, WorkItemId, WorkspaceContextInfo, WorkspaceLink } from './protocol'
import { MeegoConnection, RequestError, type ProjectClient } from './meego/connection'
import { buildWorkItemUrl, loadMeegoConfig, parseWorkItemLink, verifiedWorkItemUrl, type MeegoConfig } from './meego/config'
import { assertLinkRevision, clearWorkspaceLink, getWorkspaceLink, setWorkspaceLink } from './meego/links'
import { deliverToAgent, focusedWorkspace, requireWorkspace, requireWorkspaceTarget } from './meego/workspace'
import { parseWorkItemId, sameWorkItemId } from './meego/work-item-id'
import { activeWorkspaceInInventory, readWorkspaceInventory, requireListedWorkspace, workspaceFromInventory } from './meego/workspace-inventory'

interface WorkItemProjection {
  read(project: ProjectClient, id: WorkItemId, typeKey: string): Promise<WorkItemDetail>
  validate(id: WorkItemId, typeKey: string): WorkItemId
}

function linkSource(link: WorkspaceLink, status: MeegoStatus) {
  if (!status.userKey || parseWorkItemId(link.workItemId) === null) return null
  if (link.accountKey !== undefined) return link.accountKey === status.userKey && link.source?.baseUrl === status.baseUrl ? link.source : null
  if (!status.configured || status.connection !== undefined) return null
  const parsed = parseWorkItemLink(link.url, status.baseUrl)
  if (parsed?.canonical !== false || !sameWorkItemId(parsed.id, link.workItemId) || parsed.typeKey !== link.typeKey || parsed.space !== status.projectKey) return null
  return { baseUrl: status.baseUrl, projectKey: parsed.space }
}

async function linkedProject(connection: MeegoConnection, link: WorkspaceLink, expectedUserKey?: string): Promise<ProjectClient> {
  const status = await connection.status()
  const source = linkSource(link, status)
  if (source === null) throw new RequestError('source_unknown', '当前账号无法确认关联来源，请打开工作项后重新关联。')
  return connection.project(source, expectedUserKey ?? status.userKey)
}

function linkWithUrl(link: WorkspaceLink, config: MeegoConfig, detail: WorkItemDetail): WorkItemDetail {
  const url = verifiedWorkItemUrl(link.url, config, detail)
  return url === null ? detail : { ...detail, url }
}

export function registerWorkspaceActions(orca: OrcaWorkerApi, connection: MeegoConnection, projection: WorkItemProjection): void {
  orca.panels.handle('meego.agentChoices', async ({ workspaceId }) => {
    const workspace = await requireListedWorkspace(orca, workspaceId)
    const choices = await orca.host.call('agents.available', { workspaceId: workspace.id })
    await requireListedWorkspace(orca, workspaceId)
    return choices
  })

  orca.panels.handle('meego.openSettings', async () => orca.host.call('settings.open'))

  orca.panels.handle('meego.workspaceOptions', async (input) => {
    const inventory = await readWorkspaceInventory(orca)
    let activeWorkspaceId: string | null = null
    let message = inventory.truncated ? 'Orca 返回的列表不完整，请刷新后再关联工作区。'
      : inventory.omitted ? '已排除标识不唯一或不可用的工作区，请刷新 Orca 后重试。' : undefined
    try {
      activeWorkspaceId = activeWorkspaceInInventory(await orca.host.call('workspace.readContext'), inventory)
    } catch (error) {
      message = `无法读取当前工作区，仍可明确选择目标。${error instanceof Error ? error.message : String(error)}`
    }
    if (!input) return { workspaces: inventory.workspaces, truncated: inventory.truncated, activeWorkspaceId, ...(message ? { message } : {}) }
    const id = projection.validate(input.id, input.typeKey)
    const { config } = await connection.project(input.source, input.expectedUserKey)
    const status = await connection.status()
    const workspaces = await Promise.all(inventory.workspaces.map(async (row) => {
      const link = await getWorkspaceLink(orca, row.id)
      const source = link && linkSource(link, status)
      return { ...row, linkedToItem: Boolean(link && source && status.userKey === config.userKey &&
        source.baseUrl === config.baseUrl && source.projectKey === config.projectKey &&
        link.typeKey === input.typeKey && sameWorkItemId(link.workItemId, id)) }
    }))
    return { workspaces, truncated: inventory.truncated, activeWorkspaceId, ...(message ? { message } : {}) }
  })

  orca.panels.handle('meego.openWorkspace', async ({ workspaceId }) => {
    await requireListedWorkspace(orca, workspaceId)
    return orca.host.call('workspace.open', { workspaceId })
  })

  orca.panels.handle('meego.openAgentTerminal', async ({ workspaceId, terminalId }) => {
    await requireListedWorkspace(orca, workspaceId)
    const listing = await orca.host.call('terminal.list', { workspaceId })
    if (listing.truncated) throw new RequestError('unavailable', 'Orca 返回的终端列表不完整，请刷新后再打开 Agent。')
    if (listing.terminals.filter((terminal) => terminal.id === terminalId).length !== 1) {
      throw new RequestError('agent_unavailable', '所选 Agent 终端已不可用，请刷新后重试。')
    }
    await requireListedWorkspace(orca, workspaceId)
    return orca.host.call('terminal.focus', { terminalId })
  })

  orca.panels.handle('meego.workspaceContext', async (input): Promise<WorkspaceContextInfo> => {
    const inventory = await readWorkspaceInventory(orca)
    const selected = input ? workspaceFromInventory(inventory, input.workspaceId) : undefined
    let context: Awaited<ReturnType<typeof focusedWorkspace>> = null
    let unavailableReason: string | undefined
    try {
      const focused = await orca.host.call('workspace.readContext')
      if (focused) context = { ...focused, workspaceId: activeWorkspaceInInventory(focused, inventory), workspaceResolution: inventory.truncated ? 'truncated' : 'resolved' }
    } catch (error) {
      unavailableReason = `无法读取当前工作区。${error instanceof Error ? error.message : String(error)}`
    }
    const row = selected ?? inventory.workspaces.find((entry) => entry.id === context?.workspaceId)
    if (!row) return {
      workspaceId: null, displayName: context?.displayName ?? null, branch: context?.branch ?? null,
      workspaceResolution: inventory.truncated ? 'truncated' : 'unavailable', isActive: false,
      unavailableReason: unavailableReason ?? '尚未识别当前工作区，请从列表明确选择目标工作区。',
      link: null, branchChanged: false, agents: []
    }
    const workspaceId = row.id
    const displayName = row.name
    const branch = row.branch
    const isActive = context?.workspaceId === workspaceId
    let link = workspaceId === null ? null : await getWorkspaceLink(orca, workspaceId)
    if (link !== null) {
      const status = await connection.status().catch(() => null)
      const source = status === null ? null : linkSource(link, status)
      if (source === null) {
        link = null
      } else {
        const item = { id: link.workItemId, typeKey: link.typeKey }
        const url = verifiedWorkItemUrl(link.url, source, item)
        const fallback = url === null && status?.connection === undefined
          ? await loadMeegoConfig(orca).then((config) => buildWorkItemUrl(config, item)).catch(() => '') : ''
        link = { ...link, source, url: url ?? fallback }
      }
    }
    const { agents } = isActive ? await orca.host.call('agents.list') : { agents: [] }
    const visible = (isActive ? context?.terminals ?? [] : []).map((terminal) => terminal.id)
    return {
      workspaceId, displayName, branch, project: row.project, path: row.path, hostId: row.hostId,
      isActive, ...(unavailableReason ? { unavailableReason } : {}), link, workspaceResolution: 'resolved',
      branchChanged: link !== null && link.branch !== null && branch !== null && link.branch !== branch,
      agents: agents.filter((agent) => agent.terminalId !== null && visible.includes(agent.terminalId))
    }
  })

  orca.panels.handle('meego.linkWorkspace', async ({ workItemId, typeKey, name, status, source, url, workspaceId, expectedUserKey, expectedLinkedAt }) => {
    const { workspaceId: target } = await requireWorkspaceTarget(orca, workspaceId)
    const id = projection.validate(workItemId, typeKey)
    const project = await connection.project(source, expectedUserKey)
    const { config } = project
    const guard = connection.guardProject(project)
    const { branch } = await requireWorkspaceTarget(orca, target)
    await setWorkspaceLink(orca, target, {
      workItemId: id, typeKey, name, status: status ?? '', branch,
      linkedAt: Date.now(),
      url: verifiedWorkItemUrl(url, config, { id, typeKey }) ?? buildWorkItemUrl(config, { id, typeKey }),
      source: { baseUrl: config.baseUrl, projectKey: config.projectKey },
      ...(config.spaceName ? { spaceName: config.spaceName } : {}),
      accountKey: config.userKey
    }, expectedLinkedAt, false, guard)
    orca.panels.post('meego.linkChanged', { workspaceId: target })
    return { ok: true }
  })

  orca.panels.handle('meego.unlinkWorkspace', async (input) => {
    const { workspaceId } = await requireWorkspaceTarget(orca, input?.workspaceId)
    const link = await getWorkspaceLink(orca, workspaceId)
    if (link !== null) {
      const status = await connection.status()
      const source = linkSource(link, status)
      if (source === null) throw new RequestError('source_unknown', '当前账号无法解除这条关联。')
      const guard = connection.guardProject(await connection.project(source, status.userKey))
      await requireListedWorkspace(orca, workspaceId)
      const expected = input?.expectedLinkedAt
      await clearWorkspaceLink(orca, workspaceId, expected === undefined ? link.linkedAt : expected, guard)
    } else {
      assertLinkRevision(null, input?.expectedLinkedAt)
    }
    orca.panels.post('meego.linkChanged', { workspaceId })
    return { ok: true }
  })

  orca.panels.handle('meego.sendToAgent', async ({ id, typeKey, source, workspaceId, terminalId, agent, linked, expectedUserKey, expectedLinkedAt }, { signal }) => {
    const workspace = terminalId === null
      ? await requireWorkspaceTarget(orca, workspaceId)
      : await requireWorkspace(orca, workspaceId)
    const workItemId = projection.validate(id, typeKey)
    const link = linked ? await getWorkspaceLink(orca, workspace.workspaceId) : null
    if (linked && (link === null || !sameWorkItemId(link.workItemId, workItemId) || link.typeKey !== typeKey)) {
      throw new RequestError('link_changed', '当前工作区关联已变化，请重新选择。')
    }
    if (linked) assertLinkRevision(link, expectedLinkedAt)
    const project = link ? await linkedProject(connection, link, expectedUserKey) : await connection.project(source, expectedUserKey)
    const guard = connection.guardProject(project)
    const detail = await projection.read(project, workItemId, typeKey)
    if (agent !== undefined && terminalId !== null) throw new RequestError('invalid_input', '请选择新建会话后再指定 Agent。')
    let launchAgent = project.config.agentCommand
    if (terminalId === null) {
      if (typeof agent !== 'string' || !agent) throw new RequestError('agent_selection_required', '请选择此次启动的 Agent。')
      launchAgent = agent
    }
    return deliverToAgent(orca, workspace.workspaceId, link ? linkWithUrl(link, project.config, detail) : detail, launchAgent, {
      terminalId, linkedAt: link?.linkedAt, signal, guard
    })
  })

  orca.commands.register('meego.refresh', async () => {
    const workspace = await focusedWorkspace(orca)
    orca.panels.post('meego.linkChanged', { workspaceId: workspace?.workspaceId ?? null })
    return '已刷新 Meego 工作区关联'
  })

  orca.commands.register('meego.sendToAgent', async () => {
    const { workspaceId } = await requireWorkspace(orca)
    const link = await getWorkspaceLink(orca, workspaceId)
    if (link === null) throw new RequestError('no_link', '请在飞书项目面板关联当前工作区。')
    const origin = await linkedProject(connection, link)
    const guard = connection.guardProject(origin)
    const detail = await projection.read(origin, link.workItemId, link.typeKey)
    const result = await deliverToAgent(orca, workspaceId, linkWithUrl(link, origin.config, detail), origin.config.agentCommand, { linkedAt: link.linkedAt, guard })
    return result.detail
  })
}
