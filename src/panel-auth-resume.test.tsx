import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { AuthorizationChallenge, AuthorizationStatus, MeegoStatus, WorkspaceContextInfo } from './protocol'

test('a reopened panel resumes the current device grant after a transient network error', async () => {
  const baseUrl = 'https://project.feishu.cn'
  const url = `${baseUrl}/b/auth/mcp?mode=device&usercode=DEMO-CODE`
  const networkMessage = '飞书项目授权服务暂时不可用，请稍后重试。'
  let challenge: AuthorizationChallenge | undefined
  let beginCalls = 0
  let pollCalls = 0
  let authorized = false
  let completeInBrowser = false
  const host = mockHost({
    results: { 'shell.openExternal': { opened: true } },
    requests: {
      'meego.status': (): MeegoStatus => ({
        configured: false, baseUrl, projectKey: '', userKey: authorized ? 'member' : '', missing: [],
        connection: authorized ? { state: 'choose_space', accountName: '测试账号' } : { state: 'disconnected' },
        ...(challenge ? { authorization: challenge } : {})
      }),
      'meego.beginAuthorization': () => {
        beginCalls += 1
        challenge = {
          url,
          userCode: 'DEMO-CODE', expiresAt: Date.now() + 60_000, intervalMs: 1
        }
        return challenge
      },
      'meego.pollAuthorization': (): AuthorizationStatus => {
        pollCalls += 1
        if (pollCalls === 1) return { state: 'network_error', message: networkMessage }
        if (!completeInBrowser) return { state: 'waiting', intervalMs: 10 }
        authorized = true
        challenge = undefined
        return { state: 'authorized' }
      },
      'meego.listSpaces': () => ({ spaces: [{ key: 'dev', name: '研发空间' }, { key: 'delivery', name: '交付空间' }], hasMore: false }),
      'meego.workspaceContext': (): WorkspaceContextInfo => ({
        workspaceId: null, displayName: null, branch: null, link: null, branchChanged: false, agents: []
      })
    }
  })
  const first = await mount(panel, { host })
  try {
    await panel.initialLoad
    await first.press({ text: '连接飞书项目' })
    assert.notEqual(first.find({ text: '在浏览器授权' }), null)
    await first.press({ text: '在浏览器授权' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await first.settled()
    assert.notEqual(first.find({ text: networkMessage }), null)
    assert.notEqual(first.find({ text: '取消授权' }), null)
  } finally {
    await first.unmount()
  }

  const reopened = await mount(panel, { host })
  try {
    await panel.initialLoad
    assert.notEqual(reopened.find({ text: '取消授权' }), null)
    assert.notEqual(reopened.find({ text: '如需输入设备验证码，请使用 DEMO-CODE' }), null)
    completeInBrowser = true
    await new Promise((resolve) => setTimeout(resolve, 30))
    await reopened.settled()
    assert.notEqual(reopened.find({ text: '研发空间' }), null)
    assert.equal(reopened.find({ text: '取消授权' }), null)
    assert.equal(beginCalls, 1)
    assert.deepEqual(host.callsOf('shell.openExternal'), [{ url }])
    assert.deepEqual(reopened.errors, [])
    assert.deepEqual(reopened.refusals, [])
  } finally {
    await reopened.unmount()
  }
})
