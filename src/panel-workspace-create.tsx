import { atom, Box, Button, Callout, Heading, Input, Row, Select, Spinner, Stack, Text, plugin, read, set } from 'orca'
import type { CreatedWorkspaceReceipt, WorkItemReference, WorkspaceCreationPlan, WorkspaceCreationSource } from './protocol'
import { connectionChanging } from './panel-connection'

type Target = { ref: WorkItemReference }
type ErrorHandler = (error: unknown) => Promise<void>
type CreatedHandler = (receipt: CreatedWorkspaceReceipt) => void | Promise<void>

const targetAtom = atom<Target | null>(null)
const planAtom = atom<WorkspaceCreationPlan | null>(null)
const loadingAtom = atom(false)
const pendingAtom = atom(0)
const nameAtom = atom('')
const sourceAtom = atom('')
const recoveryAtom = atom('')
const errorAtom = atom<string | null>(null)
let generation = 0

export function workspaceCreationBusy(): boolean { return read(pendingAtom) > 0 }

export function resetWorkspaceCreation(): void {
  generation += 1
  set(targetAtom, null)
  set(planAtom, null)
  set(loadingAtom, false)
  set(errorAtom, null)
  set(sourceAtom, '')
  set(recoveryAtom, '')
}

/** The target is a copied, scoped reference; no later focused-workspace lookup is used. */
export function beginWorkspaceCreation(ref: WorkItemReference): void {
  if (workspaceCreationBusy() || connectionChanging()) return
  resetWorkspaceCreation()
  const target = { ref: { ...ref, ...(ref.source ? { source: { ...ref.source } } : {}) } }
  set(targetAtom, target)
  void loadPlan(target)
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function sourceLabel(entry: WorkspaceCreationSource): string {
  return `${entry.project || '未命名项目'} · ${entry.name} · ${entry.branch} · ${entry.hostId ?? '本机'} · ${entry.path}`
}

function applyPlan(target: Target, plan: WorkspaceCreationPlan): void {
  if (target !== read(targetAtom)) return
  set(planAtom, plan)
  set(nameAtom, plan.name)
  set(sourceAtom, plan.sources.length === 1 ? plan.sources[0].id : '')
  set(recoveryAtom, '')
}

async function loadPlan(target: Target, onError?: ErrorHandler): Promise<void> {
  if (target !== read(targetAtom)) return
  const request = ++generation
  set(loadingAtom, true)
  set(errorAtom, null)
  try {
    const plan = await plugin.request('meego.workspaceCreationPlan', target.ref, { timeoutMs: 90_000 })
    if (request === generation) applyPlan(target, plan)
  } catch (error) {
    if (target === read(targetAtom) && request === generation) {
      set(errorAtom, messageOf(error))
      await onError?.(error)
    }
  } finally {
    if (target === read(targetAtom) && request === generation) set(loadingAtom, false)
  }
}

type Action = 'create' | 'retry' | 'recover' | 'restart' | 'open'

async function act(target: Target, plan: WorkspaceCreationPlan, action: Action, onError: ErrorHandler, onCreated?: CreatedHandler): Promise<void> {
  if (target !== read(targetAtom) || plan !== read(planAtom) || workspaceCreationBusy() || connectionChanging()) return
  const base = { ref: target.ref, planId: plan.planId }
  const name = read(nameAtom).trim()
  const sourceWorkspaceId = read(sourceAtom)
  const workspaceId = read(recoveryAtom)
  set(pendingAtom, read(pendingAtom) + 1)
  set(errorAtom, null)
  try {
    if (action === 'open') {
      await plugin.request('meego.openCreatedWorkspace', base, { timeoutMs: 90_000 })
      if (target === read(targetAtom) && plan.receipt) await onCreated?.(plan.receipt)
      return
    }
    const result = action === 'create'
      ? await plugin.request('meego.createWorkspace', { ...base, sourceWorkspaceId, name }, { timeoutMs: 120_000 })
      : action === 'retry' ? await plugin.request('meego.retryCreatedWorkspaceLink', base, { timeoutMs: 90_000 })
        : action === 'recover' ? await plugin.request('meego.recoverCreatedWorkspace', { ...base, workspaceId }, { timeoutMs: 90_000 })
          : await plugin.request('meego.confirmWorkspaceNotCreated', base, { timeoutMs: 90_000 })
    if (target !== read(targetAtom)) return
    applyPlan(target, result)
    if (result.state === 'linked' && result.receipt) await onCreated?.(result.receipt)
  } catch (error) {
    if (target !== read(targetAtom)) return
    // Once submitted, a lost panel reply must hide the create button even if a
    // subsequent journal read also fails. Refresh is read-only and never resubmits.
    if (action === 'create') {
      set(planAtom, { ...plan, state: 'uncertain', sources: [], recoveryWorkspaces: [], message: '创建请求已提交，暂时无法确认结果。请刷新创建记录并在 Orca 中核对，避免重复创建。' })
    }
    set(errorAtom, messageOf(error))
    await onError(error)
  } finally {
    set(pendingAtom, Math.max(0, read(pendingAtom) - 1))
  }
}

export function WorkspaceCreationPanel({ onError, onCreated }: { onError: ErrorHandler; onCreated?: CreatedHandler }) {
  const target = read(targetAtom)
  if (!target) return null
  const plan = read(planAtom)
  const loading = read(loadingAtom)
  const busy = workspaceCreationBusy() || connectionChanging() || loading
  const sourceId = read(sourceAtom)
  const source = plan?.sources.find((entry) => entry.id === sourceId)
  const recoveryId = read(recoveryAtom)
  const error = read(errorAtom)
  const name = read(nameAtom)
  const nameValid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name.trim())
  return (
    <Box padding="sm" background="muted" border radius="md">
      <Stack gap="sm">
        <Row justify="between" align="center" gap="xs" wrap>
          <Heading level={3}>从工作项创建工作区</Heading>
          <Button size="sm" variant="ghost" disabled={busy} onPress={resetWorkspaceCreation}>收起</Button>
        </Row>
        <Text size="xs" muted>{`#${target.ref.id} · ${target.ref.typeKey}`}</Text>
        {loading ? <Spinner label="读取创建记录和 Git 工作区" /> : null}
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {plan?.message ? <Callout tone={plan.state === 'ready' ? 'neutral' : 'warning'}>{plan.message}</Callout> : null}
        {plan?.state === 'ready' ? <Stack gap="sm">
          <Text size="sm" muted>选择来源仓库、主机和分支。Orca 会在后台创建 Git 工作区，再关联此工作项。</Text>
          <Select label="来源 Git 工作区" placeholder="选择仓库和分支" value={sourceId} disabled={busy}
            options={plan.sources.map((entry) => ({ value: entry.id, label: sourceLabel(entry) }))}
            onChange={(value) => set(sourceAtom, value)} />
          {source ? <Text size="xs" muted>{source.path}</Text> : null}
          <Input label="工作区名称" value={name} maxLength={80} invalid={!nameValid} disabled={busy} onChange={(value) => set(nameAtom, value)} />
          <Text size="xs" muted>名称需为 1–80 位英文字母、数字、短横线或下划线，并以字母或数字开头。</Text>
          {!nameValid ? <Callout tone="danger">请使用英文名称，例如 meego-123；名称不支持中文、空格或其他符号。</Callout> : null}
          <Row gap="xs" wrap>
            <Button size="sm" variant="solid" tone="accent" disabled={busy || !source || !nameValid}
              onPress={() => act(target, plan, 'create', onError, onCreated)}>创建并关联</Button>
            <Button size="sm" variant="ghost" disabled={busy} onPress={() => loadPlan(target, onError)}>刷新创建计划</Button>
          </Row>
        </Stack> : null}
        {plan?.state === 'uncertain' ? <Stack gap="sm">
          <Text size="sm">先打开 Orca 工作区列表核对创建是否完成。选择已创建的工作区后，只恢复关联。</Text>
          <Select label="已创建的工作区" value={recoveryId} placeholder="核对后选择工作区" disabled={busy}
            options={plan.recoveryWorkspaces.map((entry) => ({ value: entry.id, label: sourceLabel(entry) }))}
            onChange={(value) => set(recoveryAtom, value)} />
          <Row gap="xs" wrap>
            <Button size="sm" tone="accent" disabled={busy || !recoveryId} onPress={() => act(target, plan, 'recover', onError, onCreated)}>关联所选工作区</Button>
            <Button size="sm" variant="ghost" disabled={busy} onPress={() => loadPlan(target, onError)}>刷新创建记录</Button>
          </Row>
          <Text size="xs" muted>确认 Orca 中没有此次创建的工作区，且创建已停止后，才能重新计划。</Text>
          <Button size="sm" variant="ghost" disabled={busy} onPress={() => act(target, plan, 'restart', onError)}>已核对，未创建</Button>
        </Stack> : null}
        {plan?.receipt ? <Stack gap="xs">
          <Text size="sm">{`${plan.receipt.name} · ${plan.receipt.branch === undefined ? '分支待核对' : plan.receipt.branch ?? '无分支'}`}</Text>
          <Text size="xs" muted>{plan.receipt.path ?? plan.receipt.workspaceId}</Text>
          {plan.state === 'created' ? <Button size="sm" tone="accent" disabled={busy} onPress={() => act(target, plan, 'retry', onError, onCreated)}>重试关联已有工作区</Button> : null}
          {plan.state === 'linked' ? <Stack gap="xs">
            <Callout tone="success">工作区已创建并关联。打开后，可将工作项交给 Agent。</Callout>
            <Button size="sm" tone="accent" variant="solid" disabled={busy} onPress={() => act(target, plan, 'open', onError, onCreated)}>打开工作区</Button>
          </Stack> : null}
        </Stack> : null}
        {!loading && !plan ? <Button size="sm" disabled={busy} onPress={() => loadPlan(target, onError)}>重新读取创建记录</Button> : null}
      </Stack>
    </Box>
  )
}
