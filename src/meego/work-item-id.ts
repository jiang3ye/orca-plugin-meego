import type { WorkItemId } from '../protocol'

const INT64_MAX = '9223372036854775807'

export function parseWorkItemId(value: unknown): WorkItemId | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const digits = value.replace(/^0+/, '')
  if (!digits || digits.length > INT64_MAX.length || (digits.length === INT64_MAX.length && digits > INT64_MAX)) return null
  const number = Number(digits)
  return Number.isSafeInteger(number) ? number : digits
}

export function sameWorkItemId(left: WorkItemId, right: WorkItemId): boolean {
  const id = parseWorkItemId(left)
  return id !== null && id === parseWorkItemId(right)
}

/** Preserve integer literals even on Node 20, whose JSON reviver has no source argument. */
export function parseMeegoJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  if (!/\d{16}/.test(text)) return parsed
  // Validate before rewriting, then skip complete quoted tokens and non-integer numbers.
  const quoted = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (token) =>
    /^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token)) ? `"${token}"` : token
  )
  return quoted === text ? parsed : JSON.parse(quoted)
}
