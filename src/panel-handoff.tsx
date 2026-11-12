import { atom, Badge, Box, Button, Callout, Heading, Row, Select, Spinner, Stack, Text, plugin, read, set, type Tone } from 'orca'
import type { WorkItemId, WorkItemSource, WorkspaceContextInfo } from './protocol'
import { connectionChanging } from './panel-connection'

export type ItemRef = { id: WorkItemId; typeKey: string; source?: WorkItemSource; expectedUserKey?: string }

interface HandoffTarget {
  item: ItemRef
  name: string
  description: string
  expectedUserKey?: string
  expectedLinkedAt?: number
  origin: 'detail' | 'workspace'
}

type Handoff = HandoffTarget & { workspaceId: string }

type Report = (text: string, tone: Tone) => void

const handoffAtom = atom<Handoff | null>(null)
const terminalAtom = atom('')
const choicesAtom = atom<{ id: string; label: string }[] | null>(null)
const agentAtom = atom('')
const lastAgentAtom = atom('')
const choicesLoadingAtom = atom(false)
const choicesErrorAtom = atom<string | null>(null)
const sendBusyAtom = atom(false)
let choicesRequest = 0
const HANDOFF_TIMEOUT_MS = 90_000
const NEW_AGENT = 'meego:new-agent'

export function handoffBusy(): boolean {
  return read(sendBusyAtom)
}

export function cancelHandoff(origin?: Handoff['origin']): void {
  if (origin && read(handoffAtom)?.origin !== origin) return
  choicesRequest += 1
  set(handoffAtom, null)
  set(choicesAtom, null)
  set(agentAtom, '')
  set(choicesLoadingAtom, false)
  set(choicesErrorAtom, null)
}

function terminalAgents(context: WorkspaceContextInfo) {
  if (context.isActive === false) return []
  return context.agents.filter((agent) => agent.terminalId)
}

export function beginHandoff(target: HandoffTarget, context: WorkspaceContextInfo): void {
  if (context?.workspaceId == null || handoffBusy() || connectionChanging()) return
  cancelHandoff()
  const agents = terminalAgents(context)
  set(terminalAtom, agents.length === 1 ? agents[0].terminalId ?? '' : agents.length === 0 ? NEW_AGENT : '')
  const handoff = { ...target, item: { ...target.item, ...(target.item.source ? { source: { ...target.item.source } } : {}) }, workspaceId: context.workspaceId }
  set(handoffAtom, handoff)
  if (agents.length === 0) void loadChoices(handoff)
}

async function loadChoices(handoff: Handoff, onError?: (error: unknown) => Promise<void>): Promise<void> {
  if (handoff !== read(handoffAtom)) return
  const request = ++choicesRequest
  set(choicesLoadingAtom, true)
  set(choicesErrorAtom, null)
  try {
    const result = await plugin.request('meego.agentChoices', { workspaceId: handoff.workspaceId })
    if (handoff !== read(handoffAtom) || request !== choicesRequest) return
    const previous = read(agentAtom)
    const initial = read(choicesAtom) === null
    const preferred = result.agents.some((entry) => entry.id === read(lastAgentAtom)) ? read(lastAgentAtom) : result.defaultAgent
    set(agentAtom, result.agents.some((entry) => entry.id === previous) ? previous
      : initial && result.agents.some((entry) => entry.id === preferred) ? preferred ?? '' : '')
    set(choicesAtom, result.agents)
  } catch (error) {
    if (handoff !== read(handoffAtom) || request !== choicesRequest) return
    set(choicesErrorAtom, error instanceof Error ? error.message : String(error))
    await onError?.(error)
  } finally {
    if (handoff === read(handoffAtom) && request === choicesRequest) set(choicesLoadingAtom, false)
  }
}

export function HandoffView({ origin, context, report, onError, disabled = false }: {
  origin: Handoff['origin']
  context: WorkspaceContextInfo | null
  report: Report
  onError: (error: unknown) => Promise<void>
  defaultAgent?: string
  disabled?: boolean
}) {
  const handoff = read(handoffAtom)
  if (handoff?.origin !== origin || handoff.workspaceId !== context?.workspaceId) return null
  const agents = terminalAgents(context)
  const terminalId = read(terminalAtom)
  const busy = disabled || handoffBusy() || connectionChanging()
  const hasAgents = agents.length > 0
  const launching = !hasAgents || terminalId === NEW_AGENT
  const choices = read(choicesAtom)
  const choice = choices?.find((entry) => entry.id === read(agentAtom))
  const loading = read(choicesLoadingAtom)
  const error = read(choicesErrorAtom)
  return (
    <Box padding="sm" background="muted" border radius="md">
      <Stack gap="sm">
        <Row justify="between" align="center" gap="xs" wrap>
          <Heading level={3}>交接工作项</Heading>
          <Badge tone="neutral">{context.displayName ?? '所选工作区'}</Badge>
        </Row>
        <Text size="xs" muted>{`#${handoff.item.id} · ${handoff.name}`}</Text>
        <Text size="sm" muted>{launching
          ? `在「${context.displayName ?? '所选工作区'}」启动 ${choice?.label ?? '所选 Agent'} 并发送工作项。启动前需安装对应 CLI。`
          : '标题、链接、状态和描述会填入所选终端，核对后提交。'}</Text>
        {context.path ? <Text size="xs" muted>{context.path}</Text> : null}
        {context.isActive === false ? <Text size="xs" muted>此工作区尚未打开。这里可启动新 Agent；要向已有终端写入草稿，先打开工作区。</Text> : null}
        {handoff.description !== '' ? <Text size="sm">{handoff.description.length > 200 ? `${handoff.description.slice(0, 200)}…` : handoff.description}</Text> : null}
        {hasAgents ? (
          <Select label="目标 Agent" value={terminalId} placeholder="选择接收工作项的 Agent" disabled={busy}
            options={[
              ...agents.flatMap((agent) => agent.terminalId ? [{ value: agent.terminalId, label: agent.title ?? agent.agent ?? agent.terminalId }] : []),
              { value: NEW_AGENT, label: '新建 Agent 会话' }
            ]}
            onChange={(value) => {
              if (handoff !== read(handoffAtom) || busy || (value !== NEW_AGENT && !agents.some((entry) => entry.terminalId === value))) return
              set(terminalAtom, value)
              if (value === NEW_AGENT && read(choicesAtom) === null && !read(choicesLoadingAtom)) void loadChoices(handoff, onError)
            }} />
        ) : null}
        {launching ? (
          <Stack gap="xs">
            <Select label="启动的 Agent" value={read(agentAtom)} placeholder="选择已配置的 Agent" disabled={busy || loading || !choices?.length}
              options={(choices ?? []).map((entry) => ({ value: entry.id, label: entry.label }))}
              onChange={(value) => {
                if (handoff === read(handoffAtom) && !busy && !loading && choices?.some((entry) => entry.id === value)) {
                  set(agentAtom, value)
                  set(lastAgentAtom, value)
                }
              }} />
            <Row gap="xs" wrap>
              <Button size="sm" variant="ghost" disabled={busy || loading} onPress={() => loadChoices(handoff, onError)}>{error ? '重试 Agent 列表' : '刷新 Agent 列表'}</Button>
              {loading ? <Spinner label="正在读取可用 Agent…" /> : null}
            </Row>
            {error || (!loading && choices?.length === 0) ? (
              <Callout tone={error ? 'danger' : 'warning'} title={error ? '无法读取可用 Agent' : '没有可启动的 Agent'}>
                <Stack gap="xs">
                  <Text size="sm">{error ?? '请在 Orca 设置 → Agents 中启用并配置对应 CLI，然后刷新列表。'}</Text>
                </Stack>
              </Callout>
            ) : null}
          </Stack>
        ) : null}
        <Row gap="xs" wrap>
          <Button size="sm" variant="solid" tone="accent" disabled={busy || (launching ? loading || error !== null || !choice : !agents.some((agent) => agent.terminalId === terminalId))}
            onPress={() => sendHandoff(handoff, launching ? null : terminalId, report, onError, launching ? choice?.id : undefined)}>{launching ? '启动 Agent 并发送' : '写入 Agent 输入框'}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onPress={() => cancelHandoff()}>取消交接</Button>
        </Row>
      </Stack>
    </Box>
  )
}

async function sendHandoff(handoff: Handoff, terminalId: string | null, report: Report, onError: (error: unknown) => Promise<void>, agent?: string): Promise<void> {
  if (handoffBusy() || connectionChanging() || handoff !== read(handoffAtom)) return
  if (terminalId === null && (read(choicesLoadingAtom) || read(choicesErrorAtom) !== null || !read(choicesAtom)?.some((entry) => entry.id === agent))) return
  set(sendBusyAtom, true)
  try {
    const result = await plugin.request('meego.sendToAgent', {
      ...handoff.item,
      workspaceId: handoff.workspaceId,
      terminalId,
      ...(terminalId === null && agent ? { agent } : {}),
      ...(handoff.origin === 'workspace' || handoff.expectedLinkedAt !== undefined ? { linked: true } : {}),
      ...(handoff.expectedUserKey ? { expectedUserKey: handoff.expectedUserKey } : {}),
      ...(handoff.expectedLinkedAt === undefined ? {} : { expectedLinkedAt: handoff.expectedLinkedAt })
    }, { timeoutMs: HANDOFF_TIMEOUT_MS })
    if (handoff === read(handoffAtom)) {
      report(result.detail, result.sent ? 'success' : 'danger')
      if (result.sent) cancelHandoff()
    }
  } catch (error) {
    if (handoff === read(handoffAtom)) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      const message = code === 'timeout' || code === 'unavailable'
        ? '无法确认交接结果。请先检查目标工作区的终端，再决定是否重试。'
        : error instanceof Error ? error.message : String(error)
      report(message, 'danger')
    }
    await onError(error)
  } finally {
    set(sendBusyAtom, false)
  }
}
