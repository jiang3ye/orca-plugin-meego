import { defineCheck } from 'orca/testing'
import type { MeegoStatus } from './protocol'

const disconnected: MeegoStatus = {
  configured: false, baseUrl: 'https://project.feishu.cn', projectKey: '', userKey: '', missing: [],
  connection: { state: 'disconnected' }
}

const connected: MeegoStatus = {
  ...disconnected, configured: true, projectKey: 'demo', userKey: 'dev_user',
  connection: { state: 'connected', accountName: '张三', spaceName: '产品研发' }
}

export default defineCheck({
  disconnected: { requests: { 'meego.status': () => disconnected } },
  connected: { requests: { 'meego.status': () => connected } },
  spaces: { requests: {
    'meego.status': () => ({ ...disconnected, connection: { state: 'choose_space', accountName: '张三' } }),
    'meego.listSpaces': () => ({ spaces: [{ key: 'demo', name: '产品研发' }, { key: 'delivery', name: '交付团队' }], hasMore: false })
  } },
  waitingAuthorization: { requests: {
    'meego.status': () => ({ ...disconnected, authorization: {
      url: 'https://project.feishu.cn/b/auth/mcp?mode=device&usercode=DEMO-CODE',
      userCode: 'DEMO-CODE', expiresAt: Date.now() + 60_000, intervalMs: 5_000
    } }),
    'meego.pollAuthorization': () => ({ state: 'waiting', intervalMs: 5_000 })
  } },
  unavailable: { requests: { 'meego.status': () => { throw new Error('暂时无法读取连接，请稍后重试。') } } }
})
