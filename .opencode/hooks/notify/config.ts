/**
 * Config resolution with strict priority (design §1.4):
 *   env > project <cwd>/.opencode/notify/notify.jsonc (legacy <cwd>/.opencode/notify.jsonc
 *   still read as fallback) > global ~/.config/opencodeg/notify/notify.jsonc (legacy
 *   ~/.config/opencodeg/notify.jsonc fallback) > legacy notify.config.json (deprecated)
 *   > compiled defaults
 * NOTIFY_CONFIG / opts.configPath replaces the whole file chain (legacy single-file mode).
 * New-layer files are JSONC (comments allowed); parse failures degrade to {}.
 * Real config files are gitignored; examples ship placeholders only.
 * events section: per-event switch + template spec (channel-level beats event-level);
 * template files resolve against project > global > module-default templates/ dirs.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { isRecord } from "./lib/guards"

export type StopMode = "auto" | "all-immediate" | "all-digest"

export type EventKey = "stop" | "stopFailure" | "permissionRequest" | "notification" | "questionAsked" | "digest"

export interface EventConfig {
  enabled: boolean
  template?: string
  channels: Record<string, { template?: string }>
}

export type EventsConfig = Record<EventKey, EventConfig>

const EVENT_KEYS: EventKey[] = ["stop", "stopFailure", "permissionRequest", "notification", "questionAsked", "digest"]

const HOOK_EVENT_KEYS: Record<string, EventKey> = {
  Stop: "stop",
  StopFailure: "stopFailure",
  PermissionRequest: "permissionRequest",
  Notification: "notification",
  QuestionAsked: "questionAsked",
}

/** Hook event name → config events key. UserPromptSubmit is timing-only, never switchable. */
export function eventKeyOf(hookEvent: string): EventKey | undefined {
  return HOOK_EVENT_KEYS[hookEvent]
}

export function defaultEvents(): EventsConfig {
  return {
    stop: { enabled: true, channels: {} },
    stopFailure: { enabled: true, channels: {} },
    permissionRequest: { enabled: true, channels: {} },
    notification: { enabled: true, channels: {} },
    questionAsked: { enabled: true, channels: {} },
    digest: { enabled: true, channels: {} },
  }
}

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
  events: EventsConfig
  globalTemplatesDir: string
  projectTemplatesDir: string | undefined
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

function firstExisting(candidates: string[]): string | undefined {
  for (const f of candidates) if (existsSync(f)) return f
  return undefined
}

/** Per-event deep merge across layers: enabled/template per key, channels per channel id. */
function parseEvents(layers: Array<Record<string, unknown>>): EventsConfig {
  const out = defaultEvents()
  for (const key of EVENT_KEYS) {
    const evLayers = layers.map((l) => obj(obj(l.events)[key]))
    const merged = mergeLayers(evLayers)
    const channels: Record<string, { template?: string }> = {}
    for (const id of new Set(evLayers.flatMap((l) => Object.keys(obj(l.channels))))) {
      const template = str(mergeLayers(evLayers.map((l) => obj(obj(l.channels)[id]))).template).trim()
      channels[id] = template ? { template } : {}
    }
    const template = str(merged.template).trim()
    out[key] = { enabled: bool(merged.enabled, true), ...(template ? { template } : {}), channels }
  }
  return out
}

/**
 * Template file resolution: channel-level spec beats event-level; filename-only
 * specs and relative paths resolve against project > global > module-default
 * (HERE/templates) templates/ dirs, first existing file wins; absolute paths are
 * used directly. No spec or no file found → undefined → compiled hardcoded copy.
 */
export function resolveTemplateFile(key: EventKey, channelId: string, cfg: ResolvedConfig): string | undefined {
  const ev = cfg.events[key]
  const spec = (ev.channels[channelId]?.template ?? "").trim() || (ev.template ?? "").trim()
  if (!spec) return undefined
  if (path.isAbsolute(spec)) return existsSync(spec) ? spec : undefined
  for (const dir of [cfg.projectTemplatesDir, cfg.globalTemplatesDir, path.join(HERE, "templates")]) {
    if (!dir) continue
    const file = path.join(dir, spec)
    if (existsSync(file)) return file
  }
  return undefined
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  opts: { configPath?: string; globalConfigPath?: string; projectConfigPath?: string; globalTemplatesDir?: string; projectTemplatesDir?: string; cwd?: string; stateDir?: string; logDir?: string } = {},
): ResolvedConfig {
  // New structure lives in a notify/ directory; legacy flat files stay readable
  // as fallback (new path first, so an upgrade never silently drops config).
  const globalConfigDir = path.join(os.homedir(), ".config", "opencodeg", "notify")
  const globalFile =
    opts.globalConfigPath ?? firstExisting([path.join(globalConfigDir, "notify.jsonc"), path.join(os.homedir(), ".config", "opencodeg", "notify.jsonc")])
  const projCandidates = opts.projectConfigPath ? [opts.projectConfigPath] : opts.cwd ? [path.join(opts.cwd, ".opencode", "notify", "notify.jsonc"), path.join(opts.cwd, ".opencode", "notify.jsonc")] : []
  const projFile = firstExisting(projCandidates)
  const layers =
    opts.configPath ?? env.NOTIFY_CONFIG
      ? [readJson(opts.configPath ?? env.NOTIFY_CONFIG!)]
      : [
          readJson(path.join(HERE, "notify.config.json")), // deprecated local fallback, lowest file layer
          readJson(globalFile ?? path.join(globalConfigDir, "notify.jsonc")),
          ...(projFile ? [readJson(projFile)] : []), // project overrides global
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
    events: parseEvents(layers),
    globalTemplatesDir: opts.globalTemplatesDir ?? path.join(globalConfigDir, "templates"),
    projectTemplatesDir: opts.projectTemplatesDir ?? (opts.cwd ? path.join(opts.cwd, ".opencode", "notify", "templates") : undefined),
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
