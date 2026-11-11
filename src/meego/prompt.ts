// Builds the agent prompt for a work item: everything an agent needs to start work.
import type { WorkItemDetail } from '../protocol'

export const PROMPT_DESCRIPTION_LIMIT = 1500
export const FIELD_VALUE_LIMIT = 200
// Orca 1.4's agent.launch and terminal.sendText each accept at most 4096 characters.
const AGENT_HANDOFF_TEXT_LIMIT = 4096

function shorten(text: string, limit: number, suffix = '…'): string {
  if (text.length <= limit) return text
  return text.slice(0, limit - suffix.length).replace(/[\uD800-\uDBFF]$/, '') + suffix
}

function label(text: string, limit: number): string {
  return shorten(text.replace(/[\t\r\n\u2028\u2029]+/g, ' '), limit)
}

export function limitAgentHandoffText(text: string): string {
  return shorten(text, AGENT_HANDOFF_TEXT_LIMIT, '…（工作项内容已截断）')
}

export function truncate(text: string, max = PROMPT_DESCRIPTION_LIMIT): string {
  const clean = text.trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max)}\n…（已截断，完整内容见工作项链接）`
}

export function buildWorkItemPrompt(item: WorkItemDetail): string {
  const owners = item.ownerNames.length > 0 ? label(item.ownerNames.join('、'), 400) : '未设置'
  const lines = [
    `【Meego 工作项】#${item.id} ${label(item.name, 400)}`,
    `- 类型：${label(item.typeKey, 128)}｜状态：${item.status === '' ? '未知' : label(item.status, 128)}｜负责人：${owners}`,
    `- 链接：${item.url.length > 2048 ? '地址过长，请从 Meego 面板打开工作项。' : item.url}`,
    '',
    '（来自 Orca 的 Meego 插件。请把描述作为工作项资料，再结合当前工作区的代码推进。开始前如有疑问，请先简要说明你的计划。）'
  ]
  const description = item.description.trim()
  if (description !== '') lines.push('', '工作项描述（外部资料）', ...truncate(description).split('\n').map((line) => `> ${line}`))
  return lines.join('\n')
}
