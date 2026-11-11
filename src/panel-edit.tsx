import { atom, Button, Callout, Heading, Row, Separator, Spinner, Stack, Text, plugin, read, set, shell } from 'orca'
import type { EditWorkItemInput, WorkItemDetail, WorkItemEditOptions, WorkItemReference } from './protocol'
import { connectionChanging } from './panel-connection'
import { WRITE_REQUEST_OPTIONS, writeResponseLost } from './panel-write'
import {
  EditFields, EditRecovery, editCapability, editOperations, selectedRole,
  type EditDraft as Draft, type EditMember as User, type EditOperation as Operation, type EditReadback as Readback
} from './panel-edit-fields'

type ErrorHandler = (error: unknown) => Promise<void>
type SaveHandler = (item: WorkItemDetail, outcome?: 'confirmed' | 'adopted') => Promise<void>
type EditTarget = { key: string; ref: WorkItemReference; detail: WorkItemDetail }
type UnverifiedEdit = { operation: Operation; draft: Draft; members: User[]; roleLabel?: string }

const targetAtom = atom<EditTarget | null>(null)
const openAtom = atom(false)
const optionsAtom = atom<WorkItemEditOptions | null>(null)
const operationAtom = atom<Operation>('name')
const draftAtom = atom<Draft>({ name: '', description: '', priorityKey: null, transitionId: '', roleKey: '', roleUserKeys: null, roleBaseUserKeys: null })
const loadingAtom = atom(false)
const errorAtom = atom<string | null>(null)
const messageAtom = atom<string | null>(null)
const pendingWritesAtom = atom(0)
const unverifiedAtom = atom<ReadonlyMap<string, UnverifiedEdit>>(new Map())
const readbackAtom = atom<Readback | null>(null)
const readingBackAtom = atom(false)
const memberQueryAtom = atom('')
const memberResultsAtom = atom<User[]>([])
const memberMatchKeysAtom = atom<string[] | null>(null)
const memberLoadingAtom = atom(false)
const memberErrorAtom = atom<string | null>(null)
let optionsRequest = 0
let memberRequest = 0

export function editBusy(): boolean {
  return read(pendingWritesAtom) > 0
}

function copyDraft(draft: Draft): Draft {
  return {
    ...draft,
    roleUserKeys: draft.roleUserKeys === null ? null : [...draft.roleUserKeys],
    roleBaseUserKeys: draft.roleBaseUserKeys === null ? null : [...draft.roleBaseUserKeys]
  }
}

export function resetEdit(detail?: WorkItemDetail, expectedUserKey?: string): void {
  optionsRequest += 1
  let target: EditTarget | null = null
  if (detail) {
    const ref: WorkItemReference = {
      id: detail.id,
      typeKey: detail.typeKey,
      ...(detail.source ? { source: { ...detail.source } } : {}),
      ...(expectedUserKey ? { expectedUserKey } : {})
    }
    const key = JSON.stringify([ref.source?.baseUrl, ref.source?.projectKey, expectedUserKey, ref.typeKey, String(ref.id)])
    target = { key, ref, detail: { ...detail, ...(detail.source ? { source: { ...detail.source } } : {}) } }
  }
  const unresolved = target ? read(unverifiedAtom).get(target.key) : undefined
  set(targetAtom, target)
  set(openAtom, false)
  set(optionsAtom, null)
  set(operationAtom, unresolved?.operation ?? 'name')
  set(draftAtom, unresolved ? copyDraft(unresolved.draft) : {
    name: detail?.name ?? '', description: detail?.description ?? '', priorityKey: null, transitionId: '', roleKey: '', roleUserKeys: null, roleBaseUserKeys: null
  })
  set(loadingAtom, false)
  set(errorAtom, null)
  set(messageAtom, null)
  set(readbackAtom, null)
  set(readingBackAtom, false)
  resetMemberSearch()
  set(memberResultsAtom, unresolved?.members ?? [])
}

function resetMemberSearch(preserveMembers = false): void {
  memberRequest += 1
  set(memberQueryAtom, '')
  set(memberMatchKeysAtom, null)
  if (!preserveMembers) set(memberResultsAtom, [])
  set(memberLoadingAtom, false)
  set(memberErrorAtom, null)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function changeDraft(target: EditTarget, change: Partial<Draft>): void {
  if (target !== read(targetAtom)) return
  set(draftAtom, { ...read(draftAtom), ...change })
  set(errorAtom, null)
  set(messageAtom, null)
}

async function loadOptions(target: EditTarget, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom)) return
  const request = ++optionsRequest
  set(loadingAtom, true)
  set(errorAtom, null)
  try {
    const { options } = await plugin.request('meego.editOptions', target.ref)
    if (target !== read(targetAtom) || request !== optionsRequest) return
    const draft = read(draftAtom)
    const role = selectedRole(options, draft)
    let next = { ...draft, priorityKey: draft.priorityKey ?? options.priority.currentKey ?? '' }
    if (role && draft.roleBaseUserKeys !== null && !read(unverifiedAtom).has(target.key)) {
      const baseline = draft.roleBaseUserKeys
      const selected = new Set(draft.roleUserKeys ?? baseline)
      const removed = new Set(baseline.filter((key) => !selected.has(key)))
      const added = [...selected].filter((key) => !baseline.includes(key))
      next = { ...next, roleBaseUserKeys: [...role.userKeys], roleUserKeys: [...new Set([...role.userKeys.filter((key) => !removed.has(key)), ...added])] }
    }
    set(draftAtom, next)
    set(optionsAtom, options)
  } catch (error) {
    if (target !== read(targetAtom) || request !== optionsRequest) return
    set(errorAtom, messageOf(error))
    await onError(error)
  } finally {
    if (target === read(targetAtom) && request === optionsRequest) set(loadingAtom, false)
  }
}

function toggleEdit(target: EditTarget, onError: ErrorHandler): Promise<void> | undefined {
  if (target !== read(targetAtom)) return
  const open = !read(openAtom)
  set(openAtom, open)
  if (open && read(optionsAtom) === null && !read(loadingAtom)) return loadOptions(target, onError)
}

function changeOperation(target: EditTarget, value: string): void {
  if (target !== read(targetAtom)) return
  const operation = editOperations.find((entry) => entry.value === value)
  if (!operation) return
  if (read(operationAtom) !== operation.value) resetMemberSearch(true)
  set(operationAtom, operation.value)
  set(errorAtom, null)
  set(messageAtom, null)
}

function changeRole(target: EditTarget, options: WorkItemEditOptions, roleKey: string): void {
  if (target !== read(targetAtom) || options !== read(optionsAtom) || read(operationAtom) !== 'roleMembers') return
  const role = options.roles?.options.find((entry) => entry.key === roleKey)
  if (!role) return
  resetMemberSearch()
  changeDraft(target, { roleKey: role.key, roleUserKeys: [...role.userKeys], roleBaseUserKeys: [...role.userKeys] })
}

function knownMembers(options: WorkItemEditOptions, results: User[], draft = read(draftAtom)): User[] {
  const users = selectedRole(options, draft)?.users ?? []
  return [...new Map([...users, ...results].map((user) => [user.key, user])).values()]
}

function selectedMembers(options: WorkItemEditOptions, draft: Draft): string[] {
  return draft.roleUserKeys ?? selectedRole(options, draft)?.userKeys ?? []
}

function memberScopeMatches(target: EditTarget, options: WorkItemEditOptions, roleKey: string): boolean {
  return target === read(targetAtom) && options === read(optionsAtom) && read(operationAtom) === 'roleMembers' && read(draftAtom).roleKey === roleKey
}

function editInput(target: EditTarget, options: WorkItemEditOptions, operation: Operation, draft: Draft): EditWorkItemInput | null {
  if (editCapability(options, operation).state !== 'available') return null
  const base = { ...target.ref, expectedUpdatedAt: target.detail.updatedAt }
  if (operation === 'name') {
    const value = draft.name.trim()
    return value && value !== target.detail.name ? { ...base, operation, value } : null
  }
  if (operation === 'description') {
    return draft.description !== target.detail.description ? { ...base, operation, value: draft.description } : null
  }
  if (operation === 'priority') {
    const value = draft.priorityKey
    return value !== null && value !== options.priority.currentKey && options.priority.options.some((option) => option.key === value)
      ? { ...base, operation, value } : null
  }
  if (operation === 'status') {
    return options.status.transitions.some((transition) => transition.id === draft.transitionId)
      ? { ...base, operation, transitionId: draft.transitionId } : null
  }
  if (operation !== 'roleMembers') return null
  const role = selectedRole(options, draft)
  if (!role) return null
  const userKeys = selectedMembers(options, draft)
  const allowed = new Set([...role.userKeys, ...knownMembers(options, read(memberResultsAtom), draft).map((user) => user.key)])
  const current = new Set(role.userKeys)
  const changed = userKeys.length !== current.size || userKeys.some((key) => !current.has(key))
  if (!changed || new Set(userKeys).size !== userKeys.length || userKeys.some((key) => !allowed.has(key))) return null
  return { ...base, operation: 'roleMembers', roleKey: role.key, userKeys: [...userKeys] }
}

function rememberUnverified(target: EditTarget, operation: Operation, draft: Draft, members: User[], roleLabel?: string): void {
  const unresolved = new Map(read(unverifiedAtom))
  unresolved.set(target.key, { operation, draft: copyDraft(draft), ...(roleLabel ? { roleLabel } : {}), members: members.map((user) => ({ ...user })) })
  set(unverifiedAtom, unresolved)
}

async function saveEdit(target: EditTarget, onSaved: SaveHandler, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || editBusy() || connectionChanging() || read(unverifiedAtom).has(target.key)) return
  const options = read(optionsAtom)
  if (options === null) return
  const operation = read(operationAtom)
  const draft = copyDraft(read(draftAtom))
  const input = editInput(target, options, operation, draft)
  const members = knownMembers(options, read(memberResultsAtom), draft)
  const roleLabel = operation === 'roleMembers' ? selectedRole(options, draft)?.label : undefined
  if (input === null) return
  set(pendingWritesAtom, read(pendingWritesAtom) + 1)
  set(errorAtom, null)
  set(messageAtom, null)
  let confirmed: WorkItemDetail | undefined
  try {
    const result = await plugin.request('meego.editWorkItem', input, WRITE_REQUEST_OPTIONS)
    if (result.state === 'unverified') {
      rememberUnverified(target, operation, draft, members, roleLabel)
    } else if (target === read(targetAtom)) {
      confirmed = result.item
    }
  } catch (error) {
    if (writeResponseLost(error)) {
      rememberUnverified(target, operation, draft, members, roleLabel)
    } else if (target === read(targetAtom)) {
      set(errorAtom, messageOf(error))
      await onError(error)
    }
  } finally {
    set(pendingWritesAtom, read(pendingWritesAtom) - 1)
  }
  if (confirmed === undefined || target !== read(targetAtom)) return
  await publishDetail(target, confirmed, 'confirmed', onSaved)
}

async function publishDetail(target: EditTarget, item: WorkItemDetail, outcome: 'confirmed' | 'adopted', onSaved: SaveHandler): Promise<void> {
  resetEdit(item, target.ref.expectedUserKey)
  try {
    await onSaved(item, outcome)
    if (read(targetAtom)?.key === target.key) set(messageAtom, outcome === 'confirmed' ? '修改已确认' : '已采用最新详情')
  } catch (error) {
    if (read(targetAtom)?.key === target.key) set(errorAtom, `无法刷新详情。${messageOf(error)}`)
  }
}

async function searchMembers(target: EditTarget, options: WorkItemEditOptions, onError: ErrorHandler): Promise<void> {
  const query = read(memberQueryAtom).trim()
  const role = selectedRole(options, read(draftAtom))
  if (!role || !query || !memberScopeMatches(target, options, role.key)) return
  const request = ++memberRequest
  set(memberLoadingAtom, true)
  set(memberErrorAtom, null)
  try {
    const { users } = await plugin.request('meego.searchMembers', { ...target.ref, query })
    if (request !== memberRequest || !memberScopeMatches(target, options, role.key)) return
    set(memberResultsAtom, [...new Map([...read(memberResultsAtom), ...users].map((user) => [user.key, user])).values()])
    set(memberMatchKeysAtom, users.map((user) => user.key))
  } catch (error) {
    if (request !== memberRequest || !memberScopeMatches(target, options, role.key)) return
    set(memberErrorAtom, messageOf(error))
    await onError(error)
  } finally {
    if (request === memberRequest && memberScopeMatches(target, options, role.key)) set(memberLoadingAtom, false)
  }
}

function selectMember(target: EditTarget, userKey: string, options: WorkItemEditOptions): void {
  const role = selectedRole(options, read(draftAtom))
  if (!role || !memberScopeMatches(target, options, role.key)) return
  if (!knownMembers(options, read(memberResultsAtom)).some((user) => user.key === userKey)) return
  const selected = selectedMembers(options, read(draftAtom))
  changeDraft(target, { roleUserKeys: selected.includes(userKey) ? selected.filter((key) => key !== userKey) : [...selected, userKey] })
}

function assignToMe(target: EditTarget, options: WorkItemEditOptions, currentUserKey: string): void {
  const role = selectedRole(options, read(draftAtom))
  if (!role || !memberScopeMatches(target, options, role.key) || currentUserKey !== target.ref.expectedUserKey) return
  set(memberResultsAtom, [...read(memberResultsAtom).filter((user) => user.key !== currentUserKey), { key: currentUserKey, name: '我' }])
  const current = selectedMembers(options, read(draftAtom))
  changeDraft(target, { roleUserKeys: [...new Set([...current, currentUserKey])] })
}

async function openBrowser(target: EditTarget): Promise<void> {
  if (target !== read(targetAtom)) return
  try {
    await shell.openExternal(target.detail.url)
  } catch (error) {
    if (target === read(targetAtom)) set(errorAtom, messageOf(error))
  }
}

async function readBack(target: EditTarget, unresolved: UnverifiedEdit, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || read(readingBackAtom)) return
  set(readingBackAtom, true)
  set(errorAtom, null)
  try {
    const [{ item }, { options }] = await Promise.all([
      plugin.request('meego.getWorkItem', target.ref),
      plugin.request('meego.editOptions', target.ref)
    ])
    if (target !== read(targetAtom) || read(unverifiedAtom).get(target.key) !== unresolved) return
    set(readbackAtom, { item, options })
  } catch (error) {
    if (target !== read(targetAtom) || read(unverifiedAtom).get(target.key) !== unresolved) return
    set(errorAtom, messageOf(error))
    await onError(error)
  } finally {
    if (target === read(targetAtom)) set(readingBackAtom, false)
  }
}

function acknowledgeNotSaved(target: EditTarget, unresolved: UnverifiedEdit, onError: ErrorHandler): Promise<void> | undefined {
  if (target !== read(targetAtom) || read(unverifiedAtom).get(target.key) !== unresolved) return
  const fresh = read(readbackAtom)?.item ?? target.detail
  const all = new Map(read(unverifiedAtom))
  all.delete(target.key)
  set(unverifiedAtom, all)
  resetEdit(fresh, target.ref.expectedUserKey)
  set(draftAtom, copyDraft(unresolved.draft))
  set(memberResultsAtom, unresolved.members.map((user) => ({ ...user })))
  set(operationAtom, unresolved.operation)
  set(openAtom, true)
  const next = read(targetAtom)
  if (next) return loadOptions(next, onError)
}

async function adoptReadback(target: EditTarget, unresolved: UnverifiedEdit, onSaved: SaveHandler): Promise<void> {
  const readback = read(readbackAtom)
  if (target !== read(targetAtom) || read(unverifiedAtom).get(target.key) !== unresolved || readback === null) return
  const all = new Map(read(unverifiedAtom))
  all.delete(target.key)
  set(unverifiedAtom, all)
  await publishDetail(target, readback.item, 'adopted', onSaved)
}

export function EditPanel({ onSaved, onError, currentUserKey }: {
  onSaved: SaveHandler; onError: ErrorHandler; currentUserKey?: string
}) {
  const target = read(targetAtom)
  if (target === null) return null
  const open = read(openAtom)
  const options = read(optionsAtom)
  const draft = read(draftAtom)
  const operation = read(operationAtom)
  const loading = read(loadingAtom)
  const unresolved = read(unverifiedAtom).get(target.key)
  const error = read(errorAtom)
  const message = read(messageAtom)
  const readback = read(readbackAtom)
  const blocked = editBusy() || connectionChanging() || Boolean(unresolved)
  const matches = read(memberMatchKeysAtom)
  const selected = options ? selectedMembers(options, draft) : []
  const role = options ? selectedRole(options, draft) : undefined
  const save = () => saveEdit(target, onSaved, onError)
  return (
    <Stack gap="sm">
      <Separator />
      <Row justify="between" align="center" gap="xs" wrap>
        <Heading level={3}>字段编辑</Heading>
        <Button size="sm" variant="ghost" icon={open ? 'collapse' : 'edit'} disabled={connectionChanging()} onPress={() => toggleEdit(target, onError)}>
          {open ? '收起编辑' : '编辑工作项'}
        </Button>
      </Row>
      {unresolved && !open ? <Text size="xs" tone="warning">有一项编辑待核对</Text> : null}
      {message !== null ? <Text size="sm" tone="success">{message}</Text> : null}
      {error !== null ? <Callout tone="danger" title="无法完成编辑"><Text size="sm">{error}</Text></Callout> : null}
      {open ? (
        <Stack gap="sm">
          {loading ? <Spinner label="正在读取可编辑字段…" /> : null}
          {!loading && options === null ? <Button size="sm" variant="outline" onPress={() => loadOptions(target, onError)}>重新读取编辑选项</Button> : null}
          {options !== null ? (
            <EditFields options={options} draft={draft} operation={operation} disabled={blocked} saving={editBusy()}
              canSave={editInput(target, options, operation, draft) !== null} browserUrl={target.detail.url}
              onOperation={(value) => changeOperation(target, value)} onRole={(value) => changeRole(target, options, value)} onChange={(change) => changeDraft(target, change)}
              onSave={save} onBrowser={() => openBrowser(target)}
              members={{
                users: knownMembers(options, read(memberResultsAtom)).filter((user) => (role?.userKeys ?? []).includes(user.key) || (matches ?? []).includes(user.key) || selected.includes(user.key)),
                selected, query: read(memberQueryAtom), noMatches: matches?.length === 0,
                searching: read(memberLoadingAtom), error: read(memberErrorAtom), disabled: blocked,
                currentUserKey: currentUserKey === target.ref.expectedUserKey ? currentUserKey : undefined,
                onQuery: (value) => {
                  if (!role || !memberScopeMatches(target, options, role.key)) return
                  memberRequest += 1
                  set(memberQueryAtom, value)
                  set(memberMatchKeysAtom, null)
                  set(memberLoadingAtom, false)
                  set(memberErrorAtom, null)
                },
                onSearch: () => searchMembers(target, options, onError),
                onSelect: (key) => selectMember(target, key, options),
                onAssignSelf: () => { if (currentUserKey) assignToMe(target, options, currentUserKey) }
              }} />
          ) : null}
          {unresolved ? (
            <EditRecovery operation={unresolved.operation} roleKey={unresolved.draft.roleKey} roleLabel={unresolved.roleLabel} readback={readback} reading={read(readingBackAtom)}
              busy={editBusy()} browserUrl={target.detail.url} onRead={() => readBack(target, unresolved, onError)}
              onBrowser={() => openBrowser(target)} onAcknowledge={() => acknowledgeNotSaved(target, unresolved, onError)}
              onAdopt={() => adoptReadback(target, unresolved, onSaved)} />
          ) : null}
        </Stack>
      ) : null}
    </Stack>
  )
}
