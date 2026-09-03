/**
 * Cross-process state under stateDir (each hook invocation is a separate process):
 *  - prompt-<sid>.json : UserPromptSubmit {ts, prompt} stamps (consumed at Stop;
 *    pre-upgrade {ts}-only files degrade prompt to "")
 *  - agg-stop.json     : aggregation buffer for untimestamped Stops (design §1.2)
 *  - agg.lock          : wx-flag lock guarding digest flush (winner sends, losers exit)
 *  - recent.json       : permission-ask marker + same-text dedupe hashes
 * Writes use tmp-file + rename so concurrent processes never see torn JSON.
 * Known accepted race (design F6): concurrent read-modify-write may undercount
 * digest entries; critical notifications never pass through the buffer.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from "node:fs"
import path from "node:path"
import { isRecord } from "./lib/guards"

export interface AggBuffer {
  flushAt: number
  entries: Record<string, { count: number; lastTs: number }>
}

function safeSid(sid: string): string {
  return sid.replace(/[^a-zA-Z0-9_-]/g, "") || "unknown"
}

function readObj(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"))
    return isRecord(v) ? v : undefined
  } catch {
    return undefined
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

export interface PromptStamp {
  ts: number
  /** One-lined UserPromptSubmit prompt; "" for pre-upgrade {ts}-only files. */
  prompt: string
}

export function recordPromptTs(stateDir: string, sid: string, ts: number, prompt: string): void {
  writeJsonAtomic(path.join(stateDir, `prompt-${safeSid(sid)}.json`), { ts, prompt })
}

export function takePromptTs(stateDir: string, sid: string): PromptStamp | undefined {
  const file = path.join(stateDir, `prompt-${safeSid(sid)}.json`)
  const data = readObj(file)
  if (data === undefined) return undefined
  unlinkSync(file)
  if (typeof data.ts !== "number") return undefined
  return { ts: data.ts, prompt: typeof data.prompt === "string" ? data.prompt : "" }
}

function parseEntries(v: unknown): Record<string, { count: number; lastTs: number }> {
  const out: Record<string, { count: number; lastTs: number }> = {}
  if (!isRecord(v)) return out
  for (const [k, val] of Object.entries(v)) {
    if (!isRecord(val) || typeof val.count !== "number" || typeof val.lastTs !== "number") continue
    out[k] = { count: val.count, lastTs: val.lastTs }
  }
  return out
}

export function addStopToBuffer(stateDir: string, sid: string, ts: number, windowMs: number): AggBuffer {
  const file = path.join(stateDir, "agg-stop.json")
  const raw = readObj(file)
  const baseFlushAt = raw !== undefined && typeof raw.flushAt === "number" ? raw.flushAt : 0
  const entries = raw !== undefined ? parseEntries(raw.entries) : {}
  const key = safeSid(sid)
  const prev = entries[key] ?? { count: 0, lastTs: 0 }
  entries[key] = { count: prev.count + 1, lastTs: ts }
  const flushAt = baseFlushAt <= ts ? ts + windowMs : baseFlushAt
  writeJsonAtomic(file, { flushAt, entries })
  return { flushAt, entries }
}

export function takeAggBufferIfDue(stateDir: string, now: number): AggBuffer | undefined {
  const file = path.join(stateDir, "agg-stop.json")
  const raw = readObj(file)
  const flushAt = raw !== undefined && typeof raw.flushAt === "number" ? raw.flushAt : 0
  if (raw === undefined || flushAt > now) return undefined
  const consumed = `${file}.${process.pid}.consumed`
  try {
    renameSync(file, consumed)
  } catch {
    return undefined
  }
  unlinkSync(consumed)
  return { flushAt, entries: parseEntries(raw.entries) }
}

export function withLock<T>(stateDir: string, fn: () => T): T | undefined {
  mkdirSync(stateDir, { recursive: true })
  const lock = path.join(stateDir, "agg.lock")
  try {
    const fd = openSync(lock, "wx")
    closeSync(fd)
  } catch {
    return undefined
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {}
  }
}

interface RecentState {
  permAt?: number
  /** Timestamp of the last Notification envelope with notification_type "elicitation" (double-notify guard for QuestionAsked). */
  elicitationAt?: number
  texts?: Record<string, number>
}

function readRecent(stateDir: string): RecentState {
  const raw = readObj(path.join(stateDir, "recent.json"))
  if (raw === undefined) return {}
  const base: RecentState = {
    permAt: typeof raw.permAt === "number" ? raw.permAt : undefined,
    elicitationAt: typeof raw.elicitationAt === "number" ? raw.elicitationAt : undefined,
    texts: undefined,
  }
  if (!isRecord(raw.texts)) return base
  const texts: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw.texts)) if (typeof v === "number") texts[k] = v
  return { ...base, texts }
}

function writeRecent(stateDir: string, s: RecentState, now: number): void {
  const texts: Record<string, number> = {}
  for (const [h, ts] of Object.entries(s.texts ?? {})) if (now - ts <= 60_000) texts[h] = ts
  writeJsonAtomic(path.join(stateDir, "recent.json"), { permAt: s.permAt, elicitationAt: s.elicitationAt, texts })
}

export function markPermissionAsk(stateDir: string, ts: number): void {
  const s = readRecent(stateDir)
  s.permAt = ts
  writeRecent(stateDir, s, ts)
}

export function lastPermissionAsk(stateDir: string): number | undefined {
  return readRecent(stateDir).permAt
}

/**
 * Elicitation double-notify guard (recent.json.elicitationAt).
 * Known accepted race: markElicitationNotify and lastElicitationNotify run in
 * separate async hook subprocesses — write-read ordering is subject to process
 * scheduling, so under extreme timing the suppression can fail (a duplicate
 * QuestionAsked notify may slip through). Listed alongside the other accepted
 * races; no lock/retry by design.
 */
export function markElicitationNotify(stateDir: string, ts: number): void {
  const s = readRecent(stateDir)
  s.elicitationAt = ts
  writeRecent(stateDir, s, ts)
}

export function lastElicitationNotify(stateDir: string): number | undefined {
  return readRecent(stateDir).elicitationAt
}

export function markTextSent(stateDir: string, hash: string, ts: number): void {
  const s = readRecent(stateDir)
  s.texts = s.texts ?? {}
  s.texts[hash] = ts
  writeRecent(stateDir, s, ts)
}

export function textSentAt(stateDir: string, hash: string): number | undefined {
  return readRecent(stateDir).texts?.[hash]
}
