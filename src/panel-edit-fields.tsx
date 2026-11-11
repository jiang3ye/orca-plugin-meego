import {
  Box, Button, Callout, Heading, Input, KeyValue, Markdown,
  Row, Select, Spinner, Stack, Text, Textarea
} from 'orca'
import type { EditWorkItemInput, WorkItemDetail, WorkItemEditOptions } from './protocol'
import { MemberPicker, type MemberPickerProps } from './panel-member-picker'

export type EditOperation = EditWorkItemInput['operation']
export type EditMember = { key: string; name: string }
export type EditDraft = {
  name: string
  description: string
  priorityKey: string | null
  transitionId: string
  roleKey: string
  roleUserKeys: string[] | null
  roleBaseUserKeys: string[] | null
}
export type EditRole = NonNullable<WorkItemEditOptions['roles']>['options'][number]
export type EditReadback = { item: WorkItemDetail; options: WorkItemEditOptions }

export const editOperations: { value: EditOperation; label: string }[] = [
  { value: 'name', label: '标题' },
  { value: 'description', label: '描述' },
  { value: 'priority', label: '优先级' },
  { value: 'status', label: '状态' },
  { value: 'roleMembers', label: '角色成员' },
  { value: 'operators', label: '当前负责人' }
]

export function editCapability(options: WorkItemEditOptions, operation: EditOperation) {
  if (operation === 'name') return options.text.title
  if (operation === 'description') return options.text.description
  if (operation === 'roleMembers') return options.roles ?? { state: 'browserOnly' as const, reason: '当前连接未提供角色成员编辑能力。' }
  if (operation === 'operators') return { state: 'browserOnly' as const, reason: options.operators.reason ?? '当前负责人由系统计算，可调整角色成员或流程节点负责人。' }
  return options[operation]
}

type MemberEditorProps = Omit<MemberPickerProps, 'description'>

export function selectedRole(options: WorkItemEditOptions, draft: EditDraft): EditRole | undefined {
  return options.roles?.options.find((role) => role.key === draft.roleKey)
}

function roleMembers(role: EditRole): string {
  const names = new Map(role.users.map((user) => [user.key, user.name]))
  return role.userKeys.map((key) => names.get(key) ?? '姓名暂不可用').join('、') || '未设置'
}

export function EditFields({ options, draft, operation, disabled, saving, canSave, browserUrl, members, onOperation, onRole, onChange, onSave, onBrowser }: {
  options: WorkItemEditOptions
  draft: EditDraft
  operation: EditOperation
  disabled: boolean
  saving: boolean
  canSave: boolean
  browserUrl: string
  members: MemberEditorProps
  onOperation: (operation: string) => void
  onRole: (roleKey: string) => void
  onChange: (change: Partial<EditDraft>) => void
  onSave: () => Promise<void>
  onBrowser: () => Promise<void>
}) {
  const role = selectedRole(options, draft)
  const supported = operation === 'description' && draft.description.length > 10_000
    ? { state: 'browserOnly' as const, reason: '现有描述较长，请在飞书项目中完整修改。' }
    : editCapability(options, operation)
  return (
    <Stack gap="sm">
      <Select label="编辑字段" value={operation} options={editOperations} disabled={disabled} onChange={onOperation} />
      {supported.state === 'browserOnly' ? (
        <Callout tone="neutral" title="在飞书项目中编辑">
          <Stack gap="xs">
            <Text size="sm">{supported.reason ?? '此字段需要在飞书项目中编辑。'}</Text>
            {browserUrl ? <Button size="sm" variant="outline" icon="open-external" onPress={onBrowser}>打开飞书项目</Button> : null}
          </Stack>
        </Callout>
      ) : (
        <Stack gap="sm">
          {operation === 'name' ? <Input label="工作项标题" value={draft.name} maxLength={200} disabled={disabled}
            onChange={(name) => onChange({ name })} onSubmit={onSave} /> : null}
          {operation === 'description' ? <Textarea label="工作项描述" value={draft.description} rows={5} maxLength={10_000} disabled={disabled}
            onChange={(description) => onChange({ description })} onSubmit={onSave} /> : null}
          {operation === 'priority' ? (
            options.priority.options.length ? <Select label="优先级" value={draft.priorityKey ?? ''} options={options.priority.options.map((option) => ({ value: option.key, label: option.label }))}
              placeholder="选择优先级" disabled={disabled} onChange={(priorityKey) => onChange({ priorityKey })} /> : <Text size="sm" muted>此类型没有可选优先级。</Text>
          ) : null}
          {operation === 'status' ? (
            options.status.transitions.length ? <Select label="目标状态" value={draft.transitionId}
              options={options.status.transitions.map((transition) => ({ value: transition.id, label: transition.label }))}
              placeholder="选择可用流转" disabled={disabled} onChange={(transitionId) => onChange({ transitionId })} /> : <Text size="sm" muted>当前状态没有可用流转。</Text>
          ) : null}
          {operation === 'roleMembers' ? (
            <Stack gap="sm">
              <Select label="选择角色" value={draft.roleKey} placeholder="选择要调整成员的角色" disabled={disabled}
                options={(options.roles?.options ?? []).map((entry) => ({ value: entry.key, label: entry.label }))} onChange={onRole} />
              {role ? (
                <Stack gap="sm">
                  <KeyValue items={[{ label: `${role.label} · 当前成员`, value: roleMembers(role) }]} />
                  <MemberPicker {...members} searchLabel="搜索角色成员" candidatesLabel="角色成员候选成员"
                    description={`调整「${role.label}」成员。勾选新增成员，取消勾选移除成员。`} />
                </Stack>
              ) : <Text size="xs" muted>先选择一个角色，再调整该角色的成员。</Text>}
            </Stack>
          ) : null}
          <Row justify="end"><Button size="sm" variant="solid" tone="accent" disabled={disabled || !canSave} onPress={onSave}>{saving ? '保存中…' : '保存更改'}</Button></Row>
        </Stack>
      )}
    </Stack>
  )
}

function readbackValue(readback: EditReadback, operation: EditOperation): string {
  if (operation === 'name') return readback.item.name
  if (operation === 'description') return readback.item.description || '描述为空'
  if (operation === 'status') return readback.item.status || '未返回状态名称'
  if (operation === 'priority') {
    return readback.options.priority.options.find((option) => option.key === readback.options.priority.currentKey)?.label ?? '未设置'
  }
  const users = new Map(readback.options.operators.users.map((user) => [user.key, user.name]))
  return readback.options.operators.userKeys.map((key) => users.get(key) ?? '姓名暂不可用').join('、') || '未设置'
}

export function EditRecovery({ operation, roleKey, roleLabel, readback, reading, busy, browserUrl, onRead, onBrowser, onAcknowledge, onAdopt }: {
  operation: EditOperation
  roleKey?: string
  roleLabel?: string
  readback: EditReadback | null
  reading: boolean
  busy: boolean
  browserUrl: string
  onRead: () => Promise<void>
  onBrowser: () => Promise<void>
  onAcknowledge: () => Promise<void> | undefined
  onAdopt: () => Promise<void>
}) {
  const role = readback?.options.roles?.options.find((entry) => entry.key === roleKey)
  return (
    <Callout tone="warning" title="保存结果待核对">
      <Stack gap="sm">
        <Text size="sm">更改已保留。核对飞书项目中的实际结果后再继续编辑。</Text>
        {operation === 'roleMembers' ? <Text size="sm">{`目标角色 · ${roleLabel ?? role?.label ?? '角色信息暂不可用'}`}</Text> : null}
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" icon="refresh" disabled={busy || reading} onPress={onRead}>刷新回读</Button>
          {browserUrl ? <Button size="sm" variant="outline" icon="open-external" onPress={onBrowser}>在飞书项目中核对</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy || reading} onPress={onAcknowledge}>已核对，尚未保存</Button>
          <Button size="sm" variant="ghost" disabled={busy || reading || readback === null} onPress={onAdopt}>采用回读结果</Button>
        </Row>
        {reading ? <Spinner label="正在回读工作项…" /> : null}
        {readback !== null ? (
          <Box padding="sm" border radius="md" background="muted" gap="xs">
            <Heading level={3}>当前回读结果</Heading>
            {operation === 'roleMembers' ? (
              <KeyValue items={[
                { label: '角色', value: role?.label ?? roleLabel ?? '角色信息暂不可用' },
                { label: '角色成员', value: role ? roleMembers(role) : '回读未返回此角色的成员信息' }
              ]} />
            ) : operation === 'description' ? <Markdown content={readbackValue(readback, operation)} /> : (
              <KeyValue items={[{ label: editOperations.find((entry) => entry.value === operation)?.label ?? '字段', value: readbackValue(readback, operation) }]} />
            )}
          </Box>
        ) : null}
      </Stack>
    </Callout>
  )
}
