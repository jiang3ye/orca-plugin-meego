import type { WorkItemDetail, WorkspaceContextInfo, WorkspaceOption } from './protocol'
import { setWorkspaceLinkItem, WorkspaceLinkPanel } from './panel-workspace-link'

export const fixtureItem: WorkItemDetail = {
  id: 6801, typeKey: 'story', name: '实现账号登录', status: '开发中', statusState: 'in_progress', ownerKeys: [], ownerNames: [],
  updatedAt: 1000, description: '', fields: [], source: { baseUrl: 'https://project.feishu.cn', projectKey: 'demo' },
  url: 'https://project.feishu.cn/demo/story/detail/6801'
}
export const fixtureDirectories: WorkspaceOption[] = [
  { id: 'workspace-site', name: '登录开发', kind: 'worktree', project: '网站', path: '/code/customer-portal/features/account-authentication', branch: 'feat/account-login', hostId: 'local' },
  { id: 'workspace-api', name: '账号接口', kind: 'worktree', project: 'API 服务', path: '/srv/code/account-api', branch: 'feat/account-api', hostId: 'ssh:fixture-host' }
]
export const fixtureLinked: WorkspaceContextInfo = {
  workspaceId: 'workspace-site', workspaceResolution: 'resolved', displayName: '登录开发', project: '网站', path: '/code/customer-portal/features/account-authentication',
  branch: 'feat/account-login', hostId: 'local', isActive: false, agents: [], branchChanged: false,
  link: { workItemId: 6801, typeKey: 'story', name: '实现账号登录', status: '开发中', source: fixtureItem.source, accountKey: 'fixture-user',
    url: fixtureItem.url, branch: 'feat/account-login', linkedAt: 1000 }
}

export async function setup() {
  await setWorkspaceLinkItem(fixtureItem, 'fixture-user')
  return () => { setWorkspaceLinkItem() }
}

export default function WorkspaceLinkFixture() {
  return <WorkspaceLinkPanel onError={async () => {}} />
}
