import type { HostResult } from 'orca/host'
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceOption } from '../protocol'
import { RequestError } from './connection'

type WorkspaceRow = HostResult<'workspace.list'>['workspaces'][number]
export type WorkspaceInventory = Awaited<ReturnType<typeof readWorkspaceInventory>>

function validWorkspace(row: WorkspaceRow): boolean {
  return typeof row.id === 'string' && row.id.length > 0 &&
    (row.kind === 'worktree' || row.kind === 'folder') &&
    (!row.id.startsWith('folder:') || row.kind === 'folder') &&
    typeof row.name === 'string' && typeof row.path === 'string' && row.path.length > 0
}

export async function readWorkspaceInventory(orca: OrcaWorkerApi) {
  const listing = await orca.host.call('workspace.list')
  const counts = new Map<string, number>()
  for (const row of listing.workspaces) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const workspaces: WorkspaceOption[] = listing.workspaces
    .filter((row) => validWorkspace(row) && counts.get(row.id) === 1)
    .map(({ id, kind, name, project, path, branch, hostId }) => ({
      id, kind, name, project: project ?? null, path, branch, hostId
    }))
  return { workspaces, truncated: listing.truncated, omitted: workspaces.length !== listing.workspaces.length }
}

export function workspaceFromInventory(inventory: WorkspaceInventory, workspaceId: string): WorkspaceOption {
  if (inventory.truncated) throw new RequestError('unavailable', 'Orca 返回的工作区列表不完整，请刷新后再选择目标。')
  const row = inventory.workspaces.find((entry) => entry.id === workspaceId)
  if (!row) throw new RequestError('workspace_unavailable', '所选工作区已不可用或标识不唯一，请刷新工作区列表后重新选择。')
  return row
}

export async function requireListedWorkspace(orca: OrcaWorkerApi, workspaceId: string): Promise<WorkspaceOption> {
  return workspaceFromInventory(await readWorkspaceInventory(orca), workspaceId)
}

export function activeWorkspaceInInventory(
  context: HostResult<'workspace.readContext'>,
  inventory: WorkspaceInventory
): string | null {
  if (!context || inventory.truncated) return null
  const matches = inventory.workspaces.filter((row) => context.workspaceId !== undefined
    ? row.id === context.workspaceId
    : row.name === context.displayName && (row.branch ?? '') === context.branch)
  const row = matches.length === 1 ? matches[0] : undefined
  return row?.name === context.displayName && (row.branch ?? '') === context.branch ? row.id : null
}
