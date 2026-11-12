// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
// Names declared here are typed end to end on `plugin.request`, `plugin.on`,
// `orca.panels.handle`, `orca.panels.post` and the `orca/testing` helpers.

/** Positive int64. Older stored records and small API IDs keep their numeric representation. */
export type WorkItemId = number | string

/** A Meego work item normalized for the panel list. */
export interface WorkItemSummary {
  id: WorkItemId
  typeKey: string
  name: string
  status: string
  statusState: 'unstarted' | 'in_progress' | 'done' | 'blocked' | 'unknown'
  ownerKeys: string[]
  ownerNames: string[]
  updatedAt: number | null
}

/** One field row of a work item detail view. */
export interface WorkItemFieldRow {
  label: string
  value: string
}

export interface WorkItemDetail extends WorkItemSummary {
  workflowMode?: 'state' | 'node'
  url: string
  source?: WorkItemSource
  spaceName?: string
  description: string
  fields: WorkItemFieldRow[]
}

export interface WorkItemType {
  key: string
  name: string
}

export interface WorkItemReference {
  id: WorkItemId
  typeKey: string
  source?: WorkItemSource
  expectedUserKey?: string
}

export interface WorkspaceCreationSource {
  id: string
  name: string
  project?: string | null
  /** Present in official host inventories; older journals may omit it. */
  projectId?: string
  path: string
  branch: string
  hostId: string | null
}

export interface CreatedWorkspaceReceipt {
  workspaceId: string
  name: string
  /** The host receipt may contain only the ID until inventory is available. */
  branch?: string | null
  path?: string
}

/** A durable plan: uncertain outcomes never authorize another create call. */
export interface WorkspaceCreationPlan {
  planId: string
  state: 'ready' | 'uncertain' | 'created' | 'linked'
  name: string
  sources: WorkspaceCreationSource[]
  recoveryWorkspaces: WorkspaceCreationSource[]
  receipt?: CreatedWorkspaceReceipt
  message?: string
}

export interface WorkspaceCreationOperation {
  ref: WorkItemReference
  planId: string
}

type EditCapability = { state: 'available' | 'browserOnly'; reason?: string }

export interface WorkItemEditOptions {
  priority: EditCapability & { currentKey: string | null; options: { key: string; label: string }[] }
  status: EditCapability & { currentKey: string | null; transitions: { id: string; label: string; targetStateKey: string }[] }
  operators: EditCapability & { userKeys: string[]; users: { key: string; name: string }[]; multiple: boolean }
  roles?: EditCapability & { options: { key: string; label: string; userKeys: string[]; users: { key: string; name: string }[] }[] }
  text: { title: EditCapability; description: EditCapability }
}

export type EditWorkItemInput = WorkItemReference & { expectedUpdatedAt: number | null } & (
  | { operation: 'priority'; value: string }
  | { operation: 'status'; transitionId: string }
  | { operation: 'operators'; userKeys: string[] }
  | { operation: 'roleMembers'; roleKey: string; userKeys: string[] }
  | { operation: 'name' | 'description'; value: string }
)

export type EditWorkItemOutput = { state: 'confirmed'; item: WorkItemDetail } | { state: 'unverified' }

export interface WorkItemNode {
  key: string
  name: string
  status: 'not_started' | 'doing' | 'finished' | 'unknown'
  owners: { key: string; name: string }[]
  revision: string
  actions: { confirm: EditCapability; rollback: EditCapability; owners: EditCapability }
}

export interface WorkItemNodeList {
  state: 'available' | 'browserOnly'
  reason?: string
  nodes: WorkItemNode[]
}

export type EditWorkItemNodeInput = WorkItemReference & {
  expectedUpdatedAt: number | null
  nodeKey: string
  expectedRevision: string
} & (
  | { operation: 'confirm' | 'rollback'; reason?: string }
  | { operation: 'owners'; userKeys: string[] }
)

export type EditWorkItemNodeOutput = { state: 'confirmed'; item: WorkItemDetail; nodes: WorkItemNodeList } | { state: 'unverified' }

export interface MissingConfigItem {
  key: string
  label: string
}

/** What `meego.status` answers: is the plugin usable, and what is missing. */
export interface MeegoStatus {
  configured: boolean
  baseUrl: string
  projectKey: string
  userKey: string
  defaultAgent?: string
  missing: MissingConfigItem[]
  authorization?: AuthorizationChallenge
  hasSavedConnection?: boolean
  connection?: { state: 'disconnected' | 'choose_space' | 'connected'; accountName?: string; spaceName?: string; removalPending?: boolean }
}

export interface WorkItemSource {
  baseUrl: string
  projectKey: string
}

export interface MeegoSpace {
  key: string
  name: string
  slug?: string
}

export interface AuthorizationChallenge {
  url: string
  userCode: string
  expiresAt: number
  intervalMs: number
}

export type AuthorizationStatus = { state: 'waiting'; intervalMs: number } | { state: 'authorized' } | { state: 'expired' } | { state: 'network_error'; message: string }

// Orca normalizes thrown error codes, so an uncertain write outcome travels as data.
type UnverifiedWrite = { state: 'unverified' }

/** The focused workspace, its link to a work item, and its running agents. */
export interface WorkspaceContextInfo {
  workspaceId: string | null
  workspaceResolution?: 'resolved' | 'ambiguous' | 'truncated' | 'unavailable'
  displayName: string | null
  branch: string | null
  link: WorkspaceLink | null
  /** The link was made on another branch. */
  branchChanged: boolean
  agents: { terminalId: string | null; title: string | null; agent: string | null; state: string }[]
}

export interface WorkspaceLink {
  workItemId: WorkItemId
  typeKey: string
  name: string
  status: string
  branch: string | null
  linkedAt: number
  /** Browser URL built from the web_url_template setting at link time. */
  url: string
  source?: WorkItemSource
  spaceName?: string
  accountKey?: string
}

export interface ListWorkItemsInput {
  typeKey: string
  source?: WorkItemSource
  expectedUserKey?: string
  search?: string
  onlyMine?: boolean
  statusKeys?: string[]
  page?: number
  /** Skip the short-lived cache and hit the API. */
  force?: boolean
}

export interface ListWorkItemsOutput {
  items: WorkItemSummary[]
  total: number
  page: number
  hasMore: boolean
  fromCache: boolean
}

export interface SendToAgentOutput {
  sent: boolean
  detail: string
}

export interface CreateWorkItemInput {
  typeKey: string
  name: string
  description?: string
  templateId?: string
  fieldValues?: Record<string, string>
  source?: WorkItemSource
  expectedUserKey?: string
}

export interface CreateWorkItemField {
  key: string
  label: string
  kind: 'text' | 'number' | 'boolean' | 'select' | 'date' | 'user' | 'multi-user'
  required: boolean
  options?: { value: string; label: string }[]
}

export interface CreateWorkItemForm {
  templates: { id: string; name: string; isDefault?: boolean }[]
  fields: CreateWorkItemField[]
  unsupportedRequired: string[]
  descriptionRequired?: boolean
  browserUrl?: string
}

export interface WorkItemComment {
  id: string
  author: string
  content: string
  createdAt: number | null
}

export const MAX_COMMENT_LENGTH = 10_000

export interface TestConnectionOutput {
  ok: boolean
  projectKey: string
  userKey: string
  typeCount: number
}

declare module 'orca' {
  interface PluginRequests {
    /** Current configuration health; answers without touching the network. */
    'meego.status': { output: MeegoStatus }
    'meego.beginAuthorization': { output: AuthorizationChallenge }
    'meego.pollAuthorization': { output: AuthorizationStatus }
    'meego.cancelAuthorization': { output: { ok: boolean } }
    'meego.disconnect': { output: { ok: boolean } }
    'meego.removeConnection': { output: { ok: boolean } }
    'meego.listSpaces': { input: { search?: string; page?: number }; output: { spaces: MeegoSpace[]; hasMore: boolean } }
    'meego.selectSpace': { input: { key: string }; output: { ok: boolean } }
    'meego.openWorkItemLink': { input: { url: string; expectedUserKey?: string }; output: { item: WorkItemDetail } }
    /** Stores plugin_id / plugin_secret into the plugin's secrets. */
    'meego.saveCredentials': { input: { pluginId: string; pluginSecret: string }; output: { ok: boolean } }
    /** Fetches a plugin token and lists work item types: proves the credentials work. */
    'meego.testConnection': { output: TestConnectionOutput }
    /** Work item types of the space (cached briefly). */
    'meego.listTypes': { input: { source?: WorkItemSource; expectedUserKey?: string } | undefined; output: { types: WorkItemType[] } }
    /** Work items of one type, optionally filtered; page 1 results are cached for 2 minutes. */
    'meego.listWorkItems': { input: ListWorkItemsInput; output: ListWorkItemsOutput }
    /** One work item with fields, description and browser URL. */
    'meego.getWorkItem': { input: { id: WorkItemId; typeKey: string; source?: WorkItemSource; expectedUserKey?: string }; output: { item: WorkItemDetail } }
    'meego.editOptions': { input: WorkItemReference; output: { options: WorkItemEditOptions } }
    'meego.searchMembers': { input: WorkItemReference & { query: string }; output: { users: { key: string; name: string }[] } }
    'meego.editWorkItem': { input: EditWorkItemInput; output: EditWorkItemOutput }
    'meego.workflowNodes': { input: WorkItemReference; output: WorkItemNodeList }
    'meego.inspectWorkflowNode': { input: WorkItemReference & { nodeKey: string }; output: { node: WorkItemNode } }
    'meego.editWorkflowNode': { input: EditWorkItemNodeInput; output: EditWorkItemNodeOutput }
    'meego.statusOptions': { input: { typeKey: string; source?: WorkItemSource; expectedUserKey?: string }; output: { options: { key: string; label: string }[]; canCombinePersonal: boolean } }
    'meego.listComments': { input: { id: WorkItemId; typeKey: string; source?: WorkItemSource; expectedUserKey?: string; page?: number; cursor?: string }; output: { comments: WorkItemComment[]; hasMore: boolean; nextCursor?: string } }
    /** Adds a Markdown comment. */
    'meego.addComment': { input: { id: WorkItemId; typeKey: string; content: string; source?: WorkItemSource; expectedUserKey?: string }; output: { ok: true } | UnverifiedWrite }
    'meego.createForm': { input: { typeKey: string; source?: WorkItemSource; expectedUserKey?: string }; output: { form: CreateWorkItemForm } }
    /** Creates a work item with the fields supported by its connection. */
    'meego.createWorkItem': { input: CreateWorkItemInput; output: { item: WorkItemSummary } | { state: 'confirmed' } | UnverifiedWrite }
    /** The focused workspace, its work item link and running agents. */
    'meego.workspaceContext': { output: WorkspaceContextInfo }
    'meego.agentChoices': { input: { workspaceId: string }; output: { agents: { id: string; label: string }[]; defaultAgent?: string } }
    'meego.openSettings': { output: { opened: boolean } }
    'meego.workspaceCreationPlan': { input: WorkItemReference; output: WorkspaceCreationPlan }
    'meego.createWorkspace': { input: WorkspaceCreationOperation & { sourceWorkspaceId: string; name: string }; output: WorkspaceCreationPlan }
    'meego.retryCreatedWorkspaceLink': { input: WorkspaceCreationOperation; output: WorkspaceCreationPlan }
    'meego.recoverCreatedWorkspace': { input: WorkspaceCreationOperation & { workspaceId: string }; output: WorkspaceCreationPlan }
    'meego.confirmWorkspaceNotCreated': { input: WorkspaceCreationOperation; output: WorkspaceCreationPlan }
    'meego.openCreatedWorkspace': { input: WorkspaceCreationOperation; output: { opened: true } }
    /** Links the focused workspace to a work item. */
    'meego.linkWorkspace': { input: { workItemId: WorkItemId; typeKey: string; name: string; status?: string; source?: WorkItemSource; url?: string; workspaceId?: string; expectedUserKey?: string; expectedLinkedAt?: number | null }; output: { ok: boolean } }
    /** Removes the focused workspace's link. */
    'meego.unlinkWorkspace': { input: { workspaceId?: string; expectedLinkedAt?: number | null } | undefined; output: { ok: boolean } }
    /** A terminal ID selects an agent. Null explicitly requests a new one. Omission uses automatic selection. */
    'meego.sendToAgent': { input: { id: WorkItemId; typeKey: string; source?: WorkItemSource; workspaceId?: string; terminalId?: string | null; agent?: string; linked?: boolean; expectedUserKey?: string; expectedLinkedAt?: number | null }; output: SendToAgentOutput }
  }
  interface PluginPanelEvents {
    'meego.connectionChanged': { reason: 'authorized' | 'disconnected' | 'space' | 'enterprise' | 'removed' | 'configuration' }
    /** The focused workspace's link changed (linked, unlinked, or the workspace moved). */
    'meego.linkChanged': { workspaceId: string | null }
  }
}
