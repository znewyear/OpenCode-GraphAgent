/**
 * Channel registry: the extension point for new notification channels.
 * A channel = one implementation file + one registerChannel() call in channels/index.ts.
 * send() must self-capture errors — a failing channel never affects siblings or the agent.
 */
import type { ResolvedConfig } from "../config"

export interface Notification {
  kind: "critical" | "normal" | "digest"
  title: string
  body: string
  sessionId?: string
  durationMs?: number
  event: string
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

export async function fanOut(n: Notification, deps: { channels: Channel[]; cfg: ResolvedConfig; fetchImpl: typeof fetch; spawnImpl: typeof Bun.spawn; now: () => number; log: (line: string) => void }): Promise<void> {
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
        await c.send(n, { cfg: deps.cfg, fetchImpl: deps.fetchImpl, spawnImpl: deps.spawnImpl, now: deps.now, log: deps.log })
      } catch (e) {
        deps.log(`channel ${c.id} failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }),
  )
  for (const s of settled) if (s.status === "rejected") deps.log(`channel rejected: ${String(s.reason)}`)
}
