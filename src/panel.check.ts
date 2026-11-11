// Stable render fixtures. The fresh screen uses the real worker with no credentials;
// data states stub only the requests they need, so check never contacts Feishu.
import { defineCheck } from 'orca/testing'
import type { MeegoStatus, WorkspaceContextInfo, WorkItemId, WorkItemSummary } from './protocol'

const baseUrl = 'https://project.feishu.cn'
const types = [{ key: 'story', name: '需求' }, { key: 'task', name: '任务' }, { key: 'issue', name: '缺陷' }]
const disconnectedWorkspace: WorkspaceContextInfo = {
  workspaceId: null, displayName: null, branch: null, link: null, branchChanged: false, agents: []
}

const connected: MeegoStatus = {
  configured: true,
  baseUrl,
  projectKey: 'demo',
  userKey: 'dev_user',
  missing: [],
  connection: { state: 'connected', accountName: '张三', spaceName: '产品研发' }
}

function summary(id: WorkItemId, name: string, status: string, statusState: WorkItemSummary['statusState'], owner: string | null, ageMs: number): WorkItemSummary {
  return {
    id,
    typeKey: 'story',
    name,
    status,
    statusState,
    ownerKeys: owner === null ? [] : [owner],
    ownerNames: owner === null ? [] : [owner],
    updatedAt: Date.now() - ageMs
  }
}

const items = [
  summary(6801, '实现登录', '开发中', 'in_progress', '张三', 60_000),
  summary(6802, '修复登出死循环', '已完成', 'done', null, 3 * 3600_000),
  summary(6803, '登录页性能优化', '待评审', 'in_progress', '李四', 26 * 3600_000)
]

function listRequests(workItems: WorkItemSummary[]) {
  return {
    'meego.status': () => connected,
    'meego.listTypes': () => ({ types }),
    'meego.listWorkItems': () => ({
      items: workItems,
      total: workItems.length,
      page: 1,
      hasMore: false,
      fromCache: false
    }),
    'meego.workspaceContext': () => disconnectedWorkspace
  }
}

export default defineCheck({
  fresh: {},
  waitingAuthorization: {
    requests: {
      'meego.status': (): MeegoStatus => ({
        configured: false, baseUrl, projectKey: '', userKey: '', missing: [],
        connection: { state: 'disconnected' },
        authorization: {
          url: `${baseUrl}/b/auth/mcp?mode=device&usercode=DEMO-CODE`,
          userCode: 'DEMO-CODE', expiresAt: Date.now() + 60_000, intervalMs: 5_000
        }
      }),
      'meego.pollAuthorization': () => ({ state: 'waiting', intervalMs: 5_000 }),
      'meego.workspaceContext': () => disconnectedWorkspace
    }
  },
  spaces: {
    requests: {
      'meego.status': (): MeegoStatus => ({
        ...connected,
        configured: false,
        projectKey: '',
        connection: { state: 'choose_space', accountName: '张三' }
      }),
      'meego.listSpaces': () => ({
        spaces: [{ key: 'demo', name: '产品研发' }, { key: 'delivery', name: '交付团队' }],
        hasMore: false
      }),
      'meego.workspaceContext': () => disconnectedWorkspace
    }
  },
  empty: { requests: listRequests([]) },
  wideIds: { requests: listRequests([summary('9007199254740993', '核对工作项详情', '开发中', 'in_progress', '张三', 60_000)]) },
  list: {
    requests: {
      ...listRequests(items),
      'meego.workspaceContext': (): WorkspaceContextInfo => ({
        workspaceId: 'workspace-1',
        displayName: '项目插件',
        branch: 'feat/account',
        link: {
          workItemId: 6801, typeKey: 'story', name: '实现登录', status: '开发中',
          branch: 'feat/account', linkedAt: Date.now(), url: `${baseUrl}/demo/story/detail/6801`,
          source: { baseUrl, projectKey: 'demo' }
        },
        branchChanged: false,
        agents: []
      })
    }
  }
})
