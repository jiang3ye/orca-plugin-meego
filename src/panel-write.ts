// Allow the worker to finish authorization, metadata reads and the write before the panel times out.
export const WRITE_REQUEST_OPTIONS = { timeoutMs: 90_000 }

export function writeResponseLost(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  // Orca can lose a worker or time out while waiting for a dispatched write.
  return error.code === 'timeout' || error.code === 'unavailable'
}
