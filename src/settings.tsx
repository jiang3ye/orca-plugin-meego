import { atom, Button, Callout, Skeleton, Stack, Text, plugin, read, set, type PanelContext } from 'orca'
import type { MeegoStatus } from './protocol'
import { ConnectionPanel, disposeConnection, loadSpaces, resetConnectionInputs, resumeAuthorization } from './panel-connection'

// This settings frame owns its status and request lifetime independently of the sidebar.
const statusAtom = atom<MeegoStatus | null>(null)
const loadingAtom = atom(false)
const errorAtom = atom<string | null>(null)
let requestGeneration = 0

async function refresh(): Promise<void> {
  const request = ++requestGeneration
  set(loadingAtom, true)
  set(errorAtom, null)
  try {
    const status = await plugin.request('meego.status')
    if (request !== requestGeneration) return
    const previous = read(statusAtom)
    set(statusAtom, status)
    resumeAuthorization(status.authorization, refresh)
    if (status.connection?.state === 'choose_space') {
      const selected = await loadSpaces(1, previous?.connection?.state !== 'choose_space')
      if (selected && request === requestGeneration) await refresh()
    }
  } catch (error) {
    if (request === requestGeneration) set(errorAtom, error instanceof Error ? error.message : String(error))
  } finally {
    if (request === requestGeneration) set(loadingAtom, false)
  }
}

export let initialLoad: Promise<void> = Promise.resolve()

export function setup(context: PanelContext): void {
  context.subscriptions.push(plugin.on('meego.connectionChanged', () => {
    resetConnectionInputs()
    void refresh()
  }))
  context.subscriptions.push({ dispose() {
    requestGeneration += 1
    disposeConnection()
  } })
  initialLoad = refresh()
}

export default function Settings() {
  const status = read(statusAtom)
  const loading = read(loadingAtom)
  const error = read(errorAtom)
  return (
    <Stack gap="md">
      {status === null && loading ? <Skeleton shape="text" lines={3} label="正在读取飞书项目连接" /> : null}
      {error !== null ? (
        <Callout tone="danger" title="加载连接设置失败">
          <Stack gap="xs">
            <Text size="sm">{error}</Text>
            <Button size="sm" variant="outline" disabled={loading} onPress={() => refresh()}>重试连接设置</Button>
          </Stack>
        </Callout>
      ) : null}
      {status !== null ? <ConnectionPanel status={status} refresh={refresh} disabled={loading} settingsView /> : null}
    </Stack>
  )
}
