import type { OrcaWorkerApi } from 'orca/worker'
import type { SendToAgentOutput, WorkItemDetail } from '../protocol'
import { RequestError } from './connection'
import { assertLinkRevision, getWorkspaceLink } from './links'
import { buildWorkItemPrompt, limitAgentHandoffText } from './prompt'

/** Verify the focused identity against the complete, cross-host workspace inventory. */
export async function focusedWorkspace(orca: OrcaWorkerApi) {
  const context = await orca.host.call('workspace.readContext')
  if (context === null) return null
  const listing = await orca.host.call('workspace.list')
  const hasIdentity = context.workspaceId !== undefined
  const matches = listing.workspaces.filter((entry) => hasIdentity
    ? entry.id === context.workspaceId
    : entry.name === context.displayName && (entry.branch ?? '') === context.branch)
  const candidate = matches.length === 1 ? matches[0] : undefined
  const valid = candidate !== undefined && typeof candidate.id === 'string' && candidate.id.length > 0 &&
    (candidate.kind === 'worktree' || candidate.kind === 'folder') &&
    (!candidate.id.startsWith('folder:') || candidate.kind === 'folder') &&
    candidate.name === context.displayName && (candidate.branch ?? '') === context.branch &&
    listing.workspaces.filter((entry) => entry.id === candidate.id).length === 1
  const workspaceResolution = listing.truncated ? 'truncated' as const
    : matches.length > 1 ? 'ambiguous' as const
      : valid ? 'resolved' as const : 'unavailable' as const
  return { ...context, workspaceId: workspaceResolution === 'resolved' ? candidate?.id ?? null : null, workspaceResolution }
}

export async function requireWorkspace(orca: OrcaWorkerApi, expected?: string) {
  const context = await focusedWorkspace(orca)
  if (context?.workspaceResolution === 'ambiguous') {
    throw new RequestError('conflict', '当前宿主无法区分同名同分支工作区，请更新 Orca 后重新识别工作区。')
  }
  if (context?.workspaceResolution === 'truncated') {
    throw new RequestError('unavailable', 'Orca 返回的工作区列表不完整，暂时无法确认当前工作区。')
  }
  if (context?.workspaceId == null) throw new RequestError('no_workspace', '无法核对当前工作区标识。请在 Orca 中重新选择工作区；旧版宿主请更新后重新识别。')
  if (expected !== undefined && context.workspaceId !== expected) {
    throw new RequestError('workspace_changed', '当前工作区已切换，请确认目标后重试。')
  }
  return { ...context, workspaceId: context.workspaceId }
}

export async function deliverToAgent(
  orca: OrcaWorkerApi,
  workspaceId: string,
  detail: WorkItemDetail,
  launchAgent: string,
  target: { terminalId?: string | null; linkedAt?: number; signal?: AbortSignal } = {}
): Promise<SendToAgentOutput> {
  const { terminalId: requestedTerminal, linkedAt, signal } = target
  const agents = requestedTerminal === null ? [] : (await orca.host.call('agents.list')).agents
  const workspace = await requireWorkspace(orca, workspaceId)
  const terminalIds = new Set(workspace.terminals.map(({ id }) => id))
  // Orca reports an idle CLI's completed turn as done. These terminals receive drafts.
  const terminalAgents = agents.filter((agent) => agent.terminalId !== null && terminalIds.has(agent.terminalId))
  const agent = requestedTerminal == null ? terminalAgents[0] : terminalAgents.find((entry) => entry.terminalId === requestedTerminal)
  const prompt = buildWorkItemPrompt(detail).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  if (typeof requestedTerminal === 'string' && !agent) {
    throw new RequestError('agent_unavailable', '所选 Agent 已离开当前工作区，请重新选择。')
  }
  if (requestedTerminal === undefined && terminalAgents.length !== 1) {
    throw new RequestError('agent_selection_required', terminalAgents.length > 1
      ? '当前工作区有多个 Agent，请在 Meego 面板选择目标。'
      : '当前工作区没有可用的 Agent，请在 Meego 面板选择本次启动的 Agent。')
  }
  if (linkedAt !== undefined) assertLinkRevision(await getWorkspaceLink(orca, workspaceId), linkedAt)
  if (signal?.aborted) throw new RequestError('cancelled', '交接请求已取消。')
  const options = signal ? { signal } : undefined
  if (agent?.terminalId) {
    // A running Agent can exit to its shell after the host snapshot. Keep this draft
    // on one terminal line so embedded line breaks cannot submit commands.
    const draft = limitAgentHandoffText(prompt.replace(/\t/g, ' ').split(/[\n\u2028\u2029]+/).filter(Boolean).join(' · '))
    const result = await orca.host.call('terminal.sendText', { terminalId: agent.terminalId, text: draft, enter: false }, options)
    if (!result.accepted) throw new RequestError('agent_unavailable', '无法确认草稿是否写入，请先检查目标终端再重试。')
    return { sent: true, detail: `Orca 已接收写入 ${agent.title ?? agent.agent ?? 'Agent'} 终端的请求。请在终端核对后提交。` }
  }
  await orca.host.call('agent.launch', { workspaceId, agent: launchAgent, prompt: limitAgentHandoffText(prompt) }, options)
  return { sent: true, detail: `Orca 已打开 ${launchAgent} 终端并接收投递请求。请在终端确认 Agent 启动和工作项送达。` }
}
