// Only Node primitives missing from the generated Orca authoring types.
declare module 'node:crypto' {
  export function randomUUID(): string
  export function createHash(algorithm: 'sha256'): { update(value: string): { digest(encoding: 'hex'): string } }
}

// Orca re-exports Node assert, but its authoring types list only common assertions.
declare module 'node:assert/strict' {
  export function doesNotMatch(value: string, pattern: RegExp, message?: string): void
}
