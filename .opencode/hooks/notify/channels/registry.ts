/**
 * Channel registry: the extension point for new notification channels.
 * A channel = one implementation file + one registerChannel() call in channels/index.ts.
 * send() must self-capture errors — a failing channel never affects siblings or the agent.
 * fanOut renders per-channel template copies (channel template > event template >
 * compiled default) before send; channels themselves stay template-unaware.
 */
import { readFileSync } from "node:fs"
import { eventKeyOf, resolveTemplateFile, type EventKey, type ResolvedConfig } from "../config"

export interface Notification {
  kind: "critical" | "normal" | "digest"
  title: string
  body: string
  sessionId?: string
  durationMs?: number
  event: string
  /** Raw variables for template rendering ({var} placeholders); absent → all empty. */
  vars?: Record<string, string>
}

/** Notification → events key. Kind "digest" owns its own key (its event field is the source "Stop"). */
export function notificationEventKey(n: Notification): EventKey | undefined {
  return n.kind === "digest" ? "digest" : eventKeyOf(n.event)
}

/** .txt template: first line = title, rest = body. {var} → vars[var] ?? ""; empty
 *  substitution lines collapse; consecutive blank lines merge; edges trim. */
export function renderTemplate(text: string, vars: Record<string, string>): { title: string; body: string } {
  const lines = text.replace(/\r?\n/g, "\n").replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "").split("\n")
  const title = (lines[0] ?? "").trim()
  const body: string[] = []
  for (const line of lines.slice(1)) {
    const empty = line.trim() === ""
    if (empty && (body.length === 0 || body[body.length - 1] === "")) continue
    body.push(empty ? "" : line.trimEnd())
  }
  while (body.length > 0 && body[body.length - 1] === "") body.pop()
  return { title, body: body.join("\n") }
}

export interface SendCtx {
  cfg: ResolvedConfig
  fetchImpl: typeof fetch
  spawnImpl: typeof Bun.spawn
  now: () => number
  log: (line: string) => void
}

export interface Channel {
  id: string
  enabled(cfg: ResolvedConfig): boolean
  send(n: Notification, ctx: SendCtx): Promise<void>
}

const channels: Channel[] = []

export function registerChannel(c: Channel): void {
  if (channels.some((x) => x.id === c.id)) return
  channels.push(c)
}

export function listChannels(): Channel[] {
  return [...channels]
}

/** Template copy for one channel; unreadable/unresolvable template → compiled default copy. */
function renderedCopy(n: Notification, channelId: string, cfg: ResolvedConfig, log: (line: string) => void): Notification {
  const key = notificationEventKey(n)
  if (key === undefined) return n
  const file = resolveTemplateFile(key, channelId, cfg)
  if (file === undefined) return n
  try {
    const t = renderTemplate(readFileSync(file, "utf8"), n.vars ?? {})
    return { ...n, title: t.title || n.title, body: t.body }
  } catch (e) {
    log(`template ${file} unreadable, using default copy: ${e instanceof Error ? e.message : String(e)}`)
    return n
  }
}

export async function fanOut(n: Notification, deps: { channels: Channel[]; cfg: ResolvedConfig; fetchImpl: typeof fetch; spawnImpl: typeof Bun.spawn; now: () => number; log: (line: string) => void }): Promise<void> {
  // Digest is built outside formatEvent; its event switch gates here.
  if (n.kind === "digest" && !deps.cfg.events.digest.enabled) {
    deps.log("digest disabled → skip flush")
    return
  }
  const active = deps.channels.filter((c) => {
    if (deps.cfg.disabledChannels.includes(c.id)) return false
    try {
      return c.enabled(deps.cfg)
    } catch {
      return false
    }
  })
  const settled = await Promise.allSettled(
    active.map(async (c) => {
      try {
        await c.send(renderedCopy(n, c.id, deps.cfg, deps.log), { cfg: deps.cfg, fetchImpl: deps.fetchImpl, spawnImpl: deps.spawnImpl, now: deps.now, log: deps.log })
      } catch (e) {
        deps.log(`channel ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }),
  )
  for (const s of settled) if (s.status === "rejected") deps.log(`channel rejected: ${String(s.reason)}`)
}
