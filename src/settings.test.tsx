import { assert, mockHost, mount, test } from 'orca/testing'
import * as settings from './settings'
import { ConnectionPanel, disposeConnection } from './panel-connection'
import type { AuthorizationChallenge, MeegoStatus } from './protocol'

const disconnected: MeegoStatus = {
  configured: false, baseUrl: 'https://project.feishu.cn', projectKey: '', userKey: '', missing: [],
  connection: { state: 'disconnected' }
}
const connected: MeegoStatus = {
  ...disconnected, configured: true, projectKey: 'dev', userKey: 'member',
  connection: { state: 'connected', accountName: '测试账号', spaceName: '研发空间' }
}

test('settings authorizes and selects a space through the connection contract without querying work items or workspaces', async () => {
  let state: 'disconnected' | 'choose_space' | 'connected' = 'disconnected'
  let challenge: AuthorizationChallenge | undefined
  let accountName = '测试账号'
  const requests: string[] = []
  const url = 'https://project.feishu.cn/b/auth/mcp?usercode=SETTINGS'
  const host = mockHost({
    results: { 'shell.openExternal': { opened: true } },
    requests: {
      'meego.status': (): MeegoStatus => {
        requests.push('status')
        return state === 'connected' ? { ...connected, connection: { state: 'connected', spaceName: connected.connection?.spaceName, accountName } }
          : { ...disconnected, connection: { state, ...(state === 'choose_space' ? { accountName } : {}) }, ...(challenge ? { authorization: challenge } : {}) }
      },
      'meego.beginAuthorization': (input: unknown) => {
        assert.equal(input, undefined)
        requests.push('beginAuthorization')
        challenge = { url, userCode: 'SETTINGS', expiresAt: Date.now() + 60_000, intervalMs: 1 }
        return challenge
      },
      'meego.pollAuthorization': (input: unknown) => {
        assert.equal(input, undefined)
        requests.push('pollAuthorization')
        challenge = undefined
        state = 'choose_space'
        return { state: 'authorized' }
      },
      'meego.listSpaces': (input: unknown) => {
        assert.deepEqual(input, { page: 1 })
        requests.push('listSpaces')
        return { spaces: [{ key: 'dev', name: '研发空间' }, { key: 'ops', name: '运营空间' }], hasMore: false }
      },
      'meego.selectSpace': (input: unknown) => {
        assert.deepEqual(input, { key: 'dev' })
        requests.push('selectSpace')
        state = 'connected'
        return { ok: true }
      },
      'meego.listTypes': () => { requests.push('listTypes'); throw new Error('Settings must not query types') },
      'meego.listWorkItems': () => { requests.push('listWorkItems'); throw new Error('Settings must not query items') },
      'meego.workspaceContext': () => { requests.push('workspaceContext'); throw new Error('Settings must not query workspace context') }
    }
  })
  const view = await mount(settings, { host })
  try {
    await settings.initialLoad
    await view.press({ text: '连接飞书项目' })
    assert.deepEqual(host.callsOf('shell.openExternal'), [])
    await view.press({ text: '在浏览器授权' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await view.settled()
    await view.press({ type: 'ListItem', label: '研发空间' })
    assert.notEqual(view.find({ text: '断开连接' }), null)
    assert.equal(view.find({ text: '集成设置' }), null)
    assert.equal(view.find({ label: '工作项列表' }), null)
    assert.equal(view.find({ text: '交给 Agent' }), null)
    assert.equal(view.find({ text: '当前工作区' }), null)
    accountName = '更新后的账号名'
    await view.post('meego.connectionChanged', { reason: 'authorized' })
    assert.notEqual(view.find({ text: accountName }), null)
    assert.deepEqual(requests, ['status', 'beginAuthorization', 'pollAuthorization', 'status', 'listSpaces', 'selectSpace', 'status', 'status'])
    assert.deepEqual(host.callsOf('shell.openExternal'), [{ url }])
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }
})

test('connection settings retry a failed read and the sidebar shortcut opens settings through the worker with visible errors', async () => {
  let unavailable = true
  const view = await mount(settings, { host: mockHost({ requests: {
    'meego.status': () => {
      if (unavailable) throw new Error('状态暂不可用')
      return connected
    }
  } }) })
  try {
    await settings.initialLoad
    assert.notEqual(view.find({ text: '状态暂不可用' }), null)
    unavailable = false
    await view.press({ text: '重试连接设置' })
    assert.notEqual(view.find({ text: '重新授权' }), null)
    assert.equal(view.find({ text: '状态暂不可用' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
  }

  let opens = 0
  const host = mockHost({ requests: {
    'meego.openSettings': (input: unknown) => {
      assert.equal(input, undefined)
      opens += 1
      if (opens === 1) throw new Error('设置页暂不可用')
      return { opened: true }
    }
  } })
  const sidebar = await mount({
    setup: () => disposeConnection,
    default: () => <ConnectionPanel status={connected} refresh={async () => {}} disabled={false} />
  }, { host })
  try {
    await sidebar.press({ text: '集成设置' })
    assert.notEqual(sidebar.find({ text: '设置页暂不可用' }), null)
    await sidebar.press({ text: '集成设置' })
    assert.equal(opens, 2)
    assert.equal(sidebar.find({ text: '设置页暂不可用' }), null)
    assert.deepEqual(host.callsOf('shell.openExternal'), [])
    assert.deepEqual(sidebar.errors, [])
    assert.deepEqual(sidebar.refusals, [])
  } finally {
    await sidebar.unmount()
  }
})
