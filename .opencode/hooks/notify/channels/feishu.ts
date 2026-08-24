/**
 * Feishu custom-robot channel (design §1.3): sign in body, timestamp in SECONDS
 * (string), text msg_type only. Body text capped at 4000 chars.
 */
import type { Channel, SendCtx } from "./registry"
import { feishuSignB64 } from "../lib/sign"
import { isRecord } from "../lib/guards"

export const feishuChannel: Channel = {
  id: "feishu",
  enabled: (cfg) => cfg.channels.feishu.enabled && !!cfg.channels.feishu.webhook && !!cfg.channels.feishu.secret,
  async send(n, ctx: SendCtx) {
    try {
      const ch = ctx.cfg.channels.feishu
      const timestamp = Math.floor(ctx.now() / 1000).toString()
      const body = {
        timestamp,
        sign: feishuSignB64(ch.secret, timestamp),
        msg_type: "text",
        content: { text: `${n.title}\n${n.body}`.slice(0, 4000) },
      }
      if (ctx.cfg.dryRun) {
        ctx.log(`[dryrun] feishu POST ${ch.webhook.replace(/hook\/[^/]+$/, "hook/***")} body=${JSON.stringify(body)}`)
        return
      }
      const res = await ctx.fetchImpl(ch.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      const raw: unknown = await res.json().catch(() => ({}))
      const json = isRecord(raw) ? raw : {}
      const code = Number(json.code ?? json.StatusCode ?? 0)
      if (code !== 0) {
        const codeV = json.code ?? json.StatusCode
        const msg = json.msg ?? json.StatusMessage
        ctx.log(
          `feishu send rejected: code=${typeof codeV === "string" || typeof codeV === "number" ? codeV : ""} msg=${typeof msg === "string" ? msg : ""}`,
        )
      }
    } catch (e) {
      ctx.log(`feishu channel error: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
