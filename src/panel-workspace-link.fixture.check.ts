import { defineCheck, hostError } from 'orca/testing'
import { fixtureDirectories, fixtureLinked } from './panel-workspace-link.fixture.tsx'

export default defineCheck({
  workspacePicker: { requests: {
    'meego.workspaceOptions': () => ({ workspaces: fixtureDirectories, truncated: false, activeWorkspaceId: null })
  } },
  workspaceLinked: { requests: {
    'meego.workspaceOptions': () => ({ workspaces: fixtureDirectories.map((row) => ({ ...row, linkedToItem: row.id === 'workspace-site' })), truncated: false, activeWorkspaceId: null }),
    'meego.workspaceContext': () => fixtureLinked
  } },
  workspaceEmpty: { requests: {
    'meego.workspaceOptions': () => ({ workspaces: [], truncated: false, activeWorkspaceId: null })
  } },
  workspaceError: { requests: {
    'meego.workspaceOptions': () => { throw hostError('unavailable', '无法读取代码目录，请检查 Orca 项目列表后重试。') }
  } }
})
