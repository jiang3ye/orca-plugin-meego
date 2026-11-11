// Lets unit tests swap the network implementation. Orca's worker uses plain Node fetch.
import type { FetchLike } from './client'

let override: FetchLike | null = null

export function setFetch(fetchImpl: FetchLike | null): void {
  override = fetchImpl
}

export function currentFetch(): FetchLike {
  if (override !== null) return override
  return (url, init) => fetch(url, init)
}
