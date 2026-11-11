import {
  atom, Box, Button, Callout, Card, Collapsible, Heading, Input, List, ListItem, Row,
  Spinner, Stack, Text, read, set, plugin, shell
} from 'orca'
import type { AuthorizationChallenge, MeegoSpace, MeegoStatus } from './protocol'

const challengeAtom = atom<AuthorizationChallenge | null>(null)
const authorizationPollingAtom = atom(false)
const authorizationNetworkErrorAtom = atom<string | null>(null)
const connectionBusyAtom = atom(false)
const connectionErrorAtom = atom<string | null>(null)
const settingsErrorAtom = atom<string | null>(null)
const pickerOpenAtom = atom(false)
const spaceSearchAtom = atom('')
const spacesAtom = atom<MeegoSpace[] | null>(null)
const hasMoreSpacesAtom = atom(false)
const spacesBusyAtom = atom(false)
const spacesErrorAtom = atom<string | null>(null)
const advancedOpenAtom = atom(false)
const pluginIdAtom = atom('')
const pluginSecretAtom = atom('')

let pollTimer: ReturnType<typeof setTimeout> | undefined
let spaceRequest = 0
let spacePage = 1
let spaceFilter = ''
let authorizationEpoch = 0

type Refresh = () => Promise<void>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function openIntegrationSettings(): Promise<void> {
  set(settingsErrorAtom, null)
  try {
    const { opened } = await plugin.request('meego.openSettings')
    if (!opened) throw new Error('Orca 未能打开集成设置，请重试。')
  } catch (error) {
    set(settingsErrorAtom, errorMessage(error))
  }
}

export function connectionChanging(): boolean {
  return read(connectionBusyAtom)
}

export function disposeConnection(): void {
  clearTimeout(pollTimer)
  authorizationEpoch += 1
  spaceRequest += 1
}

function resetChallenge(): void {
  authorizationEpoch += 1
  clearTimeout(pollTimer)
  set(challengeAtom, null)
  set(authorizationPollingAtom, false)
  set(authorizationNetworkErrorAtom, null)
}

async function changeConnection(action: () => Promise<void>): Promise<void> {
  if (read(connectionBusyAtom)) return
  set(connectionBusyAtom, true)
  set(connectionErrorAtom, null)
  try {
    await action()
  } catch (error) {
    set(connectionErrorAtom, errorMessage(error))
  } finally {
    set(connectionBusyAtom, false)
  }
}

function beginAuthorization(): Promise<void> {
  return changeConnection(async () => {
    const epoch = authorizationEpoch
    set(pickerOpenAtom, false)
    const challenge = await plugin.request('meego.beginAuthorization', undefined, { timeoutMs: 45_000 })
    if (epoch === authorizationEpoch) set(challengeAtom, challenge)
  })
}

export function resumeAuthorization(challenge: AuthorizationChallenge | undefined, refresh: Refresh): void {
  if (challenge === undefined || challenge.expiresAt <= Date.now() || read(challengeAtom) !== null) return
  set(challengeAtom, challenge)
  set(authorizationPollingAtom, true)
  schedulePoll(challenge, challenge.intervalMs, refresh)
}

function schedulePoll(challenge: AuthorizationChallenge, intervalMs: number, refresh: Refresh): void {
  clearTimeout(pollTimer)
  const remaining = challenge.expiresAt - Date.now()
  const epoch = authorizationEpoch
  pollTimer = setTimeout(() => void pollAuthorization(epoch, challenge, refresh), Math.max(0, Math.min(remaining, intervalMs)))
}

async function pollAuthorization(epoch: number, challenge: AuthorizationChallenge, refresh: Refresh): Promise<void> {
  const active = () => epoch === authorizationEpoch && challenge === read(challengeAtom)
  if (!active()) return
  try {
    const result = await plugin.request('meego.pollAuthorization')
    if (!active()) return
    if (result.state === 'waiting' && challenge.expiresAt > Date.now()) {
      set(authorizationNetworkErrorAtom, null)
      schedulePoll(challenge, result.intervalMs, refresh)
      return
    }
    if (result.state === 'network_error' && challenge.expiresAt > Date.now()) {
      set(authorizationNetworkErrorAtom, result.message)
      schedulePoll(challenge, Math.max(challenge.intervalMs, 5_000), refresh)
      return
    }
    resetChallenge()
    if (result.state === 'authorized') {
      await refresh()
    } else {
      set(connectionErrorAtom, '授权已过期，请重新连接飞书项目。')
    }
  } catch (error) {
    if (!active()) return
    resetChallenge()
    set(connectionErrorAtom, errorMessage(error))
  }
}

async function openAuthorization(challenge: AuthorizationChallenge, refresh: Refresh): Promise<void> {
  const epoch = authorizationEpoch
  const active = () => epoch === authorizationEpoch && challenge === read(challengeAtom)
  set(connectionErrorAtom, null)
  try {
    const result = await shell.openExternal(challenge.url)
    if (!active()) return
    if (!result.opened) {
      if (result.reason !== 'cancelled') set(connectionErrorAtom, '无法打开授权页，请再试一次。')
      return
    }
    if (read(authorizationPollingAtom)) return
    set(authorizationPollingAtom, true)
    schedulePoll(challenge, challenge.intervalMs, refresh)
  } catch (error) {
    if (active()) set(connectionErrorAtom, errorMessage(error))
  }
}

function cancelAuthorization(refresh: Refresh): Promise<void> {
  return changeConnection(async () => {
    resetChallenge()
    await plugin.request('meego.cancelAuthorization')
    await refresh()
  })
}

function disconnect(refresh: Refresh): Promise<void> {
  return changeConnection(async () => {
    resetChallenge()
    resetSpaces()
    await plugin.request('meego.disconnect')
    await refresh()
  })
}

function resetSpaces(): void {
  spaceRequest += 1
  spacePage = 1
  spaceFilter = ''
  set(pickerOpenAtom, false)
  set(spacesBusyAtom, false)
  set(spaceSearchAtom, '')
  set(spacesAtom, null)
  set(hasMoreSpacesAtom, false)
  set(spacesErrorAtom, null)
}

export async function loadSpaces(page = 1, autoSelect = false): Promise<boolean> {
  if (page > 1 && read(spacesBusyAtom)) return false
  const request = ++spaceRequest
  if (page === 1) spaceFilter = read(spaceSearchAtom).trim()
  const search = spaceFilter
  set(spacesBusyAtom, true)
  set(spacesErrorAtom, null)
  try {
    const result = await plugin.request('meego.listSpaces', { ...(search ? { search } : {}), page })
    if (request !== spaceRequest) return false
    set(spacesAtom, page === 1 ? result.spaces : [...new Map(
      [...(read(spacesAtom) ?? []), ...result.spaces].map((space) => [space.key, space])
    ).values()])
    set(hasMoreSpacesAtom, result.hasMore)
    spacePage = page
    if (autoSelect && !search && result.spaces.length === 1 && !result.hasMore) {
      const { ok } = await plugin.request('meego.selectSpace', { key: result.spaces[0].key })
      if (ok && request === spaceRequest) {
        resetSpaces()
        return true
      }
    }
  } catch (error) {
    if (request === spaceRequest) set(spacesErrorAtom, errorMessage(error))
  } finally {
    if (request === spaceRequest) set(spacesBusyAtom, false)
  }
  return false
}

async function chooseSpace(key: string, refresh: Refresh): Promise<void> {
  if (!key) return
  await changeConnection(async () => {
    const { ok } = await plugin.request('meego.selectSpace', { key })
    if (!ok) throw new Error('无法切换到此空间，请刷新空间列表后重试。')
    resetSpaces()
    await refresh()
  })
}

async function togglePicker(): Promise<void> {
  if (read(pickerOpenAtom)) {
    resetSpaces()
  } else {
    set(pickerOpenAtom, true)
    await loadSpaces()
  }
}

function SpacePicker({ refresh, busy, currentKey }: { refresh: Refresh; busy: boolean; currentKey: string }) {
  const spaces = read(spacesAtom)
  const search = read(spaceSearchAtom)
  const error = read(spacesErrorAtom)
  const loading = read(spacesBusyAtom)
  return (
    <Stack gap="sm">
      <Heading level={3}>选择空间</Heading>
      <Input label="搜索空间" type="search" placeholder="输入空间名称，按回车搜索" value={search} disabled={busy}
        onChange={(value) => set(spaceSearchAtom, value)} onSubmit={() => loadSpaces()} />
      {loading ? <Spinner label="正在读取空间…" /> : null}
      {error !== null ? <Callout tone="danger" title="空间加载失败"><Text size="sm">{error}</Text></Callout> : null}
      {spaces !== null && spaces.length > 0 ? (
        <List label="可访问的飞书项目空间">
          {spaces.map((space) => (
            <ListItem key={space.key} title={space.name} icon="layers" current={space.key === currentKey}
              disabled={busy || loading} onPress={() => chooseSpace(space.key, refresh)} />
          ))}
        </List>
      ) : null}
      {!loading && error === null && spaces?.length === 0 ? (
        <Text size="sm" muted>{search.trim() ? '没有匹配的空间。' : '此账号目前没有可访问的飞书项目空间。'}</Text>
      ) : null}
      <Row gap="xs" wrap>
        {read(hasMoreSpacesAtom) ? <Button size="sm" variant="outline" disabled={busy || loading} onPress={() => loadSpaces(spacePage + 1)}>更多空间</Button> : null}
        {search || error !== null || spaces?.length === 0 ? (
          <Button size="sm" variant="ghost" disabled={busy || loading} onPress={() => { set(spaceSearchAtom, ''); return loadSpaces() }}>
            {search ? '清除搜索' : '刷新空间'}
          </Button>
        ) : null}
      </Row>
    </Stack>
  )
}

function AdvancedConnection({ status, refresh, busy }: { status: MeegoStatus; refresh: Refresh; busy: boolean }) {
  const pluginId = read(pluginIdAtom)
  const secret = read(pluginSecretAtom)
  const open = read(advancedOpenAtom)
  return (
    <Stack gap="xs">
      <Row justify="start">
        <Button size="sm" variant="ghost" onPress={() => set(advancedOpenAtom, !open)}>{open ? '收起高级连接' : '高级连接'}</Button>
      </Row>
      {open ? (
        <Card title="企业插件连接">
          <Stack gap="sm">
            <Text size="sm" muted>在 Orca 设置 → 集成 → Meego → 高级设置中填写空间和用户配置。插件密钥保存在本机的加密凭据中。</Text>
            {status.missing.length > 0 ? <Text size="sm" muted>{`还缺少：${status.missing.map((item) => item.label).join('、')}`}</Text> : null}
            {status.missing.length === 0 ? (
              <Button disabled={busy} onPress={() => changeConnection(async () => {
                await plugin.request('meego.testConnection')
                await refresh()
              })}>使用已配置的企业插件</Button>
            ) : null}
            <Input label="Plugin ID" value={pluginId} maxLength={64} onChange={(value) => set(pluginIdAtom, value)} />
            <Input label="Plugin Secret" type="password" value={secret} maxLength={128} onChange={(value) => set(pluginSecretAtom, value)} />
            <Button disabled={busy || !pluginId.trim() || !secret.trim()} onPress={() => changeConnection(async () => {
              await plugin.request('meego.saveCredentials', { pluginId: pluginId.trim(), pluginSecret: secret.trim() })
              set(pluginSecretAtom, '')
              await plugin.request('meego.testConnection')
              await refresh()
            })}>保存并测试连接</Button>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  )
}

export function ConnectionPanel({ status, refresh, disabled, settingsView = false }: { status: MeegoStatus; refresh: Refresh; disabled: boolean; settingsView?: boolean }) {
  const busy = disabled || connectionChanging()
  const error = read(connectionErrorAtom)
  const networkError = read(authorizationNetworkErrorAtom)
  const challenge = read(challengeAtom)
  const polling = read(authorizationPollingAtom)
  const settingsError = read(settingsErrorAtom)
  const connection = status.connection
  const personal = connection?.state === 'connected' || connection?.state === 'choose_space'
  const choosing = personal && (connection.state === 'choose_space' || read(pickerOpenAtom))
  return (
    <Stack gap="sm">
      <Row gap="sm" justify="between" align="center" wrap>
        <Box grow shrink>
          <Heading level={2}><Text truncate>{status.configured ? `飞书项目 · ${connection?.spaceName ?? status.projectKey}` : '飞书项目'}</Text></Heading>
        </Box>
        <Row gap="xs" wrap>
          {personal && connection.state === 'connected' && challenge === null ? (
            <Button size="sm" variant="outline" disabled={busy} onPress={() => togglePicker()}>{choosing ? '关闭空间选择' : '切换空间'}</Button>
          ) : null}
          {!settingsView ? <Button size="sm" variant="ghost" icon="settings" disabled={busy} onPress={() => openIntegrationSettings()}>集成设置</Button> : null}
        </Row>
      </Row>
      {challenge !== null ? (
        <Callout tone="neutral" title={polling ? '等待飞书授权' : '授权页已准备好'}>
          <Stack gap="sm">
            <Text size="sm">{polling ? '在浏览器中完成授权后，Orca 会继续。' : '在浏览器中登录飞书并确认授权。'}</Text>
            {challenge.userCode ? <Text size="sm" muted>{`如需输入设备验证码，请使用 ${challenge.userCode}`}</Text> : null}
            <Row gap="xs" wrap>
              <Button size="sm" icon="open-external" disabled={busy} onPress={() => openAuthorization(challenge, refresh)}>
                {polling ? '打开授权页' : '在浏览器授权'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => cancelAuthorization(refresh)}>取消授权</Button>
            </Row>
          </Stack>
        </Callout>
      ) : personal ? (
        settingsView ? (
          <Box gap="xs" padding="sm" border radius="md" background="muted">
            <Heading level={3}>连接管理</Heading>
            <Text size="sm">{connection.accountName ?? '已连接飞书账号'}</Text>
            <Row gap="xs" wrap>
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => beginAuthorization()}>重新授权</Button>
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => disconnect(refresh)}>断开连接</Button>
            </Row>
          </Box>
        ) : (
          <Collapsible title="连接管理" description={connection.accountName}>
            <Row gap="xs" wrap>
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => beginAuthorization()}>重新授权</Button>
              <Button size="sm" variant="ghost" disabled={busy} onPress={() => disconnect(refresh)}>断开连接</Button>
            </Row>
          </Collapsible>
        )
      ) : status.configured ? (
        <Row gap="xs" wrap>
          <Text size="sm" muted>企业插件连接</Text>
          <Button size="sm" variant="ghost" disabled={busy} onPress={() => beginAuthorization()}>连接飞书账号</Button>
        </Row>
      ) : (
        <Card title="连接你的飞书项目空间">
          <Stack gap="sm">
            <Text size="sm" muted>用飞书账号授权，即可浏览你能访问的空间、查找工作项并关联 Orca 工作区。</Text>
            <Row justify="start">
              <Button icon="plug" disabled={busy} onPress={() => beginAuthorization()}>{busy ? '正在准备…' : '连接飞书项目'}</Button>
            </Row>
          </Stack>
        </Card>
      )}
      {error !== null ? <Callout tone="danger" title="连接失败"><Text size="sm">{error}</Text></Callout> : null}
      {settingsError !== null ? <Callout tone="danger" title="无法打开集成设置"><Text size="sm">{settingsError}</Text></Callout> : null}
      {networkError !== null ? <Callout tone="warning" title="正在重试授权检查"><Text size="sm">{networkError}</Text></Callout> : null}
      {challenge === null && choosing ? <SpacePicker refresh={refresh} busy={busy} currentKey={status.projectKey} /> : null}
      {challenge === null && !personal ? <AdvancedConnection status={status} refresh={refresh} busy={busy} /> : null}
    </Stack>
  )
}
