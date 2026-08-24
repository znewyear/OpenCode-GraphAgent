/**
 * Config resolution with strict priority (design §1.4):
 *   env > project <cwd>/.opencode/notify.jsonc > global
 *   ~/.config/opencodeg/notify.jsonc > legacy notify.config.json (deprecated)
 *   > compiled defaults
 * NOTIFY_CONFIG / opts.configPath replaces the whole file chain (legacy single-file mode).
 * New-layer files are JSONC (comments allowed); parse failures degrade to {}.
 * Real config files are gitignored; examples ship placeholders only.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { isRecord } from "./lib/guards"

export type StopMode = "auto" | "all-immediate" | "all-digest"

export interface ResolvedConfig {
  channels: {
    "windows-toast": { enabled: boolean; powershellPath: string; appId: string; timeoutMs: number }
    dingtalk: { enabled: boolean; webhook: string; secret: string; keyword: string }
    feishu: { enabled: boolean; webhook: string; secret: string }
  }
  aggregate: { windowMs: number }
  stopMode: StopMode
  durationMinMs: number
  locale: string
  dryRun: boolean
  stateDir: string
  logDir: string
  disabledChannels: string[]
}

const HERE = import.meta.dir

/**
 * String-aware JSONC comment stripper: removes // and /* *\/ comments while
 * preserving them inside JSON string literals (a URL like https://x is a
 * string body, not a comment). Handles escaped quotes inside strings.
 */
function stripJsoncComments(text: string): string {
  let out = ""
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === "\\") {
        out += text[i + 1] ?? ""
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i++
      continue
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stripJsoncComments(readFileSync(file, "utf8")))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Overlay merge: later layers win per key (presence-based; an explicit value, including "", wins). */
function mergeLayers(layers: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const layer of layers) for (const [k, v] of Object.entries(layer)) out[k] = v
  return out
}

function channelLayer(layer: Record<string, unknown>, id: string): Record<string, unknown> {
  return obj(obj(layer.channels)[id])
}

function obj(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {}
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback
}
function toStopMode(v: string): StopMode {
  return v === "all-immediate" || v === "all-digest" || v === "auto" ? v : "auto"
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { configPath?: string; globalConfigPath?: string; projectConfigPath?: string; cwd?: string; stateDir?: string; logDir?: string } = {},
): ResolvedConfig {
  // NOTIFY_CONFIG / opts.configPath replaces the whole chain (legacy single-file mode).
  const globalConfigPath = opts.globalConfigPath ?? path.join(os.homedir(), ".config", "opencodeg", "notify.jsonc")
  const projectConfigPath = opts.projectConfigPath ?? (opts.cwd ? path.join(opts.cwd, ".opencode", "notify.jsonc") : undefined)
  const layers =
    opts.configPath ?? env.NOTIFY_CONFIG
      ? [readJson(opts.configPath ?? env.NOTIFY_CONFIG!)]
      : [
          readJson(path.join(HERE, "notify.config.json")), // deprecated local fallback, lowest file layer
          readJson(globalConfigPath),
          ...(projectConfigPath ? [readJson(projectConfigPath)] : []), // project overrides global
        ]
  const file = mergeLayers(layers)
  const toast = mergeLayers(layers.map((l) => channelLayer(l, "windows-toast")))
  const ding = mergeLayers(layers.map((l) => channelLayer(l, "dingtalk")))
  const fei = mergeLayers(layers.map((l) => channelLayer(l, "feishu")))
  const aggregate = mergeLayers(layers.map((l) => obj(l.aggregate)))

  const stopMode = toStopMode(str(env.NOTIFY_STOP_MODE, str(file.stopMode, "auto")))
  const cfg: ResolvedConfig = {
    channels: {
      "windows-toast": {
        enabled: bool(toast.enabled, true),
        powershellPath: str(toast.powershellPath, ""),
        appId: str(toast.appId, ""),
        timeoutMs: num(toast.timeoutMs, 8000),
      },
      dingtalk: {
        enabled: bool(ding.enabled, true),
        webhook: str(env.NOTIFY_DINGTALK_WEBHOOK, str(ding.webhook, "")),
        secret: str(env.NOTIFY_DINGTALK_SECRET, str(ding.secret, "")),
        keyword: str(ding.keyword, "OpenCode"),
      },
      feishu: {
        enabled: bool(fei.enabled, true),
        webhook: str(env.NOTIFY_FEISHU_WEBHOOK, str(fei.webhook, "")),
        secret: str(env.NOTIFY_FEISHU_SECRET, str(fei.secret, "")),
      },
    },
    aggregate: { windowMs: num(aggregate.windowMs, 10000) },
    stopMode: ["auto", "all-immediate", "all-digest"].includes(stopMode) ? stopMode : "auto",
    durationMinMs: num(file.durationMinMs, 0),
    locale: str(file.locale, "zh"),
    dryRun: env.NOTIFY_DRYRUN === "1" || file.dryRun === true,
    stateDir: opts.stateDir ?? env.NOTIFY_STATE_DIR ?? path.join(HERE, "state"),
    logDir: opts.logDir ?? path.join(HERE, "logs"),
    disabledChannels: (env.NOTIFY_DISABLE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }
  return cfg
}

export function fileLog(cfg: ResolvedConfig): (line: string) => void {
  return (line) => {
    const ts = new Date().toISOString()
    try {
      // appendFileSync: Bun 1.3.14's Bun.write/FileSink append modes empirically
      // truncate across processes, which destroyed all but the last log line.
      mkdirSync(cfg.logDir, { recursive: true })
      appendFileSync(path.join(cfg.logDir, "dispatcher.log"), `${ts} ${line}\n`)
    } catch {}
    process.stderr.write(`${ts} ${line}\n`)
  }
}
