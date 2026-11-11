// Reads the plugin's settings and secrets into one validated config object.
import type { OrcaWorkerApi } from 'orca/worker'
import type { MissingConfigItem, WorkItemId, WorkItemSource } from '../protocol'
import { oauthOrigin } from './oauth'
import { parseWorkItemId, sameWorkItemId } from './work-item-id'

export const SETTING_KEYS = {
  baseUrl: 'base_url',
  projectKey: 'project_key',
  userKey: 'user_key',
  agentCommand: 'agent_command',
  webUrlTemplate: 'web_url_template'
} as const

export const SECRET_KEYS = {
  pluginId: 'meego_plugin_id',
  pluginSecret: 'meego_plugin_secret',
  credentials: 'meego_plugin_credentials'
} as const

export const DEFAULT_BASE_URL = 'https://project.feishu.cn'
export const DEFAULT_AGENT_COMMAND = 'claude'
export const DEFAULT_WEB_URL_TEMPLATE =
  'https://project.feishu.cn/work_item/detail/{project_key}/{work_item_type_key}/{work_item_id}'

export interface MeegoConfig extends WorkItemSource {
  userKey: string
  pluginId: string
  pluginSecret: string
  agentCommand: string
  webUrlTemplate: string
  spaceSlug?: string
  spaceName?: string
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

export async function loadMeegoConfig(orca: OrcaWorkerApi): Promise<MeegoConfig> {
  const settings = await orca.settings.get()
  const baseUrl = normalizeBaseUrl(asString(settings[SETTING_KEYS.baseUrl], DEFAULT_BASE_URL))
  const saved = await orca.secrets.get(SECRET_KEYS.credentials)
  const { pluginId, pluginSecret } = saved === null && baseUrl === DEFAULT_BASE_URL ? {
    pluginId: (await orca.secrets.get(SECRET_KEYS.pluginId)) ?? '',
    pluginSecret: (await orca.secrets.get(SECRET_KEYS.pluginSecret)) ?? ''
  } : readCredentials(saved, baseUrl)
  return {
    baseUrl,
    projectKey: asString(settings[SETTING_KEYS.projectKey]),
    userKey: asString(settings[SETTING_KEYS.userKey]),
    pluginId: pluginId.trim(),
    pluginSecret: pluginSecret.trim(),
    agentCommand: asString(settings[SETTING_KEYS.agentCommand], DEFAULT_AGENT_COMMAND),
    webUrlTemplate: asString(settings[SETTING_KEYS.webUrlTemplate], DEFAULT_WEB_URL_TEMPLATE)
  }
}

function readCredentials(saved: string | null, baseUrl: string): { pluginId: string; pluginSecret: string } {
  try {
    const value = saved === null ? null : JSON.parse(saved)
    if (value?.baseUrl === baseUrl) return { pluginId: asString(value.pluginId), pluginSecret: asString(value.pluginSecret) }
  } catch {
    // A damaged or outdated credential record needs explicit configuration.
  }
  return { pluginId: '', pluginSecret: '' }
}

export function missingConfigItems(config: MeegoConfig): MissingConfigItem[] {
  const missing: MissingConfigItem[] = []
  if (config.pluginId === '') missing.push({ key: SECRET_KEYS.pluginId, label: 'Plugin ID' })
  if (config.pluginSecret === '') missing.push({ key: SECRET_KEYS.pluginSecret, label: 'Plugin Secret' })
  if (config.projectKey === '') missing.push({ key: SETTING_KEYS.projectKey, label: 'Project Key' })
  if (config.userKey === '') missing.push({ key: SETTING_KEYS.userKey, label: 'User Key' })
  return missing
}

/** Builds the browser URL of a work item from the configurable template. */
export function buildWorkItemUrl(config: MeegoConfig, item: { id: WorkItemId; typeKey: string }): string {
  const base = httpsUrl(config.baseUrl)
  if (base === null) return ''
  if (config.spaceSlug) {
    return httpsUrl(`${base.origin}/${encodeURIComponent(config.spaceSlug)}/${encodeURIComponent(item.typeKey)}/detail/${item.id}`)?.href ?? ''
  }
  const template = config.webUrlTemplate === DEFAULT_WEB_URL_TEMPLATE
    ? DEFAULT_WEB_URL_TEMPLATE.replace(DEFAULT_BASE_URL, base.origin) : config.webUrlTemplate
  const url = template
    .replaceAll('{project_key}', encodeURIComponent(config.projectKey))
    .replaceAll('{work_item_type_key}', encodeURIComponent(item.typeKey))
    .replaceAll('{work_item_id}', String(item.id))
  return httpsUrl(url)?.href ?? ''
}

function httpsUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

export function safeWorkItemUrl(value: string, baseUrl: string): string | null {
  try {
    const url = httpsUrl(value)
    if (url === null || !sameMeegoOrigin(url.origin, baseUrl)) return null
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

export function sameMeegoOrigin(origin: string, baseUrl: string): boolean {
  const target = new URL(baseUrl).origin
  const official = oauthOrigin(origin)
  return origin === target || (official !== null && official === oauthOrigin(target))
}

export function parseWorkItemLink(value: string, baseUrl: string) {
  const url = safeWorkItemUrl(value.trim(), baseUrl)
  if (url === null) return null
  const path = new URL(url).pathname
  const canonical = /^\/(?:meego\/)?([^/]+)\/([^/]+)\/detail\/([1-9]\d*)\/?$/.exec(path)
  const legacy = /^\/work_item\/detail\/([^/]+)\/([^/]+)\/([1-9]\d*)\/?$/.exec(path)
  const match = canonical ?? legacy
  if (match === null) return null
  try {
    const space = decodeURIComponent(match[1])
    const typeSegment = decodeURIComponent(match[2])
    const typeKey = canonical !== null ? /^_(.+)_resource$/.exec(typeSegment)?.[1] ?? typeSegment : typeSegment
    const id = parseWorkItemId(match[3])
    const isSegment = (segment: string) => segment !== '.' && segment !== '..' && /^[\p{L}\p{N}_.~-]+$/u.test(segment)
    if (id === null || !isSegment(space) || !isSegment(typeKey) || typeKey === 'chart') return null
    return { space, typeKey, id, url, canonical: canonical !== null }
  } catch {
    return null
  }
}

export function verifiedWorkItemUrl(value: string | undefined, source: WorkItemSource & { spaceSlug?: string }, item: { id: WorkItemId; typeKey: string }): string | null {
  if (!value) return null
  const parsed = parseWorkItemLink(value, source.baseUrl)
  if (parsed === null || !sameWorkItemId(parsed.id, item.id) || parsed.typeKey !== item.typeKey) return null
  const expectedSpace = parsed.canonical ? source.spaceSlug : source.projectKey
  return expectedSpace === undefined || parsed.space === expectedSpace ? parsed.url : null
}
