/**
 * DingTalk custom-robot channel (design §1.3): signed URL + markdown message.
 * Response errcode may arrive as number or string — both decoded.
 */
import type { Channel, Notification, SendCtx } from "./registry"
import { dingtalkSignB64 } from "../lib/sign"
import { isRecord } from "../lib/guards"

/** One `label: value` line (plain key:val — no table/bold markup); empty values collapse to "". */
function field(label: string, val: unknown): string {
  return typeof val === "string" && val !== "" ? `${label}: ${val}` : ""
}

/**
 * markdown 正文：vars 带 eventLabel（format/dispatcher 产出的结构化通知）时按
 * 「标题行 / --- 分割线 / 描述」三段式渲染：标题 = 项目名 + 会话 id + 通知类型，
 * 分割线下首行任务标题（digest 的会话补全 ID 列表行），其后为描述正文；
 * vars 缺 eventLabel（模板外直接构造、历史调用方）降级为原 title+body 整段，
 * 字节不变。keyword 未命中渲染文本时仍自动前置兜底。
 */
function renderMessage(n: Notification, keyword: string): { title: string; text: string } {
  const v = n.vars ?? {}
  const val = (x: unknown): string => (typeof x === "string" ? x : "")
  const eventLabel = val(v.eventLabel)
  if (eventLabel === "") {
    const mdBody = n.body.split("\n").join("\n\n")
    let legacy = `**${n.title}**\n\n${mdBody}`
    if (keyword && !`${n.title}\n${n.body}`.includes(keyword)) legacy = `${keyword}\n\n${legacy}`
    return { title: n.title, text: legacy }
  }
  const sessionId = val(v.sessionId)
  const sessions = val(v.sessions)
  const count = val(v.count)
  // 标题 = 项目名 + 会话 id + 通知类型；digest 无单一会话，退化为「类型 (数量)」。
  const headParts = [val(v.project), sessionId].filter((x) => x !== "")
  const label = sessionId === "" && count !== "" ? `${eventLabel} (${count})` : eventLabel
  const title = [...headParts, label].filter(Boolean).join(" ")
  const detail = [field("任务", v.taskTitle), ...(sessionId === "" ? [field("会话", sessions)] : [])].filter(Boolean)
  const desc = [detail.join("\n\n"), n.body.split("\n").join("\n\n")].filter(Boolean).join("\n\n")
  let text = [`**${title}**`, "---", desc].filter(Boolean).join("\n\n")
  if (keyword && !text.includes(keyword)) text = `${keyword}\n\n${text}`
  return { title, text }
}

export const dingtalkChannel: Channel = {
  id: "dingtalk",
  enabled: (cfg) => cfg.channels.dingtalk.enabled && !!cfg.channels.dingtalk.webhook && !!cfg.channels.dingtalk.secret,
  async send(n, ctx: SendCtx) {
    try {
      const ch = ctx.cfg.channels.dingtalk
      const ms = ctx.now()
      const url = `${ch.webhook}&timestamp=${ms}&sign=${encodeURIComponent(dingtalkSignB64(ch.secret, ms))}`
      // markdown: title 只透出在首屏会话列表；正文见 renderMessage 的结构化/降级两路。
      const rendered = renderMessage(n, ch.keyword)
      const body = { msgtype: "markdown", markdown: { title: rendered.title, text: rendered.text } }
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
