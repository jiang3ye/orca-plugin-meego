// No build step: Orca strips the types and compiles the JSX when the panel loads.
// The connection, current workspace, and work item views share one sidebar.
// All Meego data comes from the worker via typed plugin.request calls.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Markdown,
  RelativeTime,
  Row,
  Select,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Text,
  Toolbar,
  on,
  plugin,
  read,
  set,
  shell,
  type PanelContext,
  type Tone
} from 'orca'
import type {
  ListWorkItemsInput,
  MeegoStatus,
  WorkspaceContextInfo,
  WorkspaceLink,
  WorkItemDetail,
  WorkItemType,
  WorkItemSummary
} from './protocol'
import { ConnectionPanel, connectionChanging, disposeConnection, loadSpaces, resumeAuthorization } from './panel-connection'
import { HandoffView, beginHandoff, cancelHandoff, handoffBusy, type ItemRef } from './panel-handoff'
import { CreateForm, createBusy, createOpen, resetCreate, toggleCreate } from './panel-create'
import { CommentsPanel, commentBusy, resetComments } from './panel-comments'
import { sameWorkItemId } from './meego/work-item-id'
import { WorkItemResults, ResultSortControl, resetResultNavigation, workItemTone } from './panel-results'
import { EditPanel, editBusy, resetEdit } from './panel-edit'
import { NodesPanel, nodesBusy, resetNodes } from './panel-nodes'
import { WorkspaceCreationPanel, beginWorkspaceCreation, resetWorkspaceCreation, workspaceCreationBusy } from './panel-workspace-create'

// -- atoms --------------------------------------------------------------------

const statusAtom = atom<MeegoStatus | null>(null)
const typesAtom = atom<WorkItemType[] | null>(null)
const typeKeyAtom = atom('meego.typeKey', 'story', { persist: 'plugin' })
const onlyMineAtom = atom('meego.onlyMine', false, { persist: 'plugin' })
const searchAtom = atom('')
const draftSearchAtom = atom('')
const itemsAtom = atom<WorkItemSummary[]>([])
const totalAtom = atom(0)
const pageAtom = atom(1)
const hasMoreAtom = atom(false)
const statusErrorAtom = atom<string | null>(null)
const filterOpenAtom = atom(false)
const statusFilterAtom = atom('')
const statusOptionsAtom = atom<{ options: { key: string; label: string }[]; canCombinePersonal: boolean } | null>(null)
const statusOptionsErrorAtom = atom<string | null>(null)
let statusOptionsRequest = 0
const listLoadingAtom = atom(false)
const listErrorAtom = atom<string | null>(null)
const listMessageAtom = atom<string | null>(null)
type DetailTarget = ItemRef | { url: string; expectedUserKey?: string }
const selectedAtom = atom<DetailTarget | null>(null)
const detailAtom = atom<WorkItemDetail | null>(null)
const detailLoadingAtom = atom(false)
const detailMsgAtom = atom<string | null>(null)
const detailMsgToneAtom = atom<Tone>('danger')
const contextAtom = atom<WorkspaceContextInfo | null>(null)
const contextLoadingAtom = atom(false)
const contextErrorAtom = atom<string | null>(null)

const linkInputOpenAtom = atom(false)
const linkDraftAtom = atom('')
const workspaceMessageAtom = atom<{ text: string; tone: Tone } | null>(null)
const replaceLinkAtom = atom<{ workspaceId: string; link: WorkspaceLink } | null>(null)
const workspaceActionBusyAtom = atom(false)

// -- helpers ------------------------------------------------------------------

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function typeName(types: WorkItemType[], key: string): string {
  return types.find((entry) => entry.key === key)?.name ?? key
}

function typeOptions(types: WorkItemType[], fallbackKey: string): { value: string; label: string }[] {
  if (types.length === 0) return [{ value: fallbackKey, label: fallbackKey }]
  return types.map((entry) => ({ value: entry.key, label: entry.name }))
}

// -- data flow ----------------------------------------------------------------

let listRequest = 0
let detailRequest = 0
let contextRequest = 0
let statusRequest = 0

function isAuthError(error: unknown): boolean {
  // Orca forwards this standard bridge code and the provider's error message.
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'consent_required'
}

async function refreshAfterAuthError(error: unknown): Promise<void> {
  if (isAuthError(error)) await refreshAll(false, true)
}

function clearList(): void {
  resetResultNavigation()
  listRequest += 1
  set(itemsAtom, [])
  set(totalAtom, 0)
  set(pageAtom, 1)
  set(hasMoreAtom, false)
  set(listLoadingAtom, false)
  set(listErrorAtom, null)
  set(listMessageAtom, null)
}

function expectedAccount(status: MeegoStatus | null): { expectedUserKey?: string } {
  return status?.userKey ? { expectedUserKey: status.userKey } : {}
}

function browsingScope(status: MeegoStatus | null) {
  return {
    ...expectedAccount(status),
    ...(status?.configured ? { source: { baseUrl: status.baseUrl, projectKey: status.projectKey } } : {})
  }
}

async function loadPage(status: MeegoStatus | null, { page = 1, force = false, reset = false } = {}): Promise<void> {
  if (!status?.configured) return
  if (page > 1 && (read(listLoadingAtom) || !read(hasMoreAtom))) return
  if (reset) clearList()
  const request = ++listRequest
  set(listLoadingAtom, true)
  set(listErrorAtom, null)
  try {
    const input: ListWorkItemsInput = { ...browsingScope(status), typeKey: read(typeKeyAtom), onlyMine: read(onlyMineAtom), page, force }
    const search = read(searchAtom)
    if (search !== '') input.search = search
    if (read(statusFilterAtom)) input.statusKeys = [read(statusFilterAtom)]
    const output = await plugin.request('meego.listWorkItems', input)
    if (request !== listRequest) return
    const items = page <= 1 ? output.items : [...read(itemsAtom), ...output.items]
    set(itemsAtom, [...new Map(items.map((item) => [String(item.id), item])).values()])
    set(totalAtom, output.total)
    set(pageAtom, output.page)
    set(hasMoreAtom, output.hasMore)
  } catch (error) {
    if (request !== listRequest) return
    set(listErrorAtom, errorMessageOf(error))
    await refreshAfterAuthError(error)
  } finally {
    if (request === listRequest) set(listLoadingAtom, false)
  }
}

async function refreshContext(): Promise<void> {
  const request = ++contextRequest
  const old = read(contextAtom)
  set(contextLoadingAtom, true)
  set(contextErrorAtom, null)
  try {
    const context = await plugin.request('meego.workspaceContext')
    if (request !== contextRequest) return
    if (old?.workspaceId !== context.workspaceId || old?.branch !== context.branch) {
      cancelHandoff()
      set(replaceLinkAtom, null)
      set(workspaceMessageAtom, null)
    }
    set(contextAtom, context)
  } catch (error) {
    if (request === contextRequest) {
      set(contextAtom, null)
      set(contextErrorAtom, errorMessageOf(error))
      cancelHandoff()
      set(replaceLinkAtom, null)
    }
  } finally {
    if (request === contextRequest) set(contextLoadingAtom, false)
  }
}

function clearDetail(): void {
  detailRequest += 1
  set(selectedAtom, null)
  set(detailAtom, null)
  set(detailLoadingAtom, false)
  set(detailMsgAtom, null)
  resetComments()
  resetEdit()
  resetNodes()
  resetWorkspaceCreation()
  cancelHandoff()
  set(replaceLinkAtom, null)
}

function resetScope(): void {
  contextRequest += 1
  set(contextAtom, null)
  set(contextLoadingAtom, false)
  set(contextErrorAtom, null)
  set(searchAtom, '')
  set(draftSearchAtom, '')
  clearList()
  clearDetail()
  set(typesAtom, null)
  statusOptionsRequest += 1
  set(statusOptionsAtom, null)
  set(statusOptionsErrorAtom, null)
  set(statusFilterAtom, '')
  set(filterOpenAtom, false)
  set(linkInputOpenAtom, false)
  set(linkDraftAtom, '')
  resetCreate()
  set(workspaceMessageAtom, null)
}

async function refreshAll(force = false, statusOnly = false): Promise<void> {
  const request = ++statusRequest
  if (!statusOnly) set(statusErrorAtom, null)
  try {
    const status = await plugin.request('meego.status')
    if (request !== statusRequest) return
    const old = read(statusAtom)
    const scopeChanged = old !== null && (
      old.baseUrl !== status.baseUrl || old.projectKey !== status.projectKey || old.userKey !== status.userKey ||
      old.configured !== status.configured || old.connection?.state !== status.connection?.state
    )
    if (scopeChanged) {
      set(statusErrorAtom, null)
      resetScope()
    }
    set(statusAtom, status)
    if (old === null) resumeAuthorization(status.authorization, refreshAll)
    if (statusOnly && !scopeChanged) return
    if (status.connection?.state === 'choose_space') {
      const selected = await loadSpaces(1, old?.connection?.state !== 'choose_space')
      if (selected && request === statusRequest) await refreshAll()
    } else if (status.configured) {
      const { types } = await plugin.request('meego.listTypes', browsingScope(status))
      if (request !== statusRequest) return
      set(typesAtom, types)
      if (types.length === 0) {
        clearList()
      } else {
        const current = read(typeKeyAtom)
        if (!types.some((entry) => entry.key === current)) {
          set(typeKeyAtom, types.some((entry) => entry.key === 'story') ? 'story' : types[0].key)
        }
        await loadPage(status, { force })
      }
    }
  } catch (error) {
    if (request === statusRequest) {
      set(statusErrorAtom, errorMessageOf(error))
      if (!statusOnly && isAuthError(error)) await refreshAll(false, true)
    }
  }
  if (request === statusRequest) await refreshContext()
}

async function openDetail(target: DetailTarget): Promise<void> {
  clearDetail()
  const request = detailRequest
  set(selectedAtom, target)
  set(detailLoadingAtom, true)
  try {
    const { item } = 'url' in target
      ? await plugin.request('meego.openWorkItemLink', target)
      : await plugin.request('meego.getWorkItem', target)
    if (request !== detailRequest) return
    resetComments(item, {
      ...(!('url' in target) && target.source ? { source: target.source } : {}),
      ...(target.expectedUserKey ? { expectedUserKey: target.expectedUserKey } : {})
    })
    set(detailAtom, item)
    resetEdit(item, target.expectedUserKey ?? read(statusAtom)?.userKey)
    resetNodes(item, target.expectedUserKey ?? read(statusAtom)?.userKey)
    if ('url' in target) set(linkDraftAtom, '')
  } catch (error) {
    if (request !== detailRequest) return
    set(detailMsgAtom, errorMessageOf(error))
    set(detailMsgToneAtom, 'danger')
    await refreshAfterAuthError(error)
  } finally {
    if (request === detailRequest) set(detailLoadingAtom, false)
  }
}

async function openUrl(url: string, report: (text: string, tone: Tone) => void): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (error) {
    report(`无法打开浏览器：${errorMessageOf(error)}`, 'danger')
  }
}

function reportDetail(text: string, tone: Tone): void {
  set(detailMsgAtom, text)
  set(detailMsgToneAtom, tone)
}

function reportWorkspace(text: string, tone: Tone): void {
  set(workspaceMessageAtom, { text, tone })
}

// Runs once before the first render; what it pushes to `subscriptions` ends with the panel.
// The initial load runs detached (setup cannot await), but the promise is exported so tests
// can wait for the panel to be fully populated.
export let initialLoad: Promise<void> = Promise.resolve()

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('meego.linkChanged', () => void refreshContext()))
  ctx.subscriptions.push(plugin.on('meego.connectionChanged', () => void refreshAll()))
  ctx.subscriptions.push(on('workspace.changed', () => void refreshContext()))
  ctx.subscriptions.push(on('agent.status.changed', () => void refreshContext()))
  initialLoad = refreshAll()
  ctx.subscriptions.push({ dispose: () => {
    disposeConnection()
    statusOptionsRequest += 1
    statusRequest += 1
    listRequest += 1
    detailRequest += 1
    contextRequest += 1
  } })
}

// -- views --------------------------------------------------------------------

function WorkspaceContextNotice() {
  const context = read(contextAtom)
  const loading = read(contextLoadingAtom)
  const error = read(contextErrorAtom)
  if (context?.workspaceId != null) return null
  const reason = error ? `读取 Orca 工作区失败：${error}`
    : context?.workspaceResolution === 'ambiguous'
      ? '当前宿主无法区分同名同分支工作区。请更新 Orca 后重新识别工作区。'
      : context?.workspaceResolution === 'truncated'
        ? 'Orca 返回的工作区列表不完整，暂时无法核对当前工作区。请等待列表加载后重新识别。'
        : context?.displayName
          ? 'Orca 未提供可核对的当前工作区标识。请重新选择工作区；旧版宿主请更新后重新识别。'
          : '请先在 Orca 中选择工作区，再重新识别，即可关联工作项或交接给 Agent。'
  return (
    <Callout tone={error ? 'danger' : 'warning'} title="无法识别当前工作区">
      <Stack gap="xs">
        <Text size="sm">{reason}</Text>
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" disabled={loading || connectionChanging()} onPress={() => refreshContext()}>重新识别工作区</Button>
          {loading ? <Spinner label="正在识别工作区…" /> : null}
        </Row>
      </Stack>
    </Callout>
  )
}

function LinkCard() {
  const context = read(contextAtom)
  const account = expectedAccount(read(statusAtom))
  const message = read(workspaceMessageAtom)
  const busy = read(workspaceActionBusyAtom) || read(contextLoadingAtom) || handoffBusy() || connectionChanging()
  const showingWorkspaceActions = read(selectedAtom) === null && !createOpen()
  if (context === null || context.workspaceId === null) return <WorkspaceContextNotice />
  const { link, workspaceId } = context
  return (
    <Box gap="xs" padding="sm" border radius="md" background="muted">
      <Heading level={3}>当前工作区</Heading>
      <Text size="xs" muted truncate>{`${context.displayName ?? '工作区'} · ${context.branch ?? '无分支'}`}</Text>
      {link === null ? (
        <Text size="sm">未关联工作项。打开一个工作项后即可关联。</Text>
      ) : (
        <Stack gap="xs">
          <Text size="sm" weight="semibold" truncate>{`#${link.workItemId} ${link.name}`}</Text>
          <Text size="xs" muted>{[link.spaceName ?? link.source?.projectKey, link.status].filter(Boolean).join(' · ')}</Text>
          {context.branchChanged ? (
            <Callout tone="warning" title="分支已切换">
              <Text size="sm">{`关联时使用分支 ${link.branch ?? '—'}。`}</Text>
            </Callout>
          ) : null}
          {showingWorkspaceActions ? (
            <Row gap="xs" wrap>
              <Button size="sm" variant="solid" tone="accent" icon="agent" disabled={busy} onPress={() => beginHandoff({
                item: linkRef(link), name: link.name, description: '', origin: 'workspace', expectedLinkedAt: link.linkedAt, ...account
              }, context)}>交接关联项</Button>
              <IconButton size="sm" icon="file-text" label="查看关联工作项" disabled={busy}
                onPress={() => openDetail({ ...(link.source || !link.url ? linkRef(link) : { url: link.url }), ...account })} />
              <IconButton size="sm" icon="open-external" label="在浏览器打开" disabled={!link.url} onPress={() => openUrl(link.url, reportWorkspace)} />
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => unlinkCurrent(workspaceId, link.linkedAt)}>解除关联</Button>
            </Row>
          ) : null}
        </Stack>
      )}
      <HandoffView origin="workspace" context={context} defaultAgent={read(statusAtom)?.defaultAgent} report={reportWorkspace} onError={refreshAfterAuthError} />
      {message !== null ? <Text size="sm" tone={message.tone}>{message.text}</Text> : null}
    </Box>
  )
}

function linkRef(link: WorkspaceLink): ItemRef {
  return { id: link.workItemId, typeKey: link.typeKey, ...(link.source ? { source: link.source } : {}) }
}

function detailRef(detail: WorkItemDetail): ItemRef {
  return { id: detail.id, typeKey: detail.typeKey, ...(detail.source ? { source: detail.source } : {}) }
}

function browsingRef(item: WorkItemSummary, status: MeegoStatus | null): ItemRef {
  return { id: item.id, typeKey: item.typeKey, ...browsingScope(status) }
}

async function unlinkCurrent(workspaceId: string, expectedLinkedAt: number): Promise<void> {
  if (connectionChanging() || read(workspaceActionBusyAtom) || read(contextAtom)?.workspaceId !== workspaceId) return
  set(workspaceActionBusyAtom, true)
  try {
    await plugin.request('meego.unlinkWorkspace', { workspaceId, expectedLinkedAt })
    await refreshContext()
  } catch (error) {
    if (read(contextAtom)?.workspaceId === workspaceId) reportWorkspace(errorMessageOf(error), 'danger')
  } finally {
    set(workspaceActionBusyAtom, false)
  }
}

async function loadStatusOptions(status: MeegoStatus | null): Promise<void> {
  const request = ++statusOptionsRequest
  set(statusOptionsErrorAtom, null)
  try {
    const result = await plugin.request('meego.statusOptions', { typeKey: read(typeKeyAtom), ...browsingScope(status) })
    if (request === statusOptionsRequest) set(statusOptionsAtom, result)
  } catch (error) {
    if (request === statusOptionsRequest) set(statusOptionsErrorAtom, errorMessageOf(error))
    await refreshAfterAuthError(error)
  }
}

function submitSearch(value: string, status: MeegoStatus | null): Promise<void> {
  set(draftSearchAtom, value)
  set(searchAtom, value.trim())
  return loadPage(status, { force: true, reset: true })
}

function submitWorkItemLink(value: string, status: MeegoStatus | null): Promise<void> | undefined {
  const url = value.trim()
  if (url !== '') return openDetail({ url, ...expectedAccount(status) })
}

function WorkItemLinkInput({ disabled, status }: { disabled: boolean; status: MeegoStatus | null }) {
  const link = read(linkDraftAtom)
  return (
    <Stack gap="xs">
      <Input label="工作项链接" placeholder="粘贴飞书项目工作项链接" value={link} maxLength={2048} disabled={disabled}
        onChange={(value) => set(linkDraftAtom, value)} onSubmit={(value) => submitWorkItemLink(value, status)} />
      <Row gap="xs" justify="end">
        <Button size="sm" variant="ghost" onPress={() => set(linkInputOpenAtom, false)}>收起</Button>
        <Button size="sm" disabled={disabled || !link.trim()} onPress={() => submitWorkItemLink(link, status)}>打开工作项</Button>
      </Row>
    </Stack>
  )
}

function ListView() {
  const status = read(statusAtom)
  const items = read(itemsAtom)
  const total = read(totalAtom)
  const loading = read(listLoadingAtom)
  const error = read(listErrorAtom)
  const message = read(listMessageAtom)
  const availableTypes = read(typesAtom)
  const types = availableTypes ?? []
  const typeKey = read(typeKeyAtom)
  const onlyMine = read(onlyMineAtom)
  const draft = read(draftSearchAtom)
  const search = read(searchAtom)
  const addingWorkItem = createOpen()
  const linkOpen = read(linkInputOpenAtom)
  const disabled = connectionChanging() || createBusy() || editBusy() || nodesBusy() || workspaceCreationBusy()
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>工作项</Heading>
        <Toolbar label="工作项操作" gap="xs">
          <IconButton size="sm" icon="filter" label="筛选状态" disabled={disabled} onPress={async () => {
            set(filterOpenAtom, !read(filterOpenAtom))
            if (read(filterOpenAtom) && read(statusOptionsAtom) === null) await loadStatusOptions(status)
          }} />
          <IconButton size="sm" icon="link" label="粘贴工作项链接" tooltip="粘贴工作项链接" disabled={disabled} onPress={() => set(linkInputOpenAtom, !linkOpen)} />
          <IconButton size="sm" icon="add" label="新建工作项" tooltip="新建工作项" disabled={disabled || types.length === 0} onPress={() => toggleCreate(typeKey, browsingScope(status), refreshAfterAuthError)} />
          <IconButton size="sm" icon="refresh" label="刷新" tooltip="刷新工作项" disabled={disabled || loading} onPress={() => refreshAll(true)} />
        </Toolbar>
      </Row>
      {linkOpen ? <WorkItemLinkInput disabled={disabled} status={status} /> : null}
      {addingWorkItem ? <CreateForm types={types} onError={refreshAfterAuthError} onCreated={async (item) => {
        await Promise.all([
          item ? openDetail(browsingRef(item, status)) : Promise.resolve(),
          loadPage(status, { force: true })
        ])
        set(listMessageAtom, item || read(listErrorAtom) !== null ? '工作项已创建' : '工作项已创建，已刷新列表。')
      }} /> : null}
      {availableTypes === null && read(statusErrorAtom) === null ? <Spinner label="正在读取工作项类型…" /> : null}
      {availableTypes?.length === 0 ? <Text muted size="sm">当前空间没有可浏览的工作项类型。</Text> : null}
      <Stack gap="sm">
        <Row gap="sm" align="center" justify="between" wrap>
          <Select label="类型" labelHidden value={typeKey} options={typeOptions(types, typeKey)} disabled={disabled || types.length === 0}
            onChange={async (value) => {
            set(typeKeyAtom, value)
            set(statusFilterAtom, '')
            set(statusOptionsAtom, null)
            statusOptionsRequest += 1
            await Promise.all([
              loadPage(status, { force: true, reset: true }),
              read(filterOpenAtom) ? loadStatusOptions(status) : Promise.resolve()
            ])
          }} />
          <Switch label={status?.connection ? '分配给我' : '与我相关'} checked={onlyMine} disabled={disabled || types.length === 0 || Boolean(read(statusFilterAtom) && read(statusOptionsAtom)?.canCombinePersonal === false)}
            onChange={(value) => { set(onlyMineAtom, value); return loadPage(status, { force: true, reset: true }) }} />
        </Row>
        <Row gap="xs" align="center">
          <Box grow shrink>
            <Input
              label="搜索"
              labelHidden
              type="search"
              placeholder="搜索标题或编号，按回车"
              value={draft}
              maxLength={100}
              disabled={disabled || types.length === 0}
              onChange={(value) => set(draftSearchAtom, value)}
              onSubmit={(value) => submitSearch(value, status)}
            />
          </Box>
          {search || draft ? <IconButton size="sm" icon="close" label="清除工作项搜索" disabled={disabled} onPress={() => submitSearch('', status)} /> : null}
        </Row>
      </Stack>
      {message !== null ? <Text size="sm" tone="success">{message}</Text> : null}
      {read(filterOpenAtom) ? (
        <Box padding="sm" border radius="md" gap="xs" background="muted">
          <Select label="状态" value={read(statusFilterAtom)} disabled={disabled || read(statusOptionsAtom) === null || Boolean(onlyMine && read(statusOptionsAtom)?.canCombinePersonal === false)}
            options={[{ value: '', label: '全部状态' }, ...(read(statusOptionsAtom)?.options ?? []).map(({ key, label }) => ({ value: key, label }))]}
            onChange={(value) => { set(statusFilterAtom, value); return loadPage(status, { force: true, reset: true }) }} />
          <ResultSortControl disabled={disabled || loading} />
          {read(statusOptionsAtom) === null && read(statusOptionsErrorAtom) === null ? <Spinner label="正在读取状态…" /> : null}
          {read(statusOptionsErrorAtom) ? <Stack gap="xs">
            <Text size="xs" tone="danger">{read(statusOptionsErrorAtom)}</Text>
            <Button size="sm" variant="ghost" disabled={disabled} onPress={() => loadStatusOptions(status)}>重试读取状态</Button>
          </Stack> : null}
          {read(statusOptionsAtom)?.canCombinePersonal === false && onlyMine ? <Text size="xs" muted>关闭「与我相关」后可按状态筛选。</Text> : null}
          <Text size="xs" muted>终止项请在飞书项目网页筛选。</Text>
          {read(statusFilterAtom) ? <Button size="sm" variant="ghost" disabled={disabled} onPress={() => { set(statusFilterAtom, ''); return loadPage(status, { force: true, reset: true }) }}>清除状态筛选</Button> : null}
        </Box>
      ) : null}
      {!read(filterOpenAtom) && read(statusFilterAtom) ? <Row gap="xs">
        <Badge tone="neutral">{read(statusOptionsAtom)?.options.find((option) => option.key === read(statusFilterAtom))?.label ?? read(statusFilterAtom)}</Badge>
        <IconButton size="sm" icon="close" label="清除状态筛选" disabled={disabled} onPress={() => { set(statusFilterAtom, ''); return loadPage(status, { force: true, reset: true }) }} />
      </Row> : null}
      {error !== null ? (
        <Callout tone="danger" title="加载失败">
          <Stack gap="sm">
            <Text size="sm">{error}</Text>
            <Row gap="xs">
              <Button size="sm" variant="outline" onPress={() => loadPage(status, { force: true })}>重试</Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      {types.length > 0 ? <WorkItemResults
        items={items} total={total} loading={loading} hasMore={read(hasMoreAtom)} disabled={disabled}
        emptyText={search === '' ? '这里还没有工作项' : `没有匹配「${search}」的工作项`}
        onOpen={(item) => openDetail(browsingRef(item, status))}
        onMore={() => loadPage(status, { page: read(pageAtom) + 1 })}
      /> : null}
      {types.length > 0 ? <Text muted size="xs">{`共 ${total} 项${search === '' ? '' : ` · 搜索「${search}」`}`}</Text> : null}
    </Stack>
  )
}

function DetailView() {
  const selected = read(selectedAtom)
  const detail = read(detailAtom)
  const loading = read(detailLoadingAtom)
  const message = read(detailMsgAtom)
  const messageTone = read(detailMsgToneAtom)
  if (selected === null) return null
  return (
    <Stack gap="md">
      <Row gap="sm" align="start">
        <IconButton size="sm" icon="collapse" label="返回列表" tooltip="返回列表" onPress={() => clearDetail()} />
        <Box grow shrink gap="xs">
          {detail !== null ? <Text size="xs" muted>{`#${detail.id}`}</Text> : 'url' in selected ? null : <Text size="xs" muted>{`#${selected.id}`}</Text>}
          <Heading level={2}>{detail?.name ?? ('url' in selected ? '打开工作项' : '工作项详情')}</Heading>
        </Box>
      </Row>
      {loading ? <Spinner label="加载详情…" /> : null}
      {message !== null ? (
        <Callout tone={messageTone} title={messageTone === 'danger' ? '出错了' : '完成'}>
          <Stack gap="xs">
            <Text size="sm">{message}</Text>
            {messageTone === 'danger' && detail === null ? <Button size="sm" variant="ghost" onPress={() => openDetail(selected)}>重试详情</Button> : null}
          </Stack>
        </Callout>
      ) : null}
      {detail !== null ? <DetailBody detail={detail} /> : null}
    </Stack>
  )
}

function DetailBody(props: { detail: WorkItemDetail }) {
  const detail = props.detail
  const account = expectedAccount(read(statusAtom))
  const types = read(typesAtom) ?? []
  const context = read(contextAtom)
  const actionBusy = read(workspaceActionBusyAtom) || read(contextLoadingAtom) || handoffBusy() || editBusy() || nodesBusy() || workspaceCreationBusy() || connectionChanging()
  const replacement = read(replaceLinkAtom)
  const link = context?.link
  const source = detail.source
  const linked = link && sameWorkItemId(link.workItemId, detail.id) && link.typeKey === detail.typeKey && (
    (detail.url !== '' && link.url === detail.url) ||
    (source && link.source?.baseUrl === source.baseUrl && link.source.projectKey === source.projectKey)
  )
  return (
    <Stack gap="md">
      <Row gap="xs" wrap>
        <Badge tone="neutral">{typeName(types, detail.typeKey)}</Badge>
        <Badge tone={workItemTone(detail.statusState)}>{detail.status || '无状态'}</Badge>
        {detail.updatedAt !== null ? <RelativeTime at={detail.updatedAt} muted /> : null}
      </Row>
      <Row gap="xs" wrap>
        <Button size="sm" variant="solid" tone="accent" icon="agent" disabled={actionBusy || context?.workspaceId == null}
          onPress={() => context && beginHandoff({
            item: detailRef(detail), name: detail.name, description: detail.description, origin: 'detail', ...account
          }, context)}>交给 Agent</Button>
        <Button size="sm" variant="outline" disabled={actionBusy || context?.workspaceId == null || Boolean(linked)}
          onPress={() => prepareLink(detail, context, account.expectedUserKey)}>{linked ? '已关联' : '关联工作区'}</Button>
        <IconButton size="sm" icon="open-external" label="在浏览器打开" disabled={!detail.url} onPress={() => openUrl(detail.url, reportDetail)} />
      </Row>
      <Row justify="start">
        <Button size="sm" variant="ghost" icon="branch" disabled={actionBusy}
          onPress={() => beginWorkspaceCreation({ ...detailRef(detail), ...account })}>新建关联工作区</Button>
      </Row>
      <WorkspaceCreationPanel onError={refreshAfterAuthError} onCreated={() => refreshContext()} />
      <WorkspaceContextNotice />
      {replacement !== null && replacement.workspaceId === context?.workspaceId ? (
        <Callout tone="warning" title="替换工作区关联">
          <Stack gap="xs">
            <Text size="sm">{`将 #${replacement.link.workItemId} ${replacement.link.name} 换为 #${detail.id} ${detail.name}？`}</Text>
            <Row gap="xs" wrap>
              <Button size="sm" disabled={actionBusy} onPress={() => linkCurrent(detail, replacement.workspaceId, replacement.link.linkedAt, account.expectedUserKey)}>确认替换</Button>
              <Button size="sm" variant="ghost" disabled={actionBusy} onPress={() => set(replaceLinkAtom, null)}>取消替换</Button>
            </Row>
          </Stack>
        </Callout>
      ) : null}
      <HandoffView origin="detail" context={context} defaultAgent={read(statusAtom)?.defaultAgent} report={reportDetail} onError={refreshAfterAuthError} />
      <KeyValue
        label="字段"
        items={[
          ...(source ? [{ label: '来源空间', value: detail.spaceName ?? source.projectKey }] : []),
          { label: '负责人', value: detail.ownerNames.length > 0 ? detail.ownerNames.join('、') : '未设置' },
          ...detail.fields.map((field) => ({ label: field.label, value: field.value }))
        ]}
      />
      {detail.description !== '' ? (
        <Stack gap="xs">
          <Heading level={3}>描述</Heading>
          <Markdown content={detail.description.slice(0, 16_000)} />
          {detail.description.length > 16_000 ? <Text size="xs" muted>描述较长，完整内容请在飞书项目中查看。</Text> : null}
        </Stack>
      ) : null}
      <EditPanel currentUserKey={account.expectedUserKey} onError={refreshAfterAuthError} onSaved={async (item, outcome) => {
        if (detail !== read(detailAtom)) return
        set(detailAtom, item)
        resetNodes(item, account.expectedUserKey)
        reportDetail(outcome === 'adopted' ? '已采用最新详情' : '修改已确认', 'success')
        await refreshContext()
        await loadPage(read(statusAtom), { force: true })
      }} />
      {detail.workflowMode !== 'state' ? <NodesPanel currentUserKey={account.expectedUserKey} onError={refreshAfterAuthError} onSaved={async (item, outcome) => {
        if (detail !== read(detailAtom)) return
        set(detailAtom, item)
        resetEdit(item, account.expectedUserKey)
        reportDetail(outcome === 'adopted' ? '已采用最新流程' : '节点操作已确认', 'success')
        await refreshContext()
        await loadPage(read(statusAtom), { force: true })
      }} /> : null}
      <CommentsPanel onError={refreshAfterAuthError} />
    </Stack>
  )
}

function prepareLink(detail: WorkItemDetail, context: WorkspaceContextInfo | null, expectedUserKey?: string): Promise<void> | undefined {
  if (context?.workspaceId == null || context.workspaceId !== read(contextAtom)?.workspaceId) return
  if (context.link) {
    set(replaceLinkAtom, { workspaceId: context.workspaceId, link: context.link })
  } else {
    return linkCurrent(detail, context.workspaceId, null, expectedUserKey)
  }
}

async function linkCurrent(detail: WorkItemDetail, workspaceId: string, expectedLinkedAt: number | null, expectedUserKey?: string): Promise<void> {
  if (connectionChanging() || read(workspaceActionBusyAtom) || read(contextAtom)?.workspaceId !== workspaceId || detail !== read(detailAtom)) return
  if ((read(contextAtom)?.link?.linkedAt ?? null) !== expectedLinkedAt) {
    set(replaceLinkAtom, null)
    reportDetail('关联已变化，请查看当前工作区后重试。', 'warning')
    return
  }
  set(workspaceActionBusyAtom, true)
  try {
    await plugin.request('meego.linkWorkspace', {
      workItemId: detail.id,
      typeKey: detail.typeKey,
      name: detail.name,
      status: detail.status,
      ...(detail.url ? { url: detail.url } : {}),
      ...(detail.source ? { source: detail.source } : {}),
      ...(expectedUserKey ? { expectedUserKey } : {}),
      expectedLinkedAt,
      workspaceId
    })
    await refreshContext()
    set(replaceLinkAtom, null)
    if (detail === read(detailAtom) && workspaceId === read(contextAtom)?.workspaceId) reportDetail('已关联到当前工作区', 'success')
  } catch (error) {
    if (detail === read(detailAtom)) reportDetail(errorMessageOf(error), 'danger')
    await refreshAfterAuthError(error)
  } finally {
    set(workspaceActionBusyAtom, false)
  }
}

export default function Panel() {
  const status = read(statusAtom)
  const error = read(statusErrorAtom)
  const selected = read(selectedAtom)
  const writeBusy = read(workspaceActionBusyAtom) || handoffBusy() || createBusy() || commentBusy() || editBusy() || nodesBusy() || workspaceCreationBusy()
  const choosingSpace = status?.connection?.state === 'choose_space'
  const openingLink = read(linkInputOpenAtom)
  return (
    <Stack gap="md">
      {status === null && error === null ? <Skeleton shape="text" lines={3} label="正在读取飞书项目连接" /> : null}
      {status !== null ? <ConnectionPanel status={status} refresh={refreshAll} disabled={writeBusy} /> : null}
      {error !== null ? (
        <Callout tone="danger" title="加载飞书项目失败">
          <Stack gap="xs">
            <Text size="sm">{error}</Text>
            <Button size="sm" variant="outline" onPress={() => refreshAll(true)}>重新加载</Button>
          </Stack>
        </Callout>
      ) : null}
      {status?.configured && selected === null ? <LinkCard /> : null}
      {status?.configured && selected === null ? <ListView /> : null}
      {choosingSpace && selected === null && openingLink ? <WorkItemLinkInput disabled={connectionChanging()} status={status} /> : null}
      {choosingSpace && selected === null && !openingLink ? (
        <Row justify="start"><Button size="sm" variant="ghost" icon="link" disabled={connectionChanging()}
          onPress={() => set(linkInputOpenAtom, true)}>粘贴工作项链接</Button></Row>
      ) : null}
      {(status?.configured || choosingSpace) && selected !== null ? <DetailView /> : null}
    </Stack>
  )
}
