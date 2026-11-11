import type { OrcaWorkerApi } from 'orca/worker'
import type { MeegoStatus, WorkItemDetail, WorkItemId, WorkspaceLink } from './protocol'
import { MeegoConnection, RequestError, type ProjectClient } from './meego/connection'
import { buildWorkItemUrl, loadMeegoConfig, parseWorkItemLink, verifiedWorkItemUrl, type MeegoConfig } from './meego/config'
import { assertLinkRevision, clearWorkspaceLink, getWorkspaceLink, setWorkspaceLink } from './meego/links'
import { deliverToAgent, focusedWorkspace, requireWorkspace } from './meego/workspace'
import { parseWorkItemId, sameWorkItemId } from './meego/work-item-id'

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
    const workspace = await requireWorkspace(orca, workspaceId)
    return orca.host.call('agents.available', { workspaceId: workspace.workspaceId })
  })

  orca.panels.handle('meego.openSettings', async () => orca.host.call('settings.open'))

  orca.panels.handle('meego.workspaceContext', async () => {
    const context = await focusedWorkspace(orca).catch(() => null)
    if (context === null) return { workspaceId: null, displayName: null, branch: null, link: null, branchChanged: false, agents: [] }
    const { workspaceId, displayName, branch, terminals } = context
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
    const { agents } = await orca.host.call('agents.list').catch(() => ({ agents: [] }))
    const visible = terminals.map((terminal) => terminal.id)
    return {
      workspaceId, displayName, branch, link, workspaceResolution: context.workspaceResolution,
      branchChanged: link !== null && link.branch !== null && branch !== null && link.branch !== branch,
      agents: agents.filter((agent) => agent.terminalId !== null && visible.includes(agent.terminalId))
    }
  })

  orca.panels.handle('meego.linkWorkspace', async ({ workItemId, typeKey, name, status, source, url, workspaceId, expectedUserKey, expectedLinkedAt }) => {
    const { workspaceId: target } = await requireWorkspace(orca, workspaceId)
    const id = projection.validate(workItemId, typeKey)
    const { config } = await connection.project(source, expectedUserKey)
    const { branch } = await requireWorkspace(orca, target)
    await setWorkspaceLink(orca, target, {
      workItemId: id, typeKey, name, status: status ?? '', branch,
      linkedAt: Date.now(),
      url: verifiedWorkItemUrl(url, config, { id, typeKey }) ?? buildWorkItemUrl(config, { id, typeKey }),
      source: { baseUrl: config.baseUrl, projectKey: config.projectKey },
      ...(config.spaceName ? { spaceName: config.spaceName } : {}),
      accountKey: config.userKey
    }, expectedLinkedAt)
    orca.panels.post('meego.linkChanged', { workspaceId: target })
    return { ok: true }
  })

  orca.panels.handle('meego.unlinkWorkspace', async (input) => {
    const { workspaceId } = await requireWorkspace(orca, input?.workspaceId)
    const link = await getWorkspaceLink(orca, workspaceId)
    if (link !== null) {
      const status = await connection.status()
      if (linkSource(link, status) === null) throw new RequestError('source_unknown', '当前账号无法解除这条关联。')
      const expected = input?.expectedLinkedAt
      await clearWorkspaceLink(orca, workspaceId, expected === undefined ? link.linkedAt : expected)
    } else {
      assertLinkRevision(null, input?.expectedLinkedAt)
    }
    orca.panels.post('meego.linkChanged', { workspaceId })
    return { ok: true }
  })

  orca.panels.handle('meego.sendToAgent', async ({ id, typeKey, source, workspaceId, terminalId, agent, linked, expectedUserKey, expectedLinkedAt }, { signal }) => {
    const workspace = await requireWorkspace(orca, workspaceId)
    const workItemId = projection.validate(id, typeKey)
    const link = linked ? await getWorkspaceLink(orca, workspace.workspaceId) : null
    if (linked && (link === null || !sameWorkItemId(link.workItemId, workItemId) || link.typeKey !== typeKey)) {
      throw new RequestError('link_changed', '当前工作区关联已变化，请重新选择。')
    }
    if (linked) assertLinkRevision(link, expectedLinkedAt)
    const project = link ? await linkedProject(connection, link, expectedUserKey) : await connection.project(source, expectedUserKey)
    const detail = await projection.read(project, workItemId, typeKey)
    if (agent !== undefined && terminalId !== null) throw new RequestError('invalid_input', '请选择新建会话后再指定 Agent。')
    let launchAgent = project.config.agentCommand
    if (terminalId === null) {
      if (typeof agent !== 'string' || !agent) throw new RequestError('agent_selection_required', '请选择此次启动的 Agent。')
      const { agents } = await orca.host.call('agents.available', { workspaceId: workspace.workspaceId })
      if (!agents.some((entry) => entry.id === agent)) throw new RequestError('agent_unavailable', '所选 Agent 已不可用，请刷新选项后重新选择。')
      launchAgent = agent
    }
    return deliverToAgent(orca, workspace.workspaceId, link ? linkWithUrl(link, project.config, detail) : detail, launchAgent, {
      terminalId, linkedAt: link?.linkedAt, signal
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
    const detail = await projection.read(origin, link.workItemId, link.typeKey)
    const result = await deliverToAgent(orca, workspaceId, linkWithUrl(link, origin.config, detail), origin.config.agentCommand, { linkedAt: link.linkedAt })
    return result.detail
  })
}
