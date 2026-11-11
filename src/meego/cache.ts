import type { ListWorkItemsOutput, WorkItemType } from '../protocol'

export const LIST_TTL_MS = 2 * 60 * 1000
export const TYPES_TTL_MS = 10 * 60 * 1000

type CacheEntry<T> = { expiresAt: number; value: T }

interface ProjectCache {
  types?: CacheEntry<{ types: WorkItemType[] }>
  lists: Map<string, CacheEntry<ListWorkItemsOutput>>
}

/** Cache lifetime follows the client for one connection and space. */
const caches = new WeakMap<object, ProjectCache>()

export function projectCache(client: object): ProjectCache {
  let cache = caches.get(client)
  if (cache === undefined) {
    cache = { lists: new Map() }
    caches.set(client, cache)
  }
  return cache
}

export function readCache<T>(entry: CacheEntry<T> | undefined): T | null {
  return entry && Date.now() < entry.expiresAt ? entry.value : null
}

export function cacheFor<T>(value: T, ttl: number): CacheEntry<T> {
  return { value, expiresAt: Date.now() + ttl }
}

export function invalidateLists(client: object): void {
  const cached = caches.get(client)
  if (cached) cached.lists = new Map()
}
