import type { JsonValue } from 'orca/host'

/** Match Orca's JSON storage boundary, omitting absent optional properties. */
export function storageJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value))
}
