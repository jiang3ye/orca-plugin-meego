import { Badge, Box, Button, Callout, Heading, KeyValue, List, ListItem, Row, Select, Spinner, Stack, Text, Textarea } from 'orca'
import type { EditWorkItemNodeInput, WorkItemDetail, WorkItemNode, WorkItemNodeList } from './protocol'
import { MemberPicker, type MemberPickerProps } from './panel-member-picker'

type NodeOperation = EditWorkItemNodeInput['operation']
export type NodeReadback = { item: WorkItemDetail; nodes: WorkItemNodeList }
export type NodePlan = { input: EditWorkItemNodeInput; node: WorkItemNode; members: { key: string; name: string }[] }

export function nodeStatus(status: WorkItemNode['status']): string {
  return { not_started: '未开始', doing: '进行中', finished: '已完成', unknown: '状态未知' }[status]
}

const actionLabels = { confirm: '完成节点', rollback: '回退节点', owners: '更新负责人' }
const operations: { value: NodeOperation; label: string }[] = [
  { value: 'confirm', label: '完成节点' }, { value: 'rollback', label: '回退节点' }, { value: 'owners', label: '节点负责人' }
]

export function NodesList({ list, selectedKey, disabled, onSelect, onBrowser, browserUrl }: {
  list: WorkItemNodeList; selectedKey: string; disabled: boolean; onSelect: (key: string) => Promise<void>; onBrowser: () => Promise<void>; browserUrl: string
}) {
  if (list.state === 'browserOnly') return (
    <Stack gap="xs">
      <Text size="sm" muted>{list.reason ?? '此工作项的流程需要在飞书项目中查看。'}</Text>
      {browserUrl ? <Button size="sm" variant="ghost" icon="open-external" onPress={onBrowser}>在飞书项目中查看流程</Button> : null}
    </Stack>
  )
  return (
    <Stack gap="xs">
      {list.nodes.length ? (
        <List label="工作项流程节点">
          {list.nodes.map((node) => (
            <ListItem key={node.key} title={node.name} icon={node.status === 'finished' ? 'check' : node.status === 'doing' ? 'activity' : 'next'}
              description={`${nodeStatus(node.status)} · ${node.owners.map((owner) => owner.name).join('、') || '未设置负责人'}`}
              current={selectedKey === node.key} disabled={disabled} onPress={() => onSelect(node.key)} />
          ))}
        </List>
      ) : <Text size="sm" muted>当前工作项没有可查看的流程节点。</Text>}
    </Stack>
  )
}

export function NodeActions({ node, operation, reason, blocked, canPrepare, members, onOperation, onReason, onPrepare, onBrowser, browserUrl }: {
  node: WorkItemNode; operation: NodeOperation; reason: string; blocked: boolean; canPrepare: boolean; members: MemberPickerProps
  onOperation: (value: string) => void; onReason: (value: string) => void; onPrepare: () => void; onBrowser: () => Promise<void>; browserUrl: string
}) {
  const capability = node.actions[operation]
  return (
    <Box padding="sm" border radius="md" background="muted" gap="sm">
      <Row gap="xs" justify="between" align="center" wrap>
        <Heading level={3}>{node.name}</Heading>
        <Badge tone={node.status === 'finished' ? 'success' : node.status === 'doing' ? 'accent' : 'neutral'}>{nodeStatus(node.status)}</Badge>
      </Row>
      <Text size="sm">{`负责人 · ${node.owners.map((owner) => owner.name).join('、') || '未设置'}`}</Text>
      <Select label="节点操作" value={operation} options={operations} disabled={blocked} onChange={onOperation} />
      {capability.state === 'browserOnly' ? (
        <Stack gap="xs">
          <Text size="sm" muted>{capability.reason ?? '此操作需要在飞书项目中完成。'}</Text>
          {browserUrl ? <Button size="sm" variant="outline" icon="open-external" onPress={onBrowser}>在飞书项目中操作节点</Button> : null}
        </Stack>
      ) : (
        <Stack gap="sm">
          <Text size="xs" muted>{`此次操作仅作用于「${node.name}」节点。`}</Text>
          {operation === 'rollback' ? <Textarea label="回退原因" value={reason} rows={3} maxLength={2000} disabled={blocked} onChange={onReason} /> : null}
          {operation === 'owners' ? <MemberPicker {...members} /> : null}
          <Row justify="end"><Button size="sm" variant="outline" disabled={blocked || !canPrepare} onPress={onPrepare}>{`准备${actionLabels[operation]}`}</Button></Row>
        </Stack>
      )}
    </Box>
  )
}

export function NodeConfirmation({ plan, busy, onConfirm, onCancel }: { plan: NodePlan; busy: boolean; onConfirm: () => Promise<void>; onCancel: () => void }) {
  const operation = plan.input.operation
  const owners = new Map(plan.members.map((user) => [user.key, user.name]))
  return (
    <Callout tone={operation === 'rollback' ? 'warning' : 'neutral'} title="确认节点操作">
      <Stack gap="sm">
        <KeyValue items={[
          { label: '工作项', value: `#${plan.input.id}` }, { label: '节点', value: plan.node.name },
          { label: '操作', value: actionLabels[operation] }, { label: '当前状态', value: nodeStatus(plan.node.status) },
          ...(operation === 'rollback' ? [{ label: '回退原因', value: plan.input.reason ?? '' }] : []),
          ...(plan.input.operation === 'owners' ? [{ label: '目标负责人', value: plan.input.userKeys.map((key) => owners.get(key) ?? '姓名暂不可用').join('、') || '未设置' }] : [])
        ]} />
        <Row gap="xs" wrap>
          <Button size="sm" variant="solid" tone="accent" disabled={busy} onPress={onConfirm}>{busy ? '正在提交…' : `确认${actionLabels[operation]}`}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onPress={onCancel}>取消节点操作</Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export function NodeRecovery({ plan, readback, busy, reading, browserUrl, onRead, onBrowser, onAcknowledge, onAdopt }: {
  plan: NodePlan; readback: NodeReadback | null; busy: boolean; reading: boolean; browserUrl: string
  onRead: () => Promise<void>; onBrowser: () => Promise<void>; onAcknowledge: () => Promise<void>; onAdopt: () => Promise<void>
}) {
  const node = readback?.nodes.nodes.find((entry) => entry.key === plan.node.key)
  return (
    <Callout tone="warning" title="节点操作结果待核对">
      <Stack gap="sm">
        <Text size="sm">{`「${plan.node.name}」的${actionLabels[plan.input.operation]}结果待核对。确认实际流程前，此工作项的节点操作已暂停。`}</Text>
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" icon="refresh" disabled={busy || reading} onPress={onRead}>只读核对流程</Button>
          {browserUrl ? <Button size="sm" variant="outline" icon="open-external" onPress={onBrowser}>在飞书项目中核对</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy || reading} onPress={onAcknowledge}>已核对，尚未执行</Button>
          <Button size="sm" variant="ghost" disabled={busy || reading || readback === null} onPress={onAdopt}>采用最新流程</Button>
        </Row>
        {reading ? <Spinner label="正在回读流程…" /> : null}
        {node ? <KeyValue items={[{ label: '节点', value: node.name }, { label: '当前状态', value: nodeStatus(node.status) }, { label: '当前负责人', value: node.owners.map((owner) => owner.name).join('、') || '未设置' }]} /> : null}
        {readback && !node ? <Text size="sm" muted>{readback.nodes.reason ?? '最新流程中未找到此节点，可采用最新流程后重新选择。'}</Text> : null}
      </Stack>
    </Callout>
  )
}
