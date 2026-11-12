// Workspace (worktree) <-> work item links, kept in the plugin's own storage.
import type { OrcaWorkerApi } from 'orca/worker'
import type { WorkspaceLink } from '../protocol'
import { RequestError, type ProjectScopeGuard } from './connection'
import { storageJson } from './storage-json'

const LINKS_KEY = 'meego.workspaceLinks'

type LinkMap = Record<string, WorkspaceLink>
const pending = new WeakMap<OrcaWorkerApi, Promise<void>>()

async function readMap(orca: OrcaWorkerApi): Promise<LinkMap> {
  const value: unknown = await orca.storage.get(LINKS_KEY)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as LinkMap
}

export async function getWorkspaceLink(orca: OrcaWorkerApi, workspaceId: string): Promise<WorkspaceLink | null> {
  const map = await readMap(orca)
  return Object.hasOwn(map, workspaceId) ? map[workspaceId] : null
}

/** Orca storage updates are per key. Serialize read/modify/write for the shared link map. */
function updateLinks(
  orca: OrcaWorkerApi,
  update: (map: LinkMap) => LinkMap,
  guard?: ProjectScopeGuard
): Promise<void> {
  const next = (pending.get(orca) ?? Promise.resolve()).then(async () => {
    const previous = await readMap(orca)
    const map = update(previous)
    if (map !== previous) {
      const commit = () => orca.storage.set(LINKS_KEY, storageJson(map))
      if (guard) await guard.run(commit)
      else await commit()
    }
  })
  pending.set(orca, next.catch(() => {}))
  return next
}

export function setWorkspaceLink(
  orca: OrcaWorkerApi,
  workspaceId: string,
  link: WorkspaceLink,
  expectedLinkedAt?: number | null,
  strictEmpty = false,
  guard?: ProjectScopeGuard
): Promise<void> {
  return updateLinks(orca, (map) => {
    const previous = map[workspaceId]
    const hidden = !strictEmpty && expectedLinkedAt === null && previous !== undefined && (
      previous.accountKey !== link.accountKey || previous.source?.baseUrl !== link.source?.baseUrl
    )
    assertLinkRevision(hidden ? null : previous, expectedLinkedAt)
    return { ...map, [workspaceId]: { ...link, linkedAt: Math.max(link.linkedAt, (previous?.linkedAt ?? 0) + 1) } }
  }, guard)
}

export function clearWorkspaceLink(orca: OrcaWorkerApi, workspaceId: string, expectedLinkedAt?: number | null, guard?: ProjectScopeGuard): Promise<void> {
  return updateLinks(orca, (map) => {
    assertLinkRevision(map[workspaceId], expectedLinkedAt)
    if (!Object.hasOwn(map, workspaceId)) return map
    const next = { ...map }
    delete next[workspaceId]
    return next
  }, guard)
}

export function assertLinkRevision(link: WorkspaceLink | null | undefined, expectedLinkedAt?: number | null): void {
  if (expectedLinkedAt !== undefined && (link?.linkedAt ?? null) !== expectedLinkedAt) {
    throw new RequestError('link_changed', '当前工作区关联已变化，请刷新后重试。')
  }
}
