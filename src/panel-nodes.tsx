import { atom, Button, Callout, Heading, Row, Separator, Spinner, Stack, Text, plugin, read, set, shell } from 'orca'
import type { EditWorkItemNodeInput, WorkItemDetail, WorkItemNode, WorkItemNodeList, WorkItemReference } from './protocol'
import { connectionChanging } from './panel-connection'
import { WRITE_REQUEST_OPTIONS, writeResponseLost } from './panel-write'
import { NodeActions, NodeConfirmation, NodeRecovery, NodesList, type NodePlan, type NodeReadback } from './panel-nodes-view'
import type { MemberChoice } from './panel-member-picker'

type Operation = EditWorkItemNodeInput['operation']
type ErrorHandler = (error: unknown) => Promise<void>
type SaveHandler = (item: WorkItemDetail, outcome?: 'confirmed' | 'adopted') => Promise<void>
type Target = { key: string; ref: WorkItemReference; detail: WorkItemDetail }
interface NodesState {
  open: boolean
  list: WorkItemNodeList | null
  loading: boolean
  selectedKey: string
  node: WorkItemNode | null
  inspecting: boolean
  operation: Operation
  reason: string
  selectedOwners: string[]
  members: MemberChoice[]
  query: string
  matches: string[] | null
  searching: boolean
  memberError: string | null
  error: string | null
  message: string | null
  plan: NodePlan | null
  readback: NodeReadback | null
  reading: boolean
}

function initialState(): NodesState {
  return {
    open: false, list: null, loading: false, selectedKey: '', node: null, inspecting: false,
    operation: 'confirm', reason: '', selectedOwners: [], members: [], query: '', matches: null,
    searching: false, memberError: null, error: null, message: null, plan: null, readback: null, reading: false
  }
}

const targetAtom = atom<Target | null>(null)
const stateAtom = atom<NodesState>(initialState())
const unresolvedAtom = atom<ReadonlyMap<string, NodePlan>>(new Map())
const pendingWritesAtom = atom(0)
let listRequest = 0
let inspectRequest = 0
let memberRequest = 0

export function nodesBusy(): boolean {
  return read(pendingWritesAtom) > 0
}

export function resetNodes(detail?: WorkItemDetail, expectedUserKey?: string): void {
  listRequest += 1
  inspectRequest += 1
  memberRequest += 1
  let target: Target | null = null
  if (detail) {
    const ref: WorkItemReference = {
      id: detail.id, typeKey: detail.typeKey,
      ...(detail.source ? { source: { ...detail.source } } : {}),
      ...(expectedUserKey ? { expectedUserKey } : {})
    }
    const key = JSON.stringify([ref.source?.baseUrl, ref.source?.projectKey, expectedUserKey, ref.typeKey, String(ref.id)])
    target = { key, ref, detail: { ...detail } }
  }
  set(targetAtom, target)
  set(stateAtom, initialState())
}

function patch(target: Target, change: Partial<NodesState>): void {
  if (target === read(targetAtom)) set(stateAtom, { ...read(stateAtom), ...change })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadNodes(target: Target, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || nodesBusy()) return
  const request = ++listRequest
  inspectRequest += 1
  memberRequest += 1
  patch(target, { loading: true, error: null, selectedKey: '', node: null, plan: null, inspecting: false })
  try {
    const list = await plugin.request('meego.workflowNodes', target.ref)
    if (request !== listRequest) return
    patch(target, { list })
  } catch (error) {
    if (target !== read(targetAtom) || request !== listRequest) return
    patch(target, { error: messageOf(error) })
    await onError(error)
  } finally {
    if (request === listRequest) patch(target, { loading: false })
  }
}

function toggleNodes(target: Target, onError: ErrorHandler): Promise<void> | undefined {
  if (target !== read(targetAtom)) return
  const open = !read(stateAtom).open
  patch(target, { open })
  if (open && read(stateAtom).list === null && !read(stateAtom).loading) return loadNodes(target, onError)
}

async function selectNode(target: Target, nodeKey: string, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || !read(stateAtom).list?.nodes.some((node) => node.key === nodeKey) || nodesBusy()) return
  const request = ++inspectRequest
  memberRequest += 1
  patch(target, {
    selectedKey: nodeKey, node: null, inspecting: true, plan: null, error: null, reason: '',
    selectedOwners: [], members: [], query: '', matches: null, searching: false, memberError: null
  })
  try {
    const { node } = await plugin.request('meego.inspectWorkflowNode', { ...target.ref, nodeKey })
    if (target !== read(targetAtom) || request !== inspectRequest) return
    if (node.key !== nodeKey) throw new Error('所选节点已变化，重新选择后再操作。')
    const operation = node.actions.confirm.state === 'available' ? 'confirm' : node.actions.rollback.state === 'available' ? 'rollback' : 'owners'
    patch(target, { node, operation, selectedOwners: node.owners.map((owner) => owner.key), members: node.owners.map((owner) => ({ ...owner })) })
  } catch (error) {
    if (target !== read(targetAtom) || request !== inspectRequest) return
    patch(target, { error: messageOf(error) })
    await onError(error)
  } finally {
    if (request === inspectRequest) patch(target, { inspecting: false })
  }
}

function changeOperation(target: Target, node: WorkItemNode, operation: string): void {
  if (target !== read(targetAtom) || node !== read(stateAtom).node) return
  if (operation === 'confirm' || operation === 'rollback' || operation === 'owners') patch(target, { operation, plan: null, error: null })
}

function prepareInput(target: Target, state: NodesState): EditWorkItemNodeInput | null {
  const node = state.node
  if (!node || !node.revision || target.detail.updatedAt === null || node.actions[state.operation].state !== 'available') return null
  const base = { ...target.ref, nodeKey: node.key, expectedRevision: node.revision, expectedUpdatedAt: target.detail.updatedAt }
  if (state.operation === 'confirm') return { ...base, operation: 'confirm' }
  if (state.operation === 'rollback') return state.reason.trim() ? { ...base, operation: 'rollback', reason: state.reason.trim() } : null
  const allowed = new Set([...node.owners.map((owner) => owner.key), ...state.members.map((user) => user.key)])
  const current = new Set(node.owners.map((owner) => owner.key))
  const changed = current.size !== state.selectedOwners.length || state.selectedOwners.some((key) => !current.has(key))
  return changed && state.selectedOwners.every((key) => allowed.has(key)) ? { ...base, operation: 'owners', userKeys: [...state.selectedOwners] } : null
}

function prepare(target: Target, node: WorkItemNode, operation: Operation): void {
  if (node !== read(stateAtom).node || operation !== read(stateAtom).operation) return
  if (target !== read(targetAtom) || nodesBusy() || connectionChanging() || read(unresolvedAtom).has(target.key)) return
  const state = read(stateAtom)
  const input = prepareInput(target, state)
  if (input === null || state.node === null) return
  patch(target, { plan: { input, node: { ...state.node, owners: state.node.owners.map((owner) => ({ ...owner })) }, members: state.members.map((member) => ({ ...member })) } })
}

async function confirmPlan(target: Target, plan: NodePlan, onSaved: SaveHandler, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || plan !== read(stateAtom).plan || nodesBusy() || connectionChanging() || read(unresolvedAtom).has(target.key)) return
  set(pendingWritesAtom, read(pendingWritesAtom) + 1)
  patch(target, { error: null, message: null })
  let confirmed: NodeReadback | undefined
  try {
    const result = await plugin.request('meego.editWorkflowNode', plan.input, WRITE_REQUEST_OPTIONS)
    if (result.state === 'unverified') rememberUnresolved(target, plan)
    else if (target === read(targetAtom)) confirmed = result
  } catch (error) {
    if (writeResponseLost(error)) rememberUnresolved(target, plan)
    else if (target === read(targetAtom)) {
      patch(target, { error: messageOf(error), plan: null })
      await onError(error)
    }
  } finally {
    set(pendingWritesAtom, read(pendingWritesAtom) - 1)
  }
  if (confirmed && target === read(targetAtom)) await publish(target, confirmed, 'confirmed', onSaved)
}

function rememberUnresolved(target: Target, plan: NodePlan): void {
  const unresolved = new Map(read(unresolvedAtom))
  unresolved.set(target.key, plan)
  set(unresolvedAtom, unresolved)
  patch(target, { plan: null, readback: null })
}

async function publish(target: Target, snapshot: NodeReadback, outcome: 'confirmed' | 'adopted', onSaved: SaveHandler): Promise<void> {
  resetNodes(snapshot.item, target.ref.expectedUserKey)
  try {
    await onSaved(snapshot.item, outcome)
    const next = read(targetAtom)
    if (next?.key === target.key) patch(next, { open: true, list: snapshot.nodes, message: outcome === 'confirmed' ? '节点操作已确认' : '已采用最新流程' })
  } catch (error) {
    const next = read(targetAtom)
    if (next?.key === target.key) patch(next, { error: `无法更新详情。${messageOf(error)}` })
  }
}

async function readBack(target: Target, unresolved: NodePlan, onError: ErrorHandler): Promise<NodeReadback | null> {
  if (target !== read(targetAtom) || read(stateAtom).reading) return null
  patch(target, { reading: true, error: null })
  try {
    const [{ item }, nodes] = await Promise.all([
      plugin.request('meego.getWorkItem', target.ref), plugin.request('meego.workflowNodes', target.ref)
    ])
    if (target !== read(targetAtom) || read(unresolvedAtom).get(target.key) !== unresolved) return null
    const snapshot = { item, nodes }
    patch(target, { readback: snapshot })
    return snapshot
  } catch (error) {
    if (target === read(targetAtom)) {
      patch(target, { error: messageOf(error) })
      await onError(error)
    }
    return null
  } finally {
    patch(target, { reading: false })
  }
}

async function acknowledgeNotExecuted(target: Target, unresolved: NodePlan, onError: ErrorHandler): Promise<void> {
  const snapshot = read(stateAtom).readback ?? await readBack(target, unresolved, onError)
  if (!snapshot || target !== read(targetAtom) || read(unresolvedAtom).get(target.key) !== unresolved) return
  clearUnresolved(target)
  resetNodes(snapshot.item, target.ref.expectedUserKey)
  const next = read(targetAtom)
  if (next === null) return
  patch(next, { open: true, list: snapshot.nodes })
  if (!snapshot.nodes.nodes.some((node) => node.key === unresolved.node.key)) return
  await selectNode(next, unresolved.node.key, onError)
  patch(next, {
    operation: unresolved.input.operation, reason: unresolved.input.operation === 'rollback' ? unresolved.input.reason ?? '' : '',
    ...(unresolved.input.operation === 'owners' ? { selectedOwners: [...unresolved.input.userKeys], members: [...new Map([...unresolved.members, ...read(stateAtom).members].map((member) => [member.key, member])).values()] } : {})
  })
}

function clearUnresolved(target: Target): void {
  const all = new Map(read(unresolvedAtom))
  all.delete(target.key)
  set(unresolvedAtom, all)
}

async function adoptReadback(target: Target, unresolved: NodePlan, onSaved: SaveHandler): Promise<void> {
  const snapshot = read(stateAtom).readback
  if (!snapshot || target !== read(targetAtom) || read(unresolvedAtom).get(target.key) !== unresolved) return
  clearUnresolved(target)
  await publish(target, snapshot, 'adopted', onSaved)
}

async function openBrowser(target: Target): Promise<void> {
  if (target !== read(targetAtom)) return
  try {
    await shell.openExternal(target.detail.url)
  } catch (error) {
    patch(target, { error: messageOf(error) })
  }
}

async function searchMembers(target: Target, node: WorkItemNode, onError: ErrorHandler): Promise<void> {
  const query = read(stateAtom).query.trim()
  if (target !== read(targetAtom) || node !== read(stateAtom).node || !query) return
  const request = ++memberRequest
  patch(target, { searching: true, memberError: null })
  try {
    const { users } = await plugin.request('meego.searchMembers', { ...target.ref, query })
    if (target !== read(targetAtom) || node !== read(stateAtom).node || request !== memberRequest) return
    const members = [...new Map([...read(stateAtom).members, ...users].map((user) => [user.key, user])).values()]
    patch(target, { members, matches: users.map((user) => user.key) })
  } catch (error) {
    if (target !== read(targetAtom) || node !== read(stateAtom).node || request !== memberRequest) return
    patch(target, { memberError: messageOf(error) })
    await onError(error)
  } finally {
    if (request === memberRequest) patch(target, { searching: false })
  }
}

function selectMember(target: Target, node: WorkItemNode, key: string): void {
  const state = read(stateAtom)
  if (target !== read(targetAtom) || node !== state.node || !state.members.some((member) => member.key === key)) return
  patch(target, { selectedOwners: state.selectedOwners.includes(key) ? state.selectedOwners.filter((entry) => entry !== key) : [...state.selectedOwners, key], plan: null })
}

function assignSelf(target: Target, node: WorkItemNode, userKey: string): void {
  if (target !== read(targetAtom) || node !== read(stateAtom).node || userKey !== target.ref.expectedUserKey) return
  const state = read(stateAtom)
  patch(target, { members: [...state.members.filter((member) => member.key !== userKey), { key: userKey, name: '我' }], selectedOwners: [...new Set([...state.selectedOwners, userKey])], plan: null })
}

export function NodesPanel({ onSaved, onError, currentUserKey }: { onSaved: SaveHandler; onError: ErrorHandler; currentUserKey?: string }) {
  const target = read(targetAtom)
  if (target === null) return null
  const state = read(stateAtom)
  const unresolved = read(unresolvedAtom).get(target.key)
  const busy = nodesBusy() || connectionChanging()
  const blocked = busy || Boolean(unresolved)
  const node = state.node
  const plan = state.plan
  return (
    <Stack gap="sm">
      <Separator />
      <Row gap="xs" justify="between" align="center" wrap>
        <Heading level={3}>流程节点</Heading>
        <Button size="sm" variant="ghost" icon={state.open ? 'collapse' : 'expand'} disabled={connectionChanging()} onPress={() => toggleNodes(target, onError)}>{state.open ? '收起流程节点' : '查看流程节点'}</Button>
      </Row>
      {unresolved && !state.open ? <Text size="xs" tone="warning">有一项节点操作待核对</Text> : null}
      {state.error ? <Callout tone="danger" title="无法完成节点操作"><Text size="sm">{state.error}</Text></Callout> : null}
      {state.message ? <Text size="sm" tone="success">{state.message}</Text> : null}
      {state.open ? (
        <Stack gap="sm">
          {state.loading ? <Spinner label="正在读取流程节点…" /> : null}
          {state.list ? <NodesList list={state.list} selectedKey={state.selectedKey} disabled={busy || state.loading} browserUrl={target.detail.url} onBrowser={() => openBrowser(target)} onSelect={(key) => selectNode(target, key, onError)} /> : null}
          {!state.loading && !unresolved ? <Row justify="start"><Button size="sm" variant="ghost" icon="refresh" disabled={busy} onPress={() => loadNodes(target, onError)}>刷新流程节点</Button></Row> : null}
          {state.inspecting ? <Spinner label="正在检查所选节点的操作条件…" /> : null}
          {node ? <NodeActions node={node} operation={state.operation} reason={state.reason} blocked={blocked} canPrepare={prepareInput(target, state) !== null}
            browserUrl={target.detail.url} onBrowser={() => openBrowser(target)} onOperation={(value) => changeOperation(target, node, value)}
            onReason={(reason) => { if (node === read(stateAtom).node) patch(target, { reason, plan: null }) }} onPrepare={() => prepare(target, node, state.operation)}
            members={{
              users: state.members.filter((member) => node.owners.some((owner) => owner.key === member.key) || state.selectedOwners.includes(member.key) || (state.matches ?? []).includes(member.key)),
              selected: state.selectedOwners, query: state.query, searching: state.searching, noMatches: state.matches?.length === 0,
              error: state.memberError, disabled: blocked, description: `仅调整「${node.name}」节点的负责人，已选成员会保留。`,
              searchLabel: '搜索节点负责人', candidatesLabel: '所选节点的负责人候选成员',
              currentUserKey: currentUserKey === target.ref.expectedUserKey ? currentUserKey : undefined,
              onQuery: (query) => {
                if (target !== read(targetAtom) || node !== read(stateAtom).node) return
                memberRequest += 1
                patch(target, { query, matches: null, searching: false, memberError: null, plan: null })
              },
              onSearch: () => searchMembers(target, node, onError), onSelect: (key) => selectMember(target, node, key),
              onAssignSelf: () => { if (currentUserKey) assignSelf(target, node, currentUserKey) }
            }} /> : null}
          {node && target.detail.updatedAt === null ? <Text size="sm" muted>当前工作项缺少可核对的版本，刷新详情后再修改节点。</Text> : null}
          {plan ? <NodeConfirmation plan={plan} busy={busy} onConfirm={() => confirmPlan(target, plan, onSaved, onError)} onCancel={() => patch(target, { plan: null })} /> : null}
          {unresolved ? <NodeRecovery plan={unresolved} readback={state.readback} busy={busy} reading={state.reading} browserUrl={target.detail.url}
            onRead={async () => { await readBack(target, unresolved, onError) }} onBrowser={() => openBrowser(target)}
            onAcknowledge={() => acknowledgeNotExecuted(target, unresolved, onError)} onAdopt={() => adoptReadback(target, unresolved, onSaved)} /> : null}
        </Stack>
      ) : null}
    </Stack>
  )
}
