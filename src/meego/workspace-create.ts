import { createHash, randomUUID } from 'node:crypto'
import type { OrcaWorkerApi } from 'orca/worker'
import type {
  CreatedWorkspaceReceipt, WorkItemDetail, WorkItemReference, WorkItemSource,
  WorkspaceCreationOperation, WorkspaceCreationPlan, WorkspaceCreationSource
} from '../protocol'
import { RequestError } from './connection'
import { getWorkspaceLink, setWorkspaceLink } from './links'
import { storageJson } from './storage-json'

type Resolution = { item: WorkItemDetail; accountKey: string }
type Journal = {
  version: 1
  scope: string
  ref: WorkItemReference
  accountKey: string
  planId: string
  requestId: string
  state: 'ready' | 'creating' | 'uncertain' | 'created' | 'linked'
  name: string
  sources: WorkspaceCreationSource[]
  source?: WorkspaceCreationSource
  receipt?: CreatedWorkspaceReceipt
  message?: string
}

const PREFIX = 'meego.workspaceCreation.v1.'
const UNCERTAIN = '无法确认创建结果。请先在 Orca 工作区列表核对，选择已创建的工作区恢复关联，或明确确认未创建后重新计划。'
const CREATION_TIMEOUT_MS = 75_000

function scopeOf({ item, accountKey }: Resolution): string {
  if (!item.source?.baseUrl || !item.source.projectKey || !accountKey) {
    throw new RequestError('source_unknown', '无法确认工作项的账号和空间，请重新打开工作项。')
  }
  return JSON.stringify([item.source.baseUrl, item.source.projectKey, accountKey, item.typeKey, String(item.id)])
}

function sourceEqual(a: WorkItemSource | undefined, b: WorkItemSource | undefined): boolean {
  return a?.baseUrl === b?.baseUrl && a?.projectKey === b?.projectKey
}

function receiptOf(value: unknown): CreatedWorkspaceReceipt | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.workspaceId !== 'string' || !row.workspaceId || typeof row.name !== 'string' || !row.name ||
    typeof row.path !== 'string' || !row.path || !(row.branch === null || typeof row.branch === 'string')) return null
  return { workspaceId: row.workspaceId, name: row.name, path: row.path, branch: row.branch }
}

function sourceOf(value: unknown): value is WorkspaceCreationSource {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return typeof row.id === 'string' && row.id !== '' && typeof row.name === 'string' &&
    typeof row.path === 'string' && typeof row.branch === 'string' && row.branch !== '' &&
    (row.hostId === null || typeof row.hostId === 'string') &&
    (row.project === undefined || row.project === null || typeof row.project === 'string')
}

function sameCreationSource(a: WorkspaceCreationSource, b: WorkspaceCreationSource): boolean {
  return a.id === b.id && a.path === b.path && a.branch === b.branch && a.hostId === b.hostId
}

function parseJournal(value: unknown, scope: string): Journal | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new RequestError('creation_journal', '工作区创建记录无法读取，请先核对 Orca 工作区。')
  const journal = value as Journal
  if (journal.version !== 1 || journal.scope !== scope || typeof journal.accountKey !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(journal.planId) || !/^[A-Za-z0-9_-]{1,128}$/.test(journal.requestId) ||
    !['ready', 'creating', 'uncertain', 'created', 'linked'].includes(journal.state) ||
    typeof journal.name !== 'string' || !Array.isArray(journal.sources) || !journal.sources.every(sourceOf) ||
    ((journal.state === 'created' || journal.state === 'linked') && !receiptOf(journal.receipt))) {
    throw new RequestError('creation_journal', '工作区创建记录不完整，请先核对 Orca 工作区。')
  }
  return journal
}

/** Registers worker-only operations; the resolver owns authentication and scope checks. */
export function registerWorkspaceCreation(orca: OrcaWorkerApi, options: {
  resolve(ref: WorkItemReference): Promise<Resolution>
}): void {
  const locks = new Map<string, Promise<unknown>>()
  const pendingCreates = new Map<string, Promise<unknown>>()
  // Keep an already-received receipt even if persisting it fails in this process.
  const memory = new Map<string, Journal>()

  async function resolve(ref: WorkItemReference): Promise<Resolution> {
    const resolved = await options.resolve(ref)
    if (String(resolved.item.id) !== String(ref.id) || resolved.item.typeKey !== ref.typeKey ||
      (ref.source && !sourceEqual(ref.source, resolved.item.source)) ||
      (ref.expectedUserKey && resolved.accountKey !== ref.expectedUserKey)) {
      throw new RequestError('source_changed', '工作项账号或空间已变化，请重新打开工作项。')
    }
    scopeOf(resolved)
    return resolved
  }

  function keyFor(scope: string): string {
    return PREFIX + createHash('sha256').update(scope).digest('hex')
  }

  async function persist(key: string, journal: Journal): Promise<void> {
    memory.set(key, journal)
    await orca.storage.set(key, storageJson(journal))
  }

  async function read(key: string, scope: string): Promise<Journal | null> {
    return memory.get(key) ?? parseJournal(await orca.storage.get(key), scope)
  }

  function serial<T>(scope: string, operation: (key: string) => Promise<T>): Promise<T> {
    const key = keyFor(scope)
    const next = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(() => operation(key))
    locks.set(key, next)
    void next.finally(() => { if (locks.get(key) === next) locks.delete(key) }).catch(() => {})
    return next
  }

  async function listing() {
    const result = await orca.host.call('workspace.list')
    const worktrees = result.workspaces.filter((row) => row.kind === 'worktree' && row.branch && row.id && row.path)
    const recoveryWorkspaces: WorkspaceCreationSource[] = worktrees.map((row) => ({
      id: row.id, name: row.name, path: row.path, branch: row.branch!, hostId: row.hostId,
      ...(row.project === undefined ? {} : { project: row.project })
    }))
    const sources = result.truncated || result.canCreateWorktree !== true ? [] : recoveryWorkspaces
    const message = result.truncated ? 'Orca 工作区列表不完整，请减少工作区或更新宿主后重试。'
      : result.canCreateWorktree !== true ? '当前宿主不支持创建 Git 工作区，请更新 Orca 后重试。'
        : sources.length === 0 ? '请先在 Orca 中打开有分支的 Git 工作区，再刷新创建计划。' : undefined
    return { sources, recoveryWorkspaces, message }
  }

  async function present(journal: Journal): Promise<WorkspaceCreationPlan> {
    let recoveryWorkspaces: WorkspaceCreationSource[] = []
    // A failed read must not erase an already-known creation result.
    if (journal.state === 'creating' || journal.state === 'uncertain') {
      try {
        recoveryWorkspaces = (await listing()).recoveryWorkspaces.filter((row) =>
          row.id !== journal.source?.id && (!journal.source || row.hostId === journal.source.hostId))
      } catch { /* The user can refresh later. */ }
    }
    return {
      planId: journal.planId, state: journal.state === 'creating' ? 'uncertain' : journal.state,
      name: journal.name, sources: journal.state === 'ready' ? journal.sources : [], recoveryWorkspaces,
      ...(journal.receipt ? { receipt: journal.receipt } : {}),
      ...(journal.state === 'creating' ? { message: UNCERTAIN } : journal.message ? { message: journal.message } : {})
    }
  }

  async function fresh(resolved: Resolution, key: string): Promise<Journal> {
    const { sources, message } = await listing()
    const ref: WorkItemReference = {
      id: resolved.item.id, typeKey: resolved.item.typeKey,
      source: { ...resolved.item.source! }, expectedUserKey: resolved.accountKey
    }
    const journal: Journal = {
      version: 1, scope: scopeOf(resolved), ref, accountKey: resolved.accountKey,
      planId: randomUUID(), requestId: randomUUID(), state: 'ready',
      name: `meego-${resolved.item.id}`, sources, ...(message ? { message } : {})
    }
    await persist(key, journal)
    return journal
  }

  async function requirePlan(input: WorkspaceCreationOperation, key: string, scope: string): Promise<Journal> {
    const journal = await read(key, scope)
    if (!journal || input.planId !== journal.planId) {
      throw new RequestError('plan_changed', '创建计划已变化，请重新打开创建面板。')
    }
    return journal
  }

  async function revalidate(journal: Journal): Promise<Resolution> {
    const result = await resolve(journal.ref)
    if (scopeOf(result) !== journal.scope) throw new RequestError('source_changed', '工作项账号或空间已变化，请重新打开工作项。')
    return result
  }

  function requireSettledCreation(key: string): void {
    if (pendingCreates.has(key)) throw new RequestError('busy', '原工作区创建请求仍在进行，请等待结束后再核对结果。')
  }

  async function link(key: string, journal: Journal): Promise<WorkspaceCreationPlan> {
    const receipt = journal.receipt!
    try {
      // Save the receipt before any attempt to associate it, including retry/recovery.
      await persist(key, { ...journal, state: 'created' })
      const current = (await orca.host.call('workspace.list')).workspaces.find((row) => row.id === receipt.workspaceId)
      if (!current || current.kind !== 'worktree' || current.path !== receipt.path ||
        (journal.source && current.hostId !== journal.source.hostId)) {
        throw new RequestError('workspace_changed', '已创建的工作区已移除或路径变化，请在 Orca 中核对。')
      }
      const existing = await getWorkspaceLink(orca, receipt.workspaceId)
      const { item, accountKey } = await revalidate(journal)
      const same = existing && String(existing.workItemId) === String(item.id) && existing.typeKey === item.typeKey &&
        existing.accountKey === accountKey && sourceEqual(existing.source, item.source)
      if (!same) {
        // A recovered workspace must never overwrite a different work-item association.
        if (existing) throw new RequestError('link_changed', '所选工作区已关联其他工作项，请在 Orca 中核对。')
        await setWorkspaceLink(orca, receipt.workspaceId, {
          workItemId: item.id, typeKey: item.typeKey, name: item.name, status: item.status,
          url: item.url, source: item.source, accountKey, ...(item.spaceName ? { spaceName: item.spaceName } : {}),
          branch: current.branch, linkedAt: Date.now()
        }, null, true)
      }
      const { message: _message, ...saved } = journal
      const linked: Journal = { ...saved, state: 'linked' }
      await persist(key, linked)
      orca.panels.post('meego.linkChanged', { workspaceId: receipt.workspaceId })
      return present(linked)
    } catch (error) {
      const created: Journal = { ...journal, state: 'created', message: `工作区已创建，关联尚未完成。${error instanceof Error ? error.message : '请重试关联。'}` }
      memory.set(key, created)
      try { await persist(key, created) } catch { /* The previous creating record still blocks duplicate creation. */ }
      return present(created)
    }
  }

  orca.panels.handle('meego.workspaceCreationPlan', async (ref) => {
    const resolved = await resolve(ref)
    const scope = scopeOf(resolved)
    return serial(scope, async (key) => {
      const journal = await read(key, scope)
      if (!journal) return present(await fresh(resolved, key))
      if (journal.state !== 'ready') return present(journal)
      // Refreshing an unsubmitted plan invalidates stale selectors from another panel.
      return present(await fresh(resolved, key))
    })
  })

  orca.panels.handle('meego.createWorkspace', async (input, { signal }) => {
    signal.throwIfAborted()
    const resolved = await resolve(input.ref)
    const scope = scopeOf(resolved)
    return serial(scope, async (key) => {
      signal.throwIfAborted()
      requireSettledCreation(key)
      const journal = await requirePlan(input, key, scope)
      if (journal.state !== 'ready') return present(journal)
      const name = typeof input.name === 'string' ? input.name.trim() : ''
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) {
        throw new RequestError('invalid_input', '名称需为 1–80 位字母、数字、短横线或下划线，并以字母或数字开头。')
      }
      const source = journal.sources.find((row) => row.id === input.sourceWorkspaceId)
      const live = (await listing()).sources.find((row) => row.id === input.sourceWorkspaceId)
      if (!source || !live || !sameCreationSource(source, live)) {
        throw new RequestError('workspace_changed', '来源工作区的仓库、主机或分支已变化，请刷新创建计划。')
      }
      await revalidate(journal)
      signal.throwIfAborted()
      const creating: Journal = { ...journal, name, source, state: 'creating', message: UNCERTAIN }
      // No host write is dispatched unless this durable barrier succeeds.
      await persist(key, creating)
      let timer: ReturnType<typeof setTimeout> | undefined
      let receipt: CreatedWorkspaceReceipt | null
      try {
        signal.throwIfAborted()
        const creation = orca.host.call('workspace.create', { sourceWorkspaceId: source.id, name, requestId: journal.requestId }, { signal })
        pendingCreates.set(key, creation)
        // Timing out stops this panel's wait, not the host effect. Keep its scope
        // blocked until the original call settles, without replaying late results.
        void creation.finally(() => {
          if (pendingCreates.get(key) === creation) pendingCreates.delete(key)
        }).catch(() => {})
        const raw = await Promise.race([
          creation,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(UNCERTAIN)), CREATION_TIMEOUT_MS) })
        ])
        signal.throwIfAborted()
        receipt = receiptOf(raw)
        if (!receipt || receipt.workspaceId === source.id || receipt.path === source.path) throw new Error(UNCERTAIN)
      } catch {
        const uncertain: Journal = { ...creating, state: 'uncertain' }
        memory.set(key, uncertain)
        try { await persist(key, uncertain) } catch { /* The creating barrier is already durable. */ }
        return present(uncertain)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      return link(key, { ...creating, state: 'created', receipt })
    })
  })

  orca.panels.handle('meego.retryCreatedWorkspaceLink', async (input) => {
    const resolved = await resolve(input.ref)
    const scope = scopeOf(resolved)
    return serial(scope, async (key) => {
      const journal = await requirePlan(input, key, scope)
      if (journal.state === 'linked') return present(journal)
      if (journal.state !== 'created' || !journal.receipt) throw new RequestError('creation_uncertain', UNCERTAIN)
      return link(key, journal)
    })
  })

  orca.panels.handle('meego.recoverCreatedWorkspace', async (input) => {
    const resolved = await resolve(input.ref)
    const scope = scopeOf(resolved)
    return serial(scope, async (key) => {
      const journal = await requirePlan(input, key, scope)
      if (journal.state !== 'uncertain' && journal.state !== 'creating') return present(journal)
      const candidate = (await listing()).recoveryWorkspaces.find((row) => row.id === input.workspaceId)
      if (!candidate || candidate.id === journal.source?.id) {
        throw new RequestError('invalid_input', '请选择已创建的 Git 工作区，不能选择来源工作区。')
      }
      if (journal.source && candidate.hostId !== journal.source.hostId) {
        throw new RequestError('workspace_changed', '恢复目标与创建时的主机不同，请重新核对。')
      }
      const existing = await getWorkspaceLink(orca, candidate.id)
      if (existing && !(String(existing.workItemId) === String(resolved.item.id) && existing.typeKey === resolved.item.typeKey &&
        existing.accountKey === resolved.accountKey && sourceEqual(existing.source, resolved.item.source))) {
        throw new RequestError('link_changed', '所选工作区已关联其他工作项，请选择正确的工作区。')
      }
      return link(key, { ...journal, state: 'created', receipt: {
        workspaceId: candidate.id, name: candidate.name, path: candidate.path, branch: candidate.branch
      } })
    })
  })

  orca.panels.handle('meego.confirmWorkspaceNotCreated', async (input) => {
    const resolved = await resolve(input.ref)
    const scope = scopeOf(resolved)
    return serial(scope, async (key) => {
      requireSettledCreation(key)
      const journal = await requirePlan(input, key, scope)
      if (journal.state !== 'uncertain' && journal.state !== 'creating') return present(journal)
      // Only this explicit user action issues a new request ID after an uncertain create.
      return present(await fresh(resolved, key))
    })
  })

  orca.panels.handle('meego.openCreatedWorkspace', async (input) => {
    const resolved = await resolve(input.ref)
    const scope = scopeOf(resolved)
    return serial(scope, async (key) => {
      const journal = await requirePlan(input, key, scope)
      if (journal.state !== 'linked' || !journal.receipt) throw new RequestError('not_linked', '请先完成工作区关联。')
      const current = (await orca.host.call('workspace.list')).workspaces.find((row) => row.id === journal.receipt!.workspaceId)
      if (!current || current.path !== journal.receipt.path) throw new RequestError('workspace_changed', '工作区已移除或路径变化，请在 Orca 中核对。')
      await revalidate(journal)
      return orca.host.call('workspace.open', { workspaceId: journal.receipt.workspaceId })
    })
  })
}
