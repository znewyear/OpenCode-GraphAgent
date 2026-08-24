/**
 * DingTalk custom-robot channel (design §1.3): signed URL + text message.
 * Response errcode may arrive as number or string — both decoded.
 */
import type { Channel, SendCtx } from "./registry"
import { dingtalkSignB64 } from "../lib/sign"
import { isRecord } from "../lib/guards"

export const dingtalkChannel: Channel = {
  id: "dingtalk",
  enabled: (cfg) => cfg.channels.dingtalk.enabled && !!cfg.channels.dingtalk.webhook && !!cfg.channels.dingtalk.secret,
  async send(n, ctx: SendCtx) {
    try {
      const ch = ctx.cfg.channels.dingtalk
      const ms = ctx.now()
      const url = `${ch.webhook}&timestamp=${ms}&sign=${encodeURIComponent(dingtalkSignB64(ch.secret, ms))}`
      let content = `${n.title}\n${n.body}`
      if (ch.keyword && !content.includes(ch.keyword)) content = `${ch.keyword}\n${content}`
      const body = { msgtype: "text", text: { content } }
      if (ctx.cfg.dryRun) {
        ctx.log(`[dryrun] dingtalk POST ${url.replace(/access_token=[^&]+/, "access_token=***")} body=${JSON.stringify(body)}`)
        return
      }
      const res = await ctx.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
      const raw: unknown = await res.json().catch(() => ({}))
      const json = isRecord(raw) ? raw : {}
      const errcode = json.errcode
      const errmsg = json.errmsg
      if (Number(errcode ?? 0) !== 0)
        ctx.log(
          `dingtalk send rejected: errcode=${typeof errcode === "string" || typeof errcode === "number" ? errcode : ""} errmsg=${typeof errmsg === "string" ? errmsg : ""}`,
        )
    } catch (e) {
      ctx.log(`dingtalk channel error: ${e instanceof Error ? e.message : String(e)}`)
    }
  },
}
