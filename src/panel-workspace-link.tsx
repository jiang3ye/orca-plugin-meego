import { atom, Badge, Box, Button, Callout, Heading, KeyValue, Row, Select, Spinner, Stack, Text, plugin, read, set, type Tone } from 'orca'
import type { CreatedWorkspaceReceipt, WorkItemDetail, WorkItemReference, WorkspaceContextInfo, WorkspaceOption, WorkspaceOptions } from './protocol'
import { connectionChanging } from './panel-connection'
import { beginHandoff, cancelHandoff, handoffBusy, HandoffView } from './panel-handoff'
import { beginWorkspaceCreation, resetWorkspaceCreation, WorkspaceCreationPanel, workspaceCreationBusy } from './panel-workspace-create'
import { sameWorkItemId } from './meego/work-item-id'

type Target = { key: string; item: WorkItemDetail; ref: WorkItemReference }
type ErrorHandler = (error: unknown) => Promise<void>
const targetAtom = atom<Target | null>(null)
const optionsAtom = atom<WorkspaceOptions | null>(null)
const selectedAtom = atom('')
const contextAtom = atom<WorkspaceContextInfo | null>(null)
const loadingAtom = atom(false)
const errorAtom = atom<string | null>(null)
const messageAtom = atom<{ text: string; tone: Tone } | null>(null)
const replacingAtom = atom<{ workspaceId: string; linkedAt: number } | null>(null)
const pendingAtom = atom(false)
let generation = 0

export function workspaceLinkBusy(): boolean { return read(pendingAtom) }

export function setWorkspaceLinkItem(item?: WorkItemDetail, expectedUserKey?: string): Promise<void> | undefined {
  generation += 1
  cancelHandoff('detail')
  const ref = item ? { id: item.id, typeKey: item.typeKey, ...(item.source ? { source: { ...item.source } } : {}), ...(expectedUserKey ? { expectedUserKey } : {}) } : null
  const key = ref ? JSON.stringify([ref.source?.baseUrl, ref.source?.projectKey, expectedUserKey, ref.typeKey, String(ref.id)]) : ''
  const same = read(targetAtom)?.key === key
  set(targetAtom, item && ref ? { key, item, ref } : null)
  if (!same) {
    set(optionsAtom, null)
    set(selectedAtom, '')
    set(contextAtom, null)
  }
  set(replacingAtom, null)
  set(errorAtom, null)
  set(messageAtom, null)
  set(loadingAtom, false)
  if (item) return refreshWorkspaceLink()
}

function valid(target: Target, request: number): boolean { return target === read(targetAtom) && request === generation }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function workspaceLocation(hostId: string | null): string {
  return hostId === null || hostId === 'local' ? '本机' : hostId.startsWith('ssh:') ? 'SSH 远端' : '配对远端'
}

function sameWorkspaceRevision(left: WorkspaceContextInfo, right: WorkspaceContextInfo): boolean {
  return left.workspaceId === right.workspaceId && left.branch === right.branch && left.path === right.path &&
    left.hostId === right.hostId && left.link?.linkedAt === right.link?.linkedAt
}

async function readSelected(target: Target, workspaceId: string, request: number): Promise<void> {
  const context = await plugin.request('meego.workspaceContext', { workspaceId })
  if (!valid(target, request) || workspaceId !== read(selectedAtom)) return
  if (context.workspaceId !== workspaceId) throw new Error(context.unavailableReason || '无法核对所选代码目录，请刷新工作区列表。')
  const previous = read(contextAtom)
  if (previous && (!sameWorkspaceRevision(previous, context) || (previous.isActive !== false && context.isActive === false))) cancelHandoff('detail')
  set(contextAtom, context)
}

export async function refreshWorkspaceLink(onError?: ErrorHandler): Promise<void> {
  const target = read(targetAtom)
  if (!target) return
  const request = ++generation
  set(loadingAtom, true)
  set(errorAtom, null)
  set(replacingAtom, null)
  try {
    const options = await plugin.request('meego.workspaceOptions', target.ref)
    if (!valid(target, request)) return
    set(optionsAtom, options)
    if (options.truncated || (read(selectedAtom) && !options.workspaces.some((row) => row.id === read(selectedAtom)))) cancelHandoff('detail')
    let workspaceId = read(selectedAtom)
    if (!workspaceId) {
      const linked = options.workspaces.filter((row) => row.linkedToItem)
      if (linked.length === 1) { workspaceId = linked[0].id; set(selectedAtom, workspaceId) }
    }
    if (workspaceId) await readSelected(target, workspaceId, request)
  } catch (error) {
    if (!valid(target, request)) return
    cancelHandoff('detail')
    set(errorAtom, errorMessage(error))
    await onError?.(error)
  } finally {
    if (valid(target, request)) set(loadingAtom, false)
  }
}

async function chooseWorkspace(target: Target, workspaceId: string, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || read(pendingAtom) || handoffBusy() || workspaceCreationBusy() || connectionChanging()) return
  if (!read(optionsAtom)?.workspaces.some((row) => row.id === workspaceId)) return
  set(selectedAtom, workspaceId)
  cancelHandoff('detail')
  set(contextAtom, null)
  set(messageAtom, null)
  resetWorkspaceCreation()
  await refreshWorkspaceLink(onError)
}

function isLinked(target: Target, context: WorkspaceContextInfo | null): boolean {
  const link = context?.link
  return Boolean(link && sameWorkItemId(link.workItemId, target.ref.id) && link.typeKey === target.ref.typeKey &&
    (!target.ref.expectedUserKey || !link.accountKey || link.accountKey === target.ref.expectedUserKey) &&
    (target.ref.source ? link.source?.baseUrl === target.ref.source.baseUrl && link.source.projectKey === target.ref.source.projectKey : link.url === target.item.url))
}

function available(context: WorkspaceContextInfo | null): context is WorkspaceContextInfo & { workspaceId: string } {
  return Boolean(context?.workspaceId && context.workspaceId === read(selectedAtom) && read(optionsAtom)?.workspaces.some((row) => row.id === context.workspaceId) && !read(optionsAtom)?.truncated && !read(errorAtom))
}

async function associate(target: Target, context: WorkspaceContextInfo, onError: ErrorHandler, replace = false): Promise<void> {
  if (target !== read(targetAtom) || context !== read(contextAtom) || !available(context) || read(loadingAtom) || workspaceLinkBusy() || handoffBusy() || connectionChanging()) return
  if (context.link && !replace) {
    set(replacingAtom, { workspaceId: context.workspaceId, linkedAt: context.link.linkedAt })
    return
  }
  if (replace && (read(replacingAtom)?.workspaceId !== context.workspaceId || read(replacingAtom)?.linkedAt !== context.link?.linkedAt)) return
  set(pendingAtom, true)
  set(errorAtom, null)
  set(messageAtom, null)
  cancelHandoff('detail')
  try {
    await plugin.request('meego.linkWorkspace', {
      workItemId: target.item.id, typeKey: target.item.typeKey, name: target.item.name, status: target.item.status,
      ...(target.item.url ? { url: target.item.url } : {}), ...(target.ref.source ? { source: target.ref.source } : {}),
      ...(target.ref.expectedUserKey ? { expectedUserKey: target.ref.expectedUserKey } : {}),
      workspaceId: context.workspaceId, expectedLinkedAt: context.link?.linkedAt ?? null
    })
    if (target !== read(targetAtom)) return
    await refreshWorkspaceLink(onError)
    if (target === read(targetAtom)) set(messageAtom, { text: '已保存开发工作区。接下来可打开代码目录，或交给 Agent。', tone: 'success' })
  } catch (error) {
    if (target === read(targetAtom)) set(errorAtom, errorMessage(error))
    await onError(error)
  } finally { set(pendingAtom, false) }
}

async function openWorkspace(target: Target, context: WorkspaceContextInfo, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || context !== read(contextAtom) || !available(context) || workspaceLinkBusy() || connectionChanging()) return
  set(pendingAtom, true)
  try {
    await plugin.request('meego.openWorkspace', { workspaceId: context.workspaceId })
    if (target === read(targetAtom)) await refreshWorkspaceLink(onError)
  } catch (error) {
    if (target === read(targetAtom)) set(errorAtom, errorMessage(error))
    await onError(error)
  } finally { set(pendingAtom, false) }
}

async function unlinkWorkspace(target: Target, context: WorkspaceContextInfo, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom) || context !== read(contextAtom) || !available(context) || !isLinked(target, context) || !context.link || workspaceLinkBusy() || connectionChanging()) return
  set(pendingAtom, true)
  cancelHandoff('detail')
  try {
    await plugin.request('meego.unlinkWorkspace', { workspaceId: context.workspaceId, expectedLinkedAt: context.link.linkedAt })
    if (target === read(targetAtom)) await refreshWorkspaceLink(onError)
  } catch (error) {
    if (target === read(targetAtom)) set(errorAtom, errorMessage(error))
    await onError(error)
  } finally { set(pendingAtom, false) }
}

async function createdWorkspace(target: Target, receipt: CreatedWorkspaceReceipt, onError: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom)) return
  set(selectedAtom, receipt.workspaceId)
  set(contextAtom, null)
  await refreshWorkspaceLink(onError)
}

function WorkspacePreview({ workspace }: { workspace: WorkspaceOption }) {
  return <KeyValue label="代码目录" items={[
    { label: '工作区', value: workspace.name },
    { label: '项目', value: workspace.project || '未归入项目' },
    { label: '分支', value: workspace.branch || (workspace.kind === 'folder' ? '文件夹工作区' : '未提供分支') },
    { label: '位置', value: workspaceLocation(workspace.hostId) },
    { label: '路径', value: workspace.path }
  ]} />
}

export function WorkspaceLinkPanel({ disabled = false, onError }: { disabled?: boolean; onError: ErrorHandler }) {
  const target = read(targetAtom)
  if (!target) return null
  const options = read(optionsAtom)
  const workspaceId = read(selectedAtom)
  const workspace = options?.workspaces.find((row) => row.id === workspaceId)
  const context = read(contextAtom)
  const loading = read(loadingAtom)
  const busy = disabled || loading || workspaceLinkBusy() || handoffBusy() || workspaceCreationBusy() || connectionChanging()
  const linked = isLinked(target, context)
  const ready = available(context)
  const replacing = read(replacingAtom)
  const message = read(messageAtom)
  const report = (text: string, tone: Tone) => { if (target === read(targetAtom)) set(messageAtom, { text, tone }) }
  return <Box padding="sm" border radius="md" gap="sm">
    <Heading level={3}>开发工作区</Heading>
    <Text size="sm" muted>选择处理此工作项的代码目录。保存关联后，Agent 会在这个工作区接收任务。</Text>
    {loading ? <Spinner label="正在读取开发工作区…" /> : null}
    {read(errorAtom) ? <Callout tone="danger" title="无法读取或保存工作区"><Text size="sm">{read(errorAtom)}</Text></Callout> : null}
    {options?.message ? <Text size="sm" tone="warning">{options.message}</Text> : null}
    {options?.truncated ? <Text size="sm" tone="warning">工作区列表不完整，刷新得到完整列表后才能保存或交接。</Text> : null}
    {options?.workspaces.length ? <Select label="选择代码目录" value={workspace ? workspaceId : ''} placeholder="选择已有工作区" disabled={busy}
      options={options.workspaces.map((row) => {
        const name = Array.from(row.name)
        const label = name.length > 12 ? `${name.slice(0, 12).join('')}…` : row.name
        const markers = [row.linkedToItem ? '已关联' : '', options.activeWorkspaceId === row.id ? '当前' : ''].filter(Boolean)
        return { value: row.id, label: `${label}${markers.length ? `（${markers.join(' · ')}）` : ''}` }
      })}
      onChange={(id) => chooseWorkspace(target, id, onError)} /> : !loading && !read(errorAtom) ? <Text size="sm">尚无可选代码目录。在 Orca 中添加本机项目或文件夹后刷新，也可从已有 Git 项目新建工作区。</Text> : null}
    {workspace ? <WorkspacePreview workspace={workspace} /> : null}
    {workspaceId && !workspace && !loading ? <Text size="sm" tone="warning">所选代码目录已不在可用列表中，请重新选择；刷新不会替你更换目录。</Text> : null}
    {context?.unavailableReason ? <Text size="sm" tone="warning">{context.unavailableReason}</Text> : null}
    {workspace && context && ready ? <Stack gap="sm">
      {linked ? <Row gap="xs" wrap><Badge tone="success">已关联此工作项</Badge><Text size="sm">{workspace.name}</Text></Row>
        : context.link ? <Text size="sm" tone="warning">{`此目录已关联 #${context.link.workItemId} ${context.link.name}。替换前会再次确认。`}</Text>
          : <Text size="sm" muted>确认上方目录后，保存为此工作项的开发工作区。</Text>}
      {context.branchChanged ? <Text size="sm" tone="warning">{`关联时分支为 ${context.link?.branch ?? '未提供'}，当前目录分支已变化。`}</Text> : null}
      <Row gap="xs" wrap>
        {linked ? <>
          <Button size="sm" variant="solid" tone="accent" icon="agent" disabled={busy} onPress={() => {
            const current = read(contextAtom)
            if (target !== read(targetAtom) || !available(current) || !sameWorkspaceRevision(context, current) || !current.link || !isLinked(target, current)) return
            beginHandoff({ item: target.ref, name: target.item.name, description: target.item.description, origin: 'detail',
              expectedUserKey: target.ref.expectedUserKey, expectedLinkedAt: current.link.linkedAt }, current)
          }}>交给 Agent</Button>
          <Button size="sm" variant="outline" disabled={busy} onPress={() => openWorkspace(target, context, onError)}>打开工作区</Button>
          <Button size="sm" variant="ghost" disabled={busy} onPress={() => unlinkWorkspace(target, context, onError)}>解除此关联</Button>
        </> : <Button size="sm" variant="solid" tone="accent" disabled={busy} onPress={() => associate(target, context, onError)}>{context.link ? '替换为此工作项' : '关联此工作区'}</Button>}
      </Row>
      {!linked ? <Text size="xs" muted>关联后可交给 Agent；更换代码目录时，在上方重新选择并保存。</Text> : <Text size="xs" muted>要改用其他代码目录，在上方重新选择；已有工作区的关联会保留。</Text>}
    </Stack> : workspaceId && !loading && !read(errorAtom) ? <Text size="sm" muted>先核对所选工作区可用，再保存关联或交给 Agent。</Text> : null}
    {replacing && context?.workspaceId === replacing.workspaceId && context.link ? <Callout tone="warning" title="替换此目录的工作项关联">
      <Stack gap="xs"><Text size="sm">{`将 #${context.link.workItemId} ${context.link.name} 替换为 #${target.item.id} ${target.item.name}。代码目录不变。`}</Text>
        <Row gap="xs" wrap><Button size="sm" disabled={busy} onPress={() => associate(target, context, onError, true)}>确认替换关联</Button>
          <Button size="sm" variant="ghost" disabled={busy} onPress={() => set(replacingAtom, null)}>取消替换</Button></Row>
      </Stack></Callout> : null}
    <Row gap="xs" wrap>
      <Button size="sm" variant="ghost" icon="refresh" disabled={busy} onPress={() => refreshWorkspaceLink(onError)}>刷新可选工作区</Button>
      <Button size="sm" variant="outline" icon="branch" disabled={busy} onPress={() => beginWorkspaceCreation(target.ref)}>新建开发工作区</Button>
    </Row>
    {options?.workspaces.length ? <Text size="xs" muted>未看到目标目录？在 Orca 左侧添加或打开代码项目、文件夹后刷新。</Text> : null}
    <Text size="xs" muted>新建开发工作区会额外创建分支与代码目录。</Text>
    {message ? <Text size="sm" tone={message.tone}>{message.text}</Text> : null}
    <WorkspaceCreationPanel onError={onError} onCreated={(receipt) => createdWorkspace(target, receipt, onError)} />
    <HandoffView origin="detail" context={context} disabled={busy || !ready} report={report} onError={onError} />
  </Box>
}
