/**
 * Event envelope → Notification derivation (design §1.1). All copy is zh; titles
 * carry the "OpenCode: " prefix which doubles as the DingTalk keyword.
 * Timestamp-presence distinguishes main-session Stops (immediate) from DAG
 * subsession Stops (digest) — the envelope carries no dagID/nodeID.
 */
import { createHash } from "node:crypto"
import path from "node:path"
import { eventKeyOf, type EventKey, type ResolvedConfig } from "./config"
import type { Notification } from "./channels/registry"
import { isRecord } from "./lib/guards"
import {
  recordPromptTs,
  takePromptTs,
  markPermissionAsk,
  lastPermissionAsk,
  markElicitationNotify,
  lastElicitationNotify,
  markTextSent,
  textSentAt,
} from "./state"

export type Outcome = { type: "silent" } | { type: "now"; notification: Notification } | { type: "digest" }

const DAY_MS = 24 * 60 * 60 * 1000

/** Event → zh plaintext label for structured channel rendering (six values, digest included). */
export const EVENT_LABELS: Record<EventKey, string> = {
  stop: "回合完成",
  stopFailure: "回合失败",
  permissionRequest: "需要你批准",
  notification: "通知",
  questionAsked: "需要你回答",
  digest: "并行回合完成",
}

export function shortSid(sid: string): string {
  return sid.slice(-6)
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s === 60 ? `${m + 1}m` : `${m}m${s}s`
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function oneLine(v: unknown, max: number): string {
  return str(v).replace(/\s+/g, " ").trim().slice(0, max)
}

function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) return ""
  if (typeof input === "string") return input.slice(0, 160)
  if (typeof input === "number" || typeof input === "boolean" || typeof input === "bigint") return String(input).slice(0, 160)
  if (typeof input !== "object") return ""
  if (Array.isArray(input)) {
    try {
      return JSON.stringify(input).slice(0, 160)
    } catch {
      return ""
    }
  }
  if (!isRecord(input)) return ""
  for (const key of ["command", "filePath", "path"]) {
    const v = input[key]
    if (typeof v === "string" && v) return v.slice(0, 160)
  }
  try {
    return JSON.stringify(input).slice(0, 160)
  } catch {
    return ""
  }
}

export function formatEvent(env: Record<string, unknown>, opts: { cfg: ResolvedConfig; stateDir: string; now: () => number }): Outcome {
  const event = str(env.hook_event_name)
  const sid = str(env.session_id) || "unknown"
  const code = shortSid(sid)
  const { cfg, stateDir, now } = opts
  const project = path.basename(str(env.cwd)) || "unknown"

  if (event === "UserPromptSubmit") {
    recordPromptTs(stateDir, sid, now(), oneLine(env.prompt, 120))
    return { type: "silent" }
  }

  // Event-level switch (events.<key>.enabled=false silences the whole event);
  // UserPromptSubmit above stays pure timing instrumentation, never switchable.
  const eventKey = eventKeyOf(event)
  if (eventKey !== undefined && !cfg.events[eventKey].enabled) return { type: "silent" }

  if (event === "Stop") {
    const stamp = takePromptTs(stateDir, sid)
    if (cfg.stopMode === "all-digest") return { type: "digest" }
    const summary = oneLine(env.last_assistant_message, 120)
    if (stamp === undefined) {
      if (cfg.stopMode === "all-immediate") {
        return {
          type: "now",
          notification: { kind: "normal", title: `OpenCode: 回合完成 [${code}]`, body: summary, sessionId: code, event, vars: { code, duration: "", summary, taskTitle: "", sessionId: sid, eventLabel: EVENT_LABELS.stop, project } },
        }
      }
      return { type: "digest" }
    }
    const durationMs = now() - stamp.ts
    const showDuration = durationMs >= cfg.durationMinMs && durationMs <= DAY_MS
    const duration = showDuration ? formatDuration(durationMs) : ""
    const body = [showDuration ? `耗时 ${duration}` : "", summary].filter(Boolean).join("\n")
    return {
      type: "now",
      notification: { kind: "normal", title: `OpenCode: 回合完成 [${code}]`, body, sessionId: code, durationMs, event, vars: { code, duration, summary, taskTitle: stamp.prompt, sessionId: sid, eventLabel: EVENT_LABELS.stop, project } },
    }
  }

  if (event === "StopFailure") {
    const stamp = takePromptTs(stateDir, sid)
    const error = oneLine(env.error, 200)
    return {
      type: "now",
      notification: { kind: "critical", title: `OpenCode: 回合失败 [${code}]`, body: `错误: ${error}`, sessionId: code, event, vars: { code, error, taskTitle: stamp?.prompt ?? "", sessionId: sid, eventLabel: EVENT_LABELS.stopFailure, project } },
    }
  }

  if (event === "PermissionRequest") {
    markPermissionAsk(stateDir, now())
    const tool = str(env.tool_name)
    const input = summarizeToolInput(env.tool_input)
    const body = [`工具: ${tool}`, `输入: ${input}`].filter(Boolean).join("\n")
    return {
      type: "now",
      notification: { kind: "critical", title: `OpenCode: 需要你批准 [${code}]`, body, sessionId: code, event, vars: { code, tool, input, taskTitle: "", sessionId: sid, eventLabel: EVENT_LABELS.permissionRequest, project } },
    }
  }

  if (event === "Notification") {
    const ts = now()
    if (str(env.notification_type) === "elicitation") markElicitationNotify(stateDir, ts)
    const permAt = lastPermissionAsk(stateDir)
    if (permAt !== undefined && ts - permAt <= 8000 && ts - permAt >= 0) return { type: "silent" }
    const text = oneLine(env.message, 500)
    const hash = createHash("sha256").update(`${str(env.title)}\n${text}`).digest("hex")
    const sentAt = textSentAt(stateDir, hash)
    if (sentAt !== undefined && ts - sentAt <= 5000 && ts - sentAt >= 0) return { type: "silent" }
    markTextSent(stateDir, hash, ts)
    return { type: "now", notification: { kind: "normal", title: `OpenCode: 通知`, body: text, sessionId: code, event, vars: { code, message: text, taskTitle: "", sessionId: sid, eventLabel: EVENT_LABELS.notification, project } } }
  }

  if (event === "QuestionAsked") {
    // MCP elicitation already notified via the Notification event immediately
    // before Question.ask — suppress the duplicate within a 10s window.
    const ts = now()
    const elAt = lastElicitationNotify(stateDir)
    if (elAt !== undefined && ts - elAt <= 10_000 && ts - elAt >= 0) return { type: "silent" }
    const questions = Array.isArray(env.questions)
      ? env.questions.filter((q): q is Record<string, unknown> => typeof q === "object" && q !== null)
      : []
    const first = questions[0]
    const title = str(env.title) || str(first?.header)
    const question = oneLine(first?.question ?? env.prompt, 200)
    const body = [`项目 ${project}${title ? ` · ${title}` : ""}`, question].filter(Boolean).join("\n")
    return {
      type: "now",
      notification: { kind: "critical", title: `OpenCode: 需要你回答 [${code}]`, body, sessionId: code, event, vars: { code, project, title, question, taskTitle: "", sessionId: sid, eventLabel: EVENT_LABELS.questionAsked } },
    }
  }

  return { type: "silent" }
}
