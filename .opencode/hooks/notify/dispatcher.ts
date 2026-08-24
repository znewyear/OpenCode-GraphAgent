#!/usr/bin/env bun
/**
 * Single notification dispatcher entrypoint (design §2). stdin hook envelope →
 * format → throttle → fan-out. ALWAYS exits 0: hook failures are warn-only and
 * a Stop hook exiting 2 would re-drive the model (up to 5 rounds) — never block.
 */
import { resolveConfig, fileLog } from "./config"
import { fanOut, listChannels, type Notification } from "./channels/registry"
import { registerBuiltinChannels } from "./channels"
import { formatEvent } from "./format"
import { addStopToBuffer, takeAggBufferIfDue, withLock, type AggBuffer } from "./state"
import { isRecord } from "./lib/guards"

export interface DispatchDeps {
  cfg: ReturnType<typeof resolveConfig>
  channels: ReturnType<typeof listChannels>
  stateDir: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
  fetchImpl: typeof fetch
  spawnImpl: typeof Bun.spawn
}

function digestNotification(buf: AggBuffer): Notification {
  const codes = Object.keys(buf.entries)
  const total = Object.values(buf.entries).reduce((acc, e) => acc + e.count, 0)
  const shown = codes.slice(0, 6).map((sid) => sid.slice(-6)).join(",")
  const more = codes.length > 6 ? ",…" : ""
  return { kind: "digest", title: `OpenCode: ${total} 个并行回合完成`, body: `会话: ${shown}${more}`, event: "Stop" }
}

async function flushDueBuffers(deps: DispatchDeps): Promise<void> {
  const buf = withLock(deps.stateDir, () => takeAggBufferIfDue(deps.stateDir, deps.now()))
  if (buf === undefined) return
  const n = digestNotification(buf)
  deps.log(`digest flush: ${n.title}`)
  await fanOut(n, deps)
}

export async function dispatch(env: Record<string, unknown>, deps: DispatchDeps): Promise<void> {
  await flushDueBuffers(deps)
  const outcome = formatEvent(env, { cfg: deps.cfg, stateDir: deps.stateDir, now: deps.now })
  const eventName = typeof env.hook_event_name === "string" ? env.hook_event_name : "?"
  const rawSid = env.session_id
  const sid = typeof rawSid === "string" || typeof rawSid === "number" ? String(rawSid) : "unknown"
  const code = sid.slice(-6)
  if (outcome.type === "silent") {
    deps.log(`event=${eventName} sid=${code} → silent`)
    return
  }
  if (outcome.type === "now") {
    deps.log(`event=${eventName} sid=${code} → now "${outcome.notification.title}"`)
    await fanOut(outcome.notification, deps)
    return
  }
  deps.log(`event=${eventName} sid=${code} → digest (window ${deps.cfg.aggregate.windowMs}ms)`)
  const buf = addStopToBuffer(deps.stateDir, sid, deps.now(), deps.cfg.aggregate.windowMs)
  const wait = buf.flushAt - deps.now()
  if (wait > 0) await deps.sleep(wait)
  await flushDueBuffers(deps)
}

async function main(): Promise<void> {
  const raw = await new Response(Bun.stdin).text()
  let env: unknown
  try {
    env = raw.trim() ? JSON.parse(raw) : undefined
  } catch {
    env = undefined
  }
  if (!isRecord(env)) return
  const envelope = env
  // Project-level notify.jsonc overlay keys off the hook envelope's cwd.
  const cfg = resolveConfig(undefined, { cwd: typeof envelope.cwd === "string" ? envelope.cwd : undefined })
  const log = fileLog(cfg)
  registerBuiltinChannels()
  await dispatch(envelope, {
    cfg,
    channels: listChannels(),
    stateDir: cfg.stateDir,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    log,
    fetchImpl: fetch,
    spawnImpl: Bun.spawn,
  })
}

if (import.meta.main) {
  main()
    .catch((e) => {
      try {
        const cfg = resolveConfig()
        fileLog(cfg)(`dispatcher crashed (still exit 0): ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      } catch {}
    })
    .finally(() => process.exit(0))
}
