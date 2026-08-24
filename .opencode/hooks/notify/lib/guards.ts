/**
 * Shared type guards for untrusted JSON envelope / config values.
 * `isRecord` narrows unknown → Record<string, unknown> without an unsafe
 * assertion; keep all such narrowing here so the rest of the codebase can
 * index into parsed JSON without eslint no-unsafe-type-assertion hits.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
