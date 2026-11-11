import { atom, Box, Button, Callout, Field, Heading, Input, Row, Select, Spinner, Stack, Text, Textarea, plugin, read, set, shell } from 'orca'
import type { CreateWorkItemField, CreateWorkItemForm, CreateWorkItemInput, WorkItemSummary, WorkItemType } from './protocol'
import { connectionChanging } from './panel-connection'
import { WRITE_REQUEST_OPTIONS, writeResponseLost } from './panel-write'

type Scope = Pick<CreateWorkItemInput, 'source' | 'expectedUserKey'>

interface CreateDraft {
  scope: Scope
  typeKey: string
  name: string
  description: string
  templateId: string
  fieldValues: Record<string, string>
}

type FormState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; form: CreateWorkItemForm }
type ErrorHandler = (error: unknown) => Promise<void>

const draftAtom = atom<CreateDraft | null>(null)
const formAtom = atom<FormState>({ state: 'loading' })
const errorAtom = atom<string | null>(null)
const busyAtom = atom(false)
const unverifiedAtom = atom(false)
let formRequest = 0

export function createBusy(): boolean {
  return read(busyAtom)
}

export function createOpen(): boolean {
  return read(draftAtom) !== null
}

export function resetCreate(): void {
  formRequest += 1
  set(draftAtom, null)
  set(formAtom, { state: 'loading' })
  set(errorAtom, null)
  set(unverifiedAtom, false)
}

export function toggleCreate(typeKey: string, scope: Scope, onError: ErrorHandler): Promise<void> | undefined {
  if (createOpen()) {
    if (!read(unverifiedAtom)) resetCreate()
    return
  }
  set(draftAtom, { scope, typeKey, name: '', description: '', templateId: '', fieldValues: {} })
  return loadForm(onError)
}

function changeDraft(values: Partial<CreateDraft>): void {
  const draft = read(draftAtom)
  if (draft === null) return
  set(draftAtom, { ...draft, ...values })
}

async function loadForm(onError: ErrorHandler): Promise<void> {
  const draft = read(draftAtom)
  if (draft === null) return
  const request = ++formRequest
  set(errorAtom, null)
  set(formAtom, { state: 'loading' })
  try {
    const { form } = await plugin.request('meego.createForm', { ...draft.scope, typeKey: draft.typeKey })
    if (request !== formRequest) return
    const templates = form.templates
    const defaults = templates.filter((template) => template.isDefault)
    changeDraft({ templateId: templates.length === 1 ? templates[0].id : defaults.length === 1 ? defaults[0].id : '' })
    set(formAtom, { state: 'ready', form })
  } catch (error) {
    if (request !== formRequest) return
    set(formAtom, { state: 'error', message: messageOf(error) })
    await onError(error)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readField(draft: CreateDraft, key: string): string {
  return Object.hasOwn(draft.fieldValues, key) ? draft.fieldValues[key] : ''
}

function fieldError(field: CreateWorkItemField, value: string): string | null {
  if (!value) return field.required ? `请填写「${field.label}」。` : null
  if (field.kind === 'number' && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)))) {
    return `「${field.label}」须填写数字。`
  }
  if (field.kind === 'date') {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      return `「${field.label}」须填写有效日期，格式为 YYYY-MM-DD。`
    }
  }
  return null
}

async function submitCreate(onCreated: (item?: WorkItemSummary) => Promise<void>, onError: ErrorHandler): Promise<void> {
  const draft = read(draftAtom)
  const state = read(formAtom)
  if (draft === null || state.state !== 'ready' || connectionChanging() || createBusy() || read(unverifiedAtom)) return
  const name = draft.name.trim()
  if (!name) return
  const form = state.form
  const values: [string, string][] = []
  const description = draft.description.trim()
  if (form.unsupportedRequired.length || form.templates.length === 0) return
  if (form.descriptionRequired && !description) {
    set(errorAtom, '请填写描述。')
    return
  }
  if (!form.templates.some(({ id }) => id === draft.templateId)) {
    set(errorAtom, '请选择工作项模板。')
    return
  }
  for (const field of form.fields) {
    const value = readField(draft, field.key).trim()
    const error = fieldError(field, value)
    if (error) {
      set(errorAtom, error)
      return
    }
    if (value) values.push([field.key, value])
  }

  const request = formRequest
  const input: CreateWorkItemInput = {
    ...draft.scope, typeKey: draft.typeKey, name,
    ...(description ? { description } : {}),
    templateId: draft.templateId,
    ...(values.length ? { fieldValues: Object.fromEntries(values) } : {})
  }
  set(busyAtom, true)
  set(errorAtom, null)
  try {
    const result = await plugin.request('meego.createWorkItem', input, WRITE_REQUEST_OPTIONS)
    if (request !== formRequest) return
    if ('state' in result && result.state === 'unverified') {
      set(unverifiedAtom, true)
      return
    }
    resetCreate()
    await onCreated('item' in result ? result.item : undefined)
  } catch (error) {
    if (request !== formRequest) return
    if (writeResponseLost(error)) {
      set(unverifiedAtom, true)
    } else {
      set(errorAtom, messageOf(error))
      await onError(error)
    }
  } finally {
    set(busyAtom, false)
  }
}

function DynamicField({ field, value, disabled }: { field: CreateWorkItemField; value: string; disabled: boolean }) {
  const onChange = (next: string) => changeDraft({ fieldValues: { ...read(draftAtom)?.fieldValues, [field.key]: next } })
  const options = field.kind === 'boolean'
    ? [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]
    : field.options
  return (
    <Field label={field.label} required={field.required}>
      {options
        ? <Select label={field.label} labelHidden value={value} placeholder="请选择" options={options} disabled={disabled} onChange={onChange} />
        : <Input label={field.label} labelHidden value={value} placeholder={field.kind === 'date' ? 'YYYY-MM-DD' : undefined}
          maxLength={2000} disabled={disabled} onChange={onChange} />}
    </Field>
  )
}

async function openCreateInBrowser(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch (error) {
    set(errorAtom, messageOf(error))
  }
}

export function CreateForm({ types, onCreated, onError }: {
  types: WorkItemType[]
  onCreated: (item?: WorkItemSummary) => Promise<void>
  onError: ErrorHandler
}) {
  const draft = read(draftAtom)
  if (draft === null) return null
  const state = read(formAtom)
  const form = state.state === 'ready' ? state.form : null
  const error = read(errorAtom)
  const busy = createBusy()
  const disabled = busy || connectionChanging()
  const unverified = read(unverifiedAtom)
  const fieldsDisabled = disabled || unverified
  const unavailable = form !== null && (form.templates.length === 0 || form.unsupportedRequired.length > 0)
  const requiresMember = form?.fields.some((field) => field.kind === 'user' || field.kind === 'multi-user')
  const browserUrl = form?.browserUrl
  const verifyUrl = draft.scope.source?.baseUrl || browserUrl
  const submit = () => submitCreate(onCreated, onError)
  return (
    <Box padding="sm" background="muted" border radius="md">
      <Stack gap="sm">
        <Heading level={3}>新建工作项</Heading>
        <Select label="工作项类型" value={draft.typeKey} options={types.map((type) => ({ value: type.key, label: type.name }))}
          disabled={fieldsDisabled} onChange={(typeKey) => {
            changeDraft({ typeKey, templateId: '', fieldValues: {} })
            return loadForm(onError)
          }} />
        <Input label="标题" placeholder="工作项标题" value={draft.name} maxLength={200} disabled={fieldsDisabled}
          onChange={(name) => changeDraft({ name })} onSubmit={submit} />
        <Textarea label={form?.descriptionRequired ? '描述（必填）' : '描述'} placeholder={form?.descriptionRequired ? '描述工作项…' : '描述（可选）…'}
          rows={4} maxLength={5000} value={draft.description} disabled={fieldsDisabled}
          onChange={(description) => changeDraft({ description })} />
        {state.state === 'loading' ? <Spinner label="正在读取创建字段…" /> : null}
        {state.state === 'error' ? (
          <Callout title="无法读取创建字段" tone="warning">
            <Stack gap="xs">
              <Text size="sm">{state.message}</Text>
              <Button size="sm" variant="ghost" disabled={disabled} onPress={() => loadForm(onError)}>重试加载字段</Button>
            </Stack>
          </Callout>
        ) : null}
        {form?.templates.length ? (
          <Select label="工作项模板" value={draft.templateId} placeholder="请选择模板" disabled={fieldsDisabled}
            options={form.templates.map(({ id, name }) => ({ value: id, label: name }))}
            onChange={(templateId) => changeDraft({ templateId })} />
        ) : null}
        {form?.fields.map((field) => <DynamicField field={field} value={readField(draft, field.key)} disabled={fieldsDisabled} />)}
        {requiresMember && !unavailable && browserUrl ? (
          <Button size="sm" variant="ghost" icon="open-external" onPress={() => openCreateInBrowser(browserUrl)}>在飞书项目中选择其他成员</Button>
        ) : null}
        {unavailable && form !== null ? (
          <Callout tone="warning" title="请在飞书项目中完成创建">
            <Stack gap="xs">
              <Text size="sm">{form.unsupportedRequired.length
                ? `此类型需要在网页填写：${form.unsupportedRequired.join('、')}。`
                : '当前空间没有返回可用的创建模板。'}</Text>
              {browserUrl ? <Button size="sm" variant="outline" icon="open-external" onPress={() => openCreateInBrowser(browserUrl)}>在飞书项目中新建</Button> : null}
            </Stack>
          </Callout>
        ) : null}
        {unverified ? (
          <Callout tone="warning" title="创建结果待核对">
            <Stack gap="xs">
              <Text size="sm">草稿已保留。请在飞书项目中搜索同名工作项，确认是否已创建。</Text>
              <Row gap="xs" wrap>
                {verifyUrl ? <Button size="sm" variant="outline" icon="open-external" onPress={() => openCreateInBrowser(verifyUrl)}>在飞书项目中核对</Button> : null}
                <Button size="sm" variant="ghost" disabled={disabled} onPress={() => set(unverifiedAtom, false)}>已核对，尚未创建</Button>
              </Row>
            </Stack>
          </Callout>
        ) : null}
        {error !== null ? <Text size="sm" tone="danger">{error}</Text> : null}
        <Row gap="xs" justify="end">
          <Button size="sm" variant="ghost" disabled={busy} onPress={resetCreate}>{unverified ? '丢弃草稿' : '取消'}</Button>
          <Button size="sm" variant="solid" tone="accent" onPress={submit} disabled={fieldsDisabled || state.state !== 'ready' || unavailable || draft.name.trim() === ''}>
            {busy ? '创建中…' : '创建'}
          </Button>
        </Row>
      </Stack>
    </Box>
  )
}
