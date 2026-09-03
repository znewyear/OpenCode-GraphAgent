/**
 * Offline behavior verification for the notify dispatcher (design §1.5, A1–A16).
 * Run from this directory: `bun verify.ts`
 * Exit 0 = all scenarios pass. No real webhook traffic (fake fetch only),
 * no real powershell spawn (fake spawnImpl only).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { dispatch, type DispatchDeps } from "./dispatcher"
import { EVENT_LABELS } from "./format"
import { fileLog, resolveConfig } from "./config"
import { dingtalkChannel } from "./channels/dingtalk"
import { feishuChannel } from "./channels/feishu"
import { windowsToastChannel, toastXml } from "./channels/windows-toast"
import { registry } from "./channels/registry"

const HERE = import.meta.dir
const REPO_ROOT = path.resolve(HERE, "../../..")

// ── Fixed offline signature vectors (computed once with openssl, design A6/A7) ──
const VEC_SECRET = "test-secret-vector"
const VEC_MS = 1700000000000
const DINGTALK_SIGN_URLENC = "s5B9C6XZXHH8RZWLYXYm4bFxEcaPaLLghdCs05KPxyw%3D"
const FEISHU_SIGN_B64 = "EkNizHOfzow12AVrpkAxe6H2y+0OHihWaZC8YyDtHZM="

let seq = 0
function tmpState() {
  return mkdtempSync(path.join(os.tmpdir(), `notify-verify-${++seq}-`))
}

// Hermetic config: point NOTIFY_CONFIG at a nonexistent file so scenarios never
// pick up the developer's real local notify.config.json.
function noConfig(dir: string) {
  return path.join(dir, "no-config.json")
}

function baseDeps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  const logs: string[] = []
  const dir = tmpState()
  return {
    cfg: resolveConfig({ NOTIFY_CONFIG: noConfig(dir) }, { stateDir: dir }),
    channels: [],
    stateDir: "",
    now: () => 0,
    sleep: async () => {},
    log: (line) => logs.push(line),
    fetchImpl: (async () => new Response("{}")) as typeof fetch,
    spawnImpl: Bun.spawn,
    ...over,
  }
}

function fakeChannel(id: string) {
  const calls: registry.Notification[] = []
  const ch: registry.Channel = {
    id,
    enabled: () => true,
    send: async (n) => {
      if (id === "rejecting") throw new Error("boom from " + id)
      calls.push(n)
    },
  }
  return { ch, calls }
}

// Fake Bun.spawn for the windows-toast path (A16): captures every cmd line and
// resolves as a subprocess with a fixed exit code — offline, no Windows needed.
function fakeSpawn(exitCode: number, stderr = "") {
  const cmds: string[][] = []
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test shim; typeof Bun.spawn carries internal any
  const impl = ((opts: { cmd: string[] }) => {
    cmds.push(opts.cmd)
    return { exited: Promise.resolve(exitCode), stderr, kill: () => {} }
  }) as unknown as typeof Bun.spawn
  return { impl, cmds }
}

function envOf(event: string, sid: string, extra: Record<string, unknown> = {}) {
  return { hook_event_name: event, session_id: sid, cwd: REPO_ROOT, ...extra }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const scenarios: Array<[string, () => Promise<void>]> = []

// A1: UserPromptSubmit is silent (timing only) and stamps state/prompt-<sid>.json
scenarios.push([
  "A1 UserPromptSubmit: silent + timestamp file",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const deps = { ...baseDeps({ stateDir: dir, channels: [ch], now: () => 1000 }) }
    await dispatch(envOf("UserPromptSubmit", "ses_main_111111", { prompt: "do the thing" }), deps)
    if (calls.length !== 0) throw new Error(`expected 0 channel calls, got ${calls.length}`)
    const stamp = readFileSync(path.join(dir, "prompt-ses_main_111111.json"), "utf8")
    if (!stamp.includes("1000")) throw new Error(`timestamp file content: ${stamp}`)
  },
])

// A2: Stop with pending timestamp → exactly one notification with duration + summary
scenarios.push([
  "A2 timestamped Stop: 1 notify, duration, short code",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const deps = { ...baseDeps({ stateDir: dir, channels: [ch] }), now: () => 1000 }
    await dispatch(envOf("UserPromptSubmit", "ses_main_222222", { prompt: "hi" }), deps)
    deps.now = () => 1000 + 192000
    await dispatch(
      envOf("Stop", "ses_main_222222", { stop_hook_active: false, last_assistant_message: "已完成重构并跑通全部测试，详见报告。" }),
      deps,
    )
    if (calls.length !== 1) throw new Error(`expected 1 call, got ${calls.length}`)
    const n = calls[0]
    if (n.title !== "OpenCode: 回合完成 [222222]") throw new Error(`title: ${n.title}`)
    if (!n.body.includes("3m12s")) throw new Error(`body missing duration: ${n.body}`)
    if (!n.body.includes("已完成重构")) throw new Error(`body missing summary: ${n.body}`)
    if (n.kind !== "normal") throw new Error(`kind: ${n.kind}`)
    if (n.durationMs !== 192000) throw new Error(`durationMs: ${n.durationMs}`)
  },
])

// A3: 5 concurrent untimestamped Stops (DAG subsessions) within window → exactly 1 digest
scenarios.push([
  "A3 storm aggregation: 5 Stops → 1 digest",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const cfg = resolveConfig({ NOTIFY_CONFIG: noConfig(dir) }, { stateDir: dir })
    cfg.aggregate.windowMs = 150
    const deps: DispatchDeps = {
      ...baseDeps(),
      cfg,
      channels: [ch],
      stateDir: dir,
      now: () => Date.now(),
      sleep: realSleep,
    }
    const sids = ["ses_sub_100001", "ses_sub_100002", "ses_sub_100003", "ses_sub_100004", "ses_sub_100005"]
    await Promise.all(sids.map((sid) => dispatch(envOf("Stop", sid, { stop_hook_active: false }), deps)))
    if (calls.length !== 1) throw new Error(`expected exactly 1 digest, got ${calls.length}: ${JSON.stringify(calls.map((c) => c.title))}`)
    const n = calls[0]
    if (n.title !== "OpenCode: 5 个并行回合完成") throw new Error(`title: ${n.title}`)
    for (const sid of sids) if (!n.body.includes(sid.slice(-6))) throw new Error(`body missing short code ${sid.slice(-6)}: ${n.body}`)
    if (n.kind !== "digest") throw new Error(`kind: ${n.kind}`)
  },
])

// A4: critical events bypass the aggregation window — never swallowed
scenarios.push([
  "A4 StopFailure/PermissionRequest bypass throttle",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const cfg = resolveConfig({ NOTIFY_CONFIG: noConfig(dir) }, { stateDir: dir })
    cfg.aggregate.windowMs = 400
    const deps: DispatchDeps = { ...baseDeps(), cfg, channels: [ch], stateDir: dir, now: () => Date.now(), sleep: realSleep }
    const digestRun = dispatch(envOf("Stop", "ses_sub_700001", { stop_hook_active: false }), deps)
    await dispatch(envOf("StopFailure", "ses_sub_700002", { stop_hook_active: false, error: "provider 502" }), deps)
    await dispatch(envOf("PermissionRequest", "ses_sub_700003", { tool_name: "Bash", tool_input: { command: "rm -rf /" } }), deps)
    const titles = calls.map((c) => c.title)
    if (!titles.some((t) => t === "OpenCode: 回合失败 [700002]")) throw new Error(`StopFailure swallowed: ${titles.join(",")}`)
    if (!titles.some((t) => t === "OpenCode: 需要你批准 [700003]")) throw new Error(`PermissionRequest swallowed: ${titles.join(",")}`)
    const fail = calls.find((c) => c.title.includes("回合失败"))!
    if (fail.kind !== "critical") throw new Error(`StopFailure kind: ${fail.kind}`)
    const perm = calls.find((c) => c.title.includes("批准"))!
    if (perm.body.includes("rm -rf /") !== true) throw new Error(`perm body: ${perm.body}`)
    await digestRun
  },
])

// A5: Notification fallback — suppressed within 8s after PermissionRequest; same-text 5s dedupe
scenarios.push([
  "A5 Notification fallback suppression + dedupe",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const deps = { ...baseDeps({ stateDir: dir, channels: [ch] }), now: () => 1000 }
    await dispatch(envOf("PermissionRequest", "ses_main_333333", { tool_name: "Bash", tool_input: { command: "ls" } }), deps)
    await dispatch(envOf("Notification", "ses_main_333333", { message: "需要权限才能继续 Bash" }), deps)
    if (calls.length !== 1) throw new Error(`expected 1 (no double-send), got ${calls.length}`)
    const dir2 = tmpState()
    const { ch: ch2, calls: calls2 } = fakeChannel("cap")
    const deps2 = { ...baseDeps({ stateDir: dir2, channels: [ch2] }), now: () => 1000 }
    await dispatch(envOf("Notification", "ses_main_444444", { message: "任务等待输入" }), deps2)
    deps2.now = () => 3000
    await dispatch(envOf("Notification", "ses_main_444444", { message: "任务等待输入" }), deps2)
    if (calls2.length !== 1) throw new Error(`same-text dedupe failed, got ${calls2.length}`)
    await dispatch(envOf("Notification", "ses_main_444444", { message: "另一条不同消息" }), deps2)
    if (calls2.length !== 2) throw new Error(`different text should pass, got ${calls2.length}`)
  },
])

// A6: DingTalk signature + body against fixed openssl vector
scenarios.push([
  "A6 dingtalk sign/body == fixed vector",
  async () => {
    const seen: Array<{ url: string; body: any }> = []
    const cfg = resolveConfig(
      { NOTIFY_CONFIG: noConfig(tmpState()), NOTIFY_DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=TESTTOKEN", NOTIFY_DINGTALK_SECRET: VEC_SECRET },
      { stateDir: tmpState() },
    )
    if (!dingtalkChannel.enabled(cfg)) throw new Error("dingtalk should be enabled with creds")
    await dingtalkChannel.send(
      { kind: "normal", title: "OpenCode: 回合完成 [222222]", body: "耗时 3m12s\n已完成", event: "Stop" },
      {
        cfg,
        fetchImpl: (async (url: any, init: any) => {
          seen.push({ url: String(url), body: JSON.parse(init.body) })
          return new Response('{"errcode":0,"errmsg":"ok"}')
        }) as typeof fetch,
        spawnImpl: Bun.spawn,
        now: () => VEC_MS,
        log: () => {},
      },
    )
    if (seen.length !== 1) throw new Error(`expected 1 request, got ${seen.length}`)
    const expectedUrl = `https://oapi.dingtalk.com/robot/send?access_token=TESTTOKEN&timestamp=${VEC_MS}&sign=${DINGTALK_SIGN_URLENC}`
    if (seen[0].url !== expectedUrl) throw new Error(`url: ${seen[0].url}`)
    if (JSON.stringify(seen[0].body) !== JSON.stringify({ msgtype: "markdown", markdown: { title: "OpenCode: 回合完成 [222222]", text: "**OpenCode: 回合完成 [222222]**\n\n耗时 3m12s\n\n已完成" } }))
      throw new Error(`body: ${JSON.stringify(seen[0].body)}`)
  },
])

// A7: Feishu signature + body against fixed openssl vector
scenarios.push([
  "A7 feishu sign/body == fixed vector",
  async () => {
    const seen: Array<{ url: string; body: any }> = []
    const cfg = resolveConfig(
      { NOTIFY_CONFIG: noConfig(tmpState()), NOTIFY_FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/TESTTOKEN", NOTIFY_FEISHU_SECRET: VEC_SECRET },
      { stateDir: tmpState() },
    )
    if (!feishuChannel.enabled(cfg)) throw new Error("feishu should be enabled with creds")
    await feishuChannel.send(
      { kind: "normal", title: "OpenCode: 回合完成 [222222]", body: "耗时 3m12s\n已完成", event: "Stop" },
      {
        cfg,
        fetchImpl: (async (url: any, init: any) => {
          seen.push({ url: String(url), body: JSON.parse(init.body) })
          return new Response('{"code":0}')
        }) as typeof fetch,
        spawnImpl: Bun.spawn,
        now: () => VEC_MS,
        log: () => {},
      },
    )
    if (seen.length !== 1) throw new Error(`expected 1 request, got ${seen.length}`)
    if (seen[0].url !== "https://open.feishu.cn/open-apis/bot/v2/hook/TESTTOKEN") throw new Error(`url: ${seen[0].url}`)
    const want = { timestamp: "1700000000", sign: FEISHU_SIGN_B64, msg_type: "text", content: { text: "OpenCode: 回合完成 [222222]\n耗时 3m12s\n已完成" } }
    if (JSON.stringify(seen[0].body) !== JSON.stringify(want)) throw new Error(`body: ${JSON.stringify(seen[0].body)}`)
  },
])

// A8: string errcode is decoded tolerantly → warning logged, no throw
scenarios.push([
  "A8 string errcode tolerated",
  async () => {
    const logs: string[] = []
    const cfg = resolveConfig(
      { NOTIFY_CONFIG: noConfig(tmpState()), NOTIFY_DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=T", NOTIFY_DINGTALK_SECRET: VEC_SECRET },
      { stateDir: tmpState() },
    )
    await dingtalkChannel.send(
      { kind: "normal", title: "t", body: "b", event: "Stop" },
      {
        cfg,
        fetchImpl: (async () => new Response('{"errcode":"410100","errmsg":"date invalid"}')) as typeof fetch,
        spawnImpl: Bun.spawn,
        now: () => VEC_MS,
        log: (l) => logs.push(l),
      },
    )
    if (!logs.some((l) => l.includes("410100"))) throw new Error(`no warning logged: ${logs.join(",")}`)
  },
])

// A9: config priority env > json > defaults
scenarios.push([
  "A9 config priority env>json>defaults",
  async () => {
    const dir = tmpState()
    const cfgFile = path.join(dir, "notify.config.json")
    writeFileSync(
      cfgFile,
      JSON.stringify({ channels: { dingtalk: { enabled: true, webhook: "https://json.example/hook?access_token=J", secret: "json-sec" } }, aggregate: { windowMs: 2500 } }),
    )
    const fromJson = resolveConfig({ NOTIFY_CONFIG: cfgFile }, { stateDir: dir })
    if (fromJson.channels.dingtalk.webhook !== "https://json.example/hook?access_token=J") throw new Error("json not applied")
    if (fromJson.channels.dingtalk.secret !== "json-sec") throw new Error("json secret not applied")
    if (fromJson.aggregate.windowMs !== 2500) throw new Error("json windowMs not applied")
    const fromEnv = resolveConfig({ NOTIFY_CONFIG: cfgFile, NOTIFY_DINGTALK_WEBHOOK: "https://env.example/hook?access_token=E", NOTIFY_DINGTALK_SECRET: "env-sec", NOTIFY_DISABLE: "feishu" }, { stateDir: dir })
    if (fromEnv.channels.dingtalk.webhook !== "https://env.example/hook?access_token=E") throw new Error("env did not win")
    if (fromEnv.channels.dingtalk.secret !== "env-sec") throw new Error("env secret did not win")
    if (fromEnv.aggregate.windowMs !== 2500) throw new Error("json windowMs lost")
    if (!fromEnv.disabledChannels.includes("feishu")) throw new Error("NOTIFY_DISABLE not parsed")
    const defaults = resolveConfig({ NOTIFY_CONFIG: noConfig(dir) }, { stateDir: dir })
    if (!defaults.channels.dingtalk.enabled) throw new Error("dingtalk flag must default true (creds gate it)")
    if (dingtalkChannel.enabled(defaults)) throw new Error("dingtalk must be effectively off without creds")
    if (defaults.channels.dingtalk.webhook !== "") throw new Error("default webhook not empty")
    if (!defaults.channels["windows-toast"].enabled) throw new Error("toast must default on")
    if (defaults.aggregate.windowMs !== 10000) throw new Error("default windowMs")
    if (defaults.disabledChannels.length !== 0) throw new Error("default disable set")
    const credless = resolveConfig({ NOTIFY_CONFIG: noConfig(dir), NOTIFY_DINGTALK_WEBHOOK: "https://x/hook", NOTIFY_DINGTALK_SECRET: "" }, { stateDir: dir })
    if (dingtalkChannel.enabled(credless)) throw new Error("enabled with empty secret")
  },
])

// A9b: two-level config chain — project .opencode/notify.jsonc overrides global
// ~/.config/opencodeg/notify.jsonc (JSONC, comments allowed); env still wins.
scenarios.push([
  "A9b two-level config: global < project < env",
  async () => {
    const dir = tmpState()
    const globalCfg = path.join(dir, "global-notify.jsonc")
    const projRoot = path.join(dir, "proj")
    const projectCfg = path.join(projRoot, ".opencode", "notify.jsonc")
    mkdirSync(path.dirname(projectCfg), { recursive: true })
    writeFileSync(
      globalCfg,
      `// global layer (comments must be stripped)\n{\n  "channels": {\n    "dingtalk": { "enabled": true, "webhook": "https://global.example/hook?access_token=G", "secret": "g-sec" },\n    "feishu": { "enabled": false }\n  },\n  "aggregate": { "windowMs": 3000 }\n}\n`,
    )
    writeFileSync(
      projectCfg,
      `/* project layer */\n{\n  "channels": {\n    "dingtalk": { "webhook": "https://project.example/hook?access_token=P" },\n    "feishu": { "enabled": true }\n  },\n  "stopMode": "all-digest"\n}\n`,
    )
    const g = resolveConfig({}, { globalConfigPath: globalCfg, stateDir: dir })
    if (g.channels.dingtalk.webhook !== "https://global.example/hook?access_token=G") throw new Error("global webhook not applied")
    if (g.channels.dingtalk.secret !== "g-sec") throw new Error("global secret not applied")
    if (g.channels.feishu.enabled) throw new Error("global feishu switch not applied")
    if (g.aggregate.windowMs !== 3000) throw new Error("global windowMs not applied")
    // project overrides webhook + feishu switch; inherits global secret + windowMs
    const p = resolveConfig({}, { globalConfigPath: globalCfg, projectConfigPath: projectCfg, stateDir: dir })
    if (p.channels.dingtalk.webhook !== "https://project.example/hook?access_token=P") throw new Error("project webhook did not win")
    if (p.channels.dingtalk.secret !== "g-sec") throw new Error("global secret not inherited")
    if (!p.channels.feishu.enabled) throw new Error("project feishu switch did not win")
    if (p.aggregate.windowMs !== 3000) throw new Error("global windowMs not inherited")
    if (p.stopMode !== "all-digest") throw new Error("project stopMode not applied")
    // cwd derivation: opts.cwd resolves <cwd>/.opencode/notify.jsonc
    const viaCwd = resolveConfig({}, { globalConfigPath: globalCfg, cwd: projRoot, stateDir: dir })
    if (viaCwd.channels.dingtalk.webhook !== "https://project.example/hook?access_token=P") throw new Error("cwd-derived project config not applied")
    // env still beats both layers
    const e = resolveConfig(
      { NOTIFY_DINGTALK_WEBHOOK: "https://env.example/hook?access_token=E", NOTIFY_DINGTALK_SECRET: "e-sec" },
      { globalConfigPath: globalCfg, projectConfigPath: projectCfg, stateDir: dir },
    )
    if (e.channels.dingtalk.webhook !== "https://env.example/hook?access_token=E") throw new Error("env did not win over project")
    if (e.channels.dingtalk.secret !== "e-sec") throw new Error("env secret did not win over global")
    if (e.aggregate.windowMs !== 3000) throw new Error("file windowMs lost under env")
    // broken JSONC degrades to {} — chain falls through to defaults, never throws
    writeFileSync(projectCfg, `{ "channels": { "dingtalk": { "webhook": "https://x/h }`) // unterminated
    const broken = resolveConfig({}, { globalConfigPath: globalCfg, projectConfigPath: projectCfg, stateDir: dir })
    if (broken.channels.dingtalk.webhook !== "https://global.example/hook?access_token=G") throw new Error("broken project layer did not fall through to global")},
])

// A10: channel rejection never propagates; dispatch still resolves
scenarios.push([
  "A10 channel failure isolated",
  async () => {
    const dir = tmpState()
    const bad = fakeChannel("rejecting")
    const good = fakeChannel("cap")
    const logs: string[] = []
    const deps: DispatchDeps = { ...baseDeps(), channels: [bad.ch, good.ch], stateDir: dir, now: () => 1000, log: (l) => logs.push(l) }
    await dispatch(envOf("UserPromptSubmit", "ses_main_555555", { prompt: "x" }), deps)
    deps.now = () => 4000
    await dispatch(envOf("Stop", "ses_main_555555", { stop_hook_active: false }), deps)
    if (good.calls.length !== 1) throw new Error(`healthy channel skipped: ${good.calls.length}`)
    if (!logs.some((l) => l.includes("rejecting"))) throw new Error(`failure not logged: ${logs.join(",")}`)
  },
])

// A11 (G4): secrets never committable — ignore rules, empty example placeholders,
// and a credential-pattern content scan over the full deliverable file list
// (git ls-files --cached --others --exclude-standard). Scanning the worktree
// list catches leaks BEFORE staging; the old staged-only grep spun idle while
// nothing was staged. Token length gates (>=16) keep test fixtures with short
// placeholders (TESTTOKEN12) out of the heuristic.
const CRED_PATTERNS: Array<[string, RegExp]> = [
  ["long access_token", /access_token=[A-Za-z0-9_-]{16,}/],
  ["feishu bot hook path", /bot\/v2\/hook\/[A-Za-z0-9-]{16,}/],
  ["non-empty json secret", /"secret"\s*:\s*"[^"]{8,}"/],
]

scenarios.push([
  "A11 secret safety: gitignore + example placeholders + worktree credential scan",
  async () => {
    for (const p of [".opencode/hooks/notify/notify.config.json", ".opencode/hooks/notify/state/prompt-x.json", ".opencode/hooks/notify/logs/dispatcher.log"]) {
      const r = spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", p])
      if (r.status !== 0) throw new Error(`not ignored: ${p}`)
    }
    const example = readFileSync(path.join(HERE, "notify.config.json.example"), "utf8")
    const json = JSON.parse(example)
    const webhooks = [json.channels?.dingtalk?.webhook, json.channels?.feishu?.webhook, json.channels?.dingtalk?.secret, json.channels?.feishu?.secret]
    if (webhooks.some((v) => typeof v === "string" && v.length > 0)) throw new Error("example contains non-empty credential placeholders")
    const ls = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard", ".opencode/hooks/notify"])
    if (ls.status !== 0) throw new Error(`ls-files failed: ${ls.stderr}`)
    const files = ls.stdout.toString().trim().split("\n").filter(Boolean)
    if (files.length === 0) throw new Error("credential scan found no deliverable files — guard inert")
    for (const f of files) {
      const text = readFileSync(path.join(REPO_ROOT, f), "utf8")
      for (const [label, re] of CRED_PATTERNS) if (re.test(text)) throw new Error(`credential pattern "${label}" in ${f}`)
    }
  },
])

// A12: hooks wiring — all 5 events dispatch to dispatcher.ts
scenarios.push([
  "A12 hooks.json wiring",
  async () => {
    const local = path.resolve(HERE, "../../../.opencode/hooks.json")
    const example = path.join(HERE, "hooks.example.json")
    let file = example
    try {
      readFileSync(local)
      file = local
    } catch {}
    const wiring = JSON.parse(readFileSync(file, "utf8"))
    const events = ["Stop", "StopFailure", "PermissionRequest", "Notification", "UserPromptSubmit", "QuestionAsked"]
    const missing = events.filter((ev) => {
      const entries = wiring[ev]
      if (!Array.isArray(entries)) return true
      return !entries.some((m: any) => (m.hooks ?? []).some((h: any) => typeof h.command === "string" && h.command.includes("hooks/notify/dispatcher.ts")))
    })
    if (missing.length) throw new Error(`${path.basename(file)} missing dispatcher wiring for: ${missing.join(",")}`)
  },
])

// Subprocess: dispatcher always exits 0 (garbage stdin; all channels disabled)
scenarios.push([
  "A10b dispatcher exits 0 on garbage stdin",
  async () => {
    const dir = tmpState()
    const r = spawnSync("bun", [path.join(HERE, "dispatcher.ts")], {
      input: "not-json{{",
      env: { ...process.env, NOTIFY_STATE_DIR: dir, NOTIFY_DISABLE: "windows-toast,dingtalk,feishu", NOTIFY_CONFIG: path.join(dir, "none.json") },
    })
    if (r.status !== 0) throw new Error(`exit=${r.status} stderr=${r.stderr}`)
    const r2 = spawnSync("bun", [path.join(HERE, "dispatcher.ts")], {
      input: JSON.stringify(envOf("StopFailure", "ses_sub_900001", { error: "x" })),
      env: { ...process.env, NOTIFY_STATE_DIR: dir, NOTIFY_DISABLE: "windows-toast,dingtalk,feishu", NOTIFY_CONFIG: path.join(dir, "none.json") },
    })
    if (r2.status !== 0) throw new Error(`stopfailure exit=${r2.status} stderr=${r2.stderr}`)
  },
])

// A13 (F1): the scoped .gitignore itself must be committable — fresh clones need the
// anti-secret rules — while the real secrets stay check-ignored. Committable =
// tracked or untracked-but-not-ignored (ls-files); `git add -n` only lists files
// needing update, so it stopped listing the file once it was committed.
scenarios.push([
  "A13 gitignore deliverable: tracked/unignored rule file, secrets still ignored",
  async () => {
    const ls0 = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard", ".opencode/hooks/notify/.gitignore"])
    if (ls0.status !== 0) throw new Error(`ls-files failed: ${ls0.stderr}`)
    if (!ls0.stdout.toString().trim()) throw new Error(`scoped .gitignore neither tracked nor committable (ignored by a parent rule?)`)
    for (const p of [".opencode/hooks/notify/notify.config.json", ".opencode/hooks/notify/state/prompt-x.json", ".opencode/hooks/notify/logs/dispatcher.log"]) {
      if (spawnSync("git", ["-C", REPO_ROOT, "check-ignore", "-q", p]).status !== 0) throw new Error(`secret no longer ignored: ${p}`)
    }
  },
])

// A14 (F2): fileLog must append — two consecutive writes, both lines survive on disk
scenarios.push([
  "A14 fileLog appends (no truncate)",
  async () => {
    const dir = tmpState()
    const logs = path.join(dir, "logs")
    const log = fileLog(resolveConfig({ NOTIFY_CONFIG: noConfig(dir) }, { stateDir: dir, logDir: logs }))
    log("first dispatch line")
    log("second dispatch line")
    const content = readFileSync(path.join(logs, "dispatcher.log"), "utf8")
    if (!content.includes("first dispatch line") || !content.includes("second dispatch line")) throw new Error(`log truncated, content: ${JSON.stringify(content)}`)
  },
])

// A15 (F3): delivery fingerprint recorded in README must be reproducible with the recorded command
scenarios.push([
  "A15 delivery fingerprint reproducible from README",
  async () => {
    const md = readFileSync(path.join(HERE, "README.md"), "utf8")
    const cmd = md.match(/`(git ls-files[^`\n]+)`/)?.[1]
    if (!cmd) throw new Error("README 未记载指纹复现命令")
    if (!cmd.includes("LC_ALL=C sort")) throw new Error("指纹命令未对 sort 钉 LC_ALL=C（文件顺序须与 locale 无关）")
    const claimed = md.match(/sha256:([0-9a-f]{64})/)?.[1]
    if (!claimed) throw new Error("README 未记载 sha256 指纹值")
    const count = md.match(/(\d+) 个文件/)?.[1]
    if (!count) throw new Error("README 未记载文件计数")
    const r = spawnSync("bash", ["-c", cmd], { cwd: REPO_ROOT })
    if (r.status !== 0) throw new Error(`指纹命令执行失败: ${r.stderr}`)
    const got = r.stdout.toString().trim().split(/\s+/)[0]
    if (got !== claimed) throw new Error(`指纹不可复现: got ${got} ≠ claimed ${claimed}`)
    const ls = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard", ".opencode/hooks/notify"])
    const files = ls.stdout.toString().trim().split("\n").filter(Boolean)
    if (files.length !== Number(count)) throw new Error(`文件计数不符: got ${files.length} ≠ claimed ${count}`)
  },
])

// A16 (G1): windows-toast spawn contract, fully offline via fake spawnImpl —
// powershell hardening flags in order, the script as ONE base64 arg that
// decodes back to the XML-escaped toastXml (quotes/angle brackets/& in title
// and body all escaped), and a non-zero subprocess exit logged (not thrown).
scenarios.push([
  "A16 windows-toast: flags + base64 toastXml + exit!=0 logged",
  async () => {
    const cfg = resolveConfig({ NOTIFY_CONFIG: noConfig(tmpState()) }, { stateDir: tmpState() })
    const title = `T&t"l<e>`
    const body = `B&o"d<y 'q' <tag>`
    const okLogs: string[] = []
    const ok = fakeSpawn(0)
    await windowsToastChannel.send(
      { kind: "normal", title, body, event: "Stop" },
      { cfg, fetchImpl: (async () => new Response("{}")) as typeof fetch, spawnImpl: ok.impl, now: () => 0, log: (l) => okLogs.push(l) },
    )
    if (ok.cmds.length !== 1) throw new Error(`expected exactly 1 spawn, got ${ok.cmds.length}`)
    const [exe, ...args] = ok.cmds[0]
    if (!exe.includes("powershell")) throw new Error(`exe not powershell: ${exe}`)
    const flags = args.slice(0, 5).join(" ")
    if (flags !== "-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command") throw new Error(`hardening flags: ${flags}`)
    if (args.length !== 6) throw new Error(`expected exactly 1 script arg after -Command, got ${args.length - 5}`)
    // The toastXml rides INSIDE the single -Command script as one base64 payload
    // (no quote hell) — extract and decode it, not the whole script.
    const b64 = args[5].match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)?.[1]
    if (!b64) throw new Error(`no embedded base64 payload in -Command script: ${args[5].slice(0, 120)}`)
    const decoded = Buffer.from(b64, "base64").toString("utf8")
    if (decoded !== toastXml(title, body)) throw new Error(`base64 arg does not decode to toastXml: ${decoded}`)
    for (const esc of ["&amp;", "&lt;", "&gt;", "&quot;", "&apos;"]) if (!decoded.includes(esc)) throw new Error(`missing XML escape ${esc}: ${decoded}`)
    for (const raw of [title, body, "<tag>"]) if (decoded.includes(raw)) throw new Error(`raw special chars leaked into XML: ${decoded}`)
    const badLogs: string[] = []
    const bad = fakeSpawn(1, "synthetic ps stderr")
    await windowsToastChannel.send(
      { kind: "normal", title, body, event: "Stop" },
      { cfg, fetchImpl: (async () => new Response("{}")) as typeof fetch, spawnImpl: bad.impl, now: () => 0, log: (l) => badLogs.push(l) },
    )
    if (!badLogs.some((l) => l.includes("powershell exited 1"))) throw new Error(`non-zero exit not logged: ${badLogs.join(",")}`)
    if (badLogs.some((l) => l.includes("windows-toast channel error"))) throw new Error(`non-zero exit must stay on the log path, not the catch path: ${badLogs.join(",")}`)
  },
])

// A16b (G1 companion): dry-run logs must mask credentials — dingtalk
// access_token=***, feishu hook/*** — never the raw token.
scenarios.push([
  "A16b dry-run log masking: access_token=*** + hook/***",
  async () => {
    const dingLogs: string[] = []
    const dingCfg = resolveConfig(
      { NOTIFY_CONFIG: noConfig(tmpState()), NOTIFY_DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=TESTTOKEN12", NOTIFY_DINGTALK_SECRET: VEC_SECRET, NOTIFY_DRYRUN: "1" },
      { stateDir: tmpState() },
    )
    await dingtalkChannel.send(
      { kind: "normal", title: "t", body: "b", event: "Stop" },
      { cfg: dingCfg, fetchImpl: (async () => new Response("{}")) as typeof fetch, spawnImpl: Bun.spawn, now: () => VEC_MS, log: (l) => dingLogs.push(l) },
    )
    if (!dingLogs.some((l) => l.includes("access_token=***"))) throw new Error(`dingtalk dry-run unmasked: ${dingLogs.join(",")}`)
    if (dingLogs.some((l) => l.includes("TESTTOKEN12"))) throw new Error(`dingtalk token leaked to log: ${dingLogs.join(",")}`)
    const feiLogs: string[] = []
    const feiCfg = resolveConfig(
      { NOTIFY_CONFIG: noConfig(tmpState()), NOTIFY_FEISHU_WEBHOOK: "https://open.feishu.cn/open-apis/bot/v2/hook/TESTTOKEN12", NOTIFY_FEISHU_SECRET: VEC_SECRET, NOTIFY_DRYRUN: "1" },
      { stateDir: tmpState() },
    )
    await feishuChannel.send(
      { kind: "normal", title: "t", body: "b", event: "Stop" },
      { cfg: feiCfg, fetchImpl: (async () => new Response("{}")) as typeof fetch, spawnImpl: Bun.spawn, now: () => VEC_MS, log: (l) => feiLogs.push(l) },
    )
    if (!feiLogs.some((l) => l.includes("hook/***"))) throw new Error(`feishu dry-run unmasked: ${feiLogs.join(",")}`)
    if (feiLogs.some((l) => l.includes("TESTTOKEN12"))) throw new Error(`feishu token leaked to log: ${feiLogs.join(",")}`)
  },
])

// A17: QuestionAsked — critical notification with project (cwd basename) /
// title / short session code / description; suppressed within 10s after an
// elicitation-type Notification (MCP elicitation already notified).
scenarios.push([
  "A17 QuestionAsked: render + elicitation double-notify suppression",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const deps = { ...baseDeps({ stateDir: dir, channels: [ch] }), now: () => 1000 }
    await dispatch(
      envOf("QuestionAsked", "ses_main_888888", {
        title: "方案选择",
        questions: [{ question: "选择哪个方案继续？A 还是 B", header: "方案选择" }],
      }),
      deps,
    )
    if (calls.length !== 1) throw new Error(`expected 1 call, got ${calls.length}`)
    const n = calls[0]
    if (n.title !== "OpenCode: 需要你回答 [888888]") throw new Error(`title: ${n.title}`)
    if (n.kind !== "critical") throw new Error(`kind: ${n.kind}`)
    if (!n.body.includes("OpenCode-GraphAgent")) throw new Error(`body missing project name: ${n.body}`)
    if (!n.body.includes("方案选择")) throw new Error(`body missing title: ${n.body}`)
    if (!n.body.includes("选择哪个方案继续")) throw new Error(`body missing description: ${n.body}`)
    // header fallback when title absent
    await dispatch(envOf("QuestionAsked", "ses_main_777777", { questions: [{ question: "q2", header: "回退标题" }] }), deps)
    if (calls.length !== 2) throw new Error(`fallback render missing, got ${calls.length}`)
    if (!calls[1].body.includes("回退标题")) throw new Error(`header fallback not used: ${calls[1].body}`)

    // suppression: Notification(elicitation) at t=1000, QuestionAsked at t=5000 → silent
    const dir2 = tmpState()
    const { ch: ch2, calls: calls2 } = fakeChannel("cap")
    const deps2 = { ...baseDeps({ stateDir: dir2, channels: [ch2] }), now: () => 1000 }
    await dispatch(envOf("Notification", "ses_main_999999", { message: "MCP elicitation", notification_type: "elicitation" }), deps2)
    deps2.now = () => 5000
    await dispatch(envOf("QuestionAsked", "ses_main_999999", { questions: [{ question: "q", header: "h" }] }), deps2)
    if (calls2.length !== 1) throw new Error(`QuestionAsked should be suppressed within 10s of elicitation, got ${calls2.length}`)
    // window elapsed (t=11001) → QuestionAsked passes again
    deps2.now = () => 11001
    await dispatch(envOf("QuestionAsked", "ses_main_999999", { questions: [{ question: "q", header: "h" }] }), deps2)
    if (calls2.length !== 2) throw new Error(`QuestionAsked should pass after 10s window, got ${calls2.length}`)
    // non-elicitation Notification does NOT arm the suppression
    const dir3 = tmpState()
    const { ch: ch3, calls: calls3 } = fakeChannel("cap")
    const deps3 = { ...baseDeps({ stateDir: dir3, channels: [ch3] }), now: () => 1000 }
    await dispatch(envOf("Notification", "ses_main_666666", { message: "普通通知" }), deps3)
    deps3.now = () => 2000
    await dispatch(envOf("QuestionAsked", "ses_main_666666", { questions: [{ question: "q3", header: "h3" }] }), deps3)
    if (calls3.length !== 2) throw new Error(`plain Notification must not suppress QuestionAsked, got ${calls3.length}`)
  },
])

// A18: event-level switches + per-channel template rendering. Template files are
// plain .txt (first line = title, rest = body) resolved in order project >
// global > module-default dirs; channel template beats event template; a
// disabled event (incl. digest) silences dispatch entirely. No template
// configured → compiled hardcoded copy (covered by A2/A3/A4/A17).
scenarios.push([
  "A18 event switches + template resolution/rendering",
  async () => {
    const dir = tmpState()
    const projTpl = path.join(dir, "proj-templates")
    const globalTpl = path.join(dir, "global-templates")
    mkdirSync(projTpl, { recursive: true })
    mkdirSync(globalTpl, { recursive: true })
    writeFileSync(path.join(projTpl, "stop.txt"), "PROJ {code}\n{summary}\n\n\n尾部 {code}\n\n")
    writeFileSync(path.join(globalTpl, "stop.txt"), "GLOBAL {code}\n{summary}") // must lose to project layer
    writeFileSync(path.join(globalTpl, "cap-stop.txt"), "CAP[{code}]\n耗时 {duration}\n{missing}")
    const cfgFile = path.join(dir, "events.jsonc")
    writeFileSync(
      cfgFile,
      JSON.stringify({
        events: {
          stop: { template: "stop.txt", channels: { cap: { template: "cap-stop.txt" } } },
          digest: { enabled: false },
        },
      }),
    )
    const cfg = resolveConfig({ NOTIFY_CONFIG: cfgFile }, { stateDir: dir, globalTemplatesDir: globalTpl, projectTemplatesDir: projTpl })
    const cap = fakeChannel("cap") // channel-level template (file only in global layer)
    const cap2 = fakeChannel("cap2") // event-level template (project layer wins over global)
    const deps: DispatchDeps = { ...baseDeps(), cfg, channels: [cap.ch, cap2.ch], stateDir: dir, now: () => 1000 }
    await dispatch(envOf("UserPromptSubmit", "ses_main_121212", { prompt: "hi" }), deps)
    deps.now = () => 1000 + 192000
    await dispatch(envOf("Stop", "ses_main_121212", { stop_hook_active: false, last_assistant_message: "模板渲染摘要" }), deps)
    if (cap2.calls.length !== 1) throw new Error(`event-template channel calls: ${cap2.calls.length}`)
    if (cap2.calls[0].title !== "PROJ 121212") throw new Error(`event template title: ${cap2.calls[0].title}`)
    if (cap2.calls[0].body !== "模板渲染摘要\n\n尾部 121212") throw new Error(`blank-line collapse: ${JSON.stringify(cap2.calls[0].body)}`)
    if (cap.calls.length !== 1) throw new Error(`channel-template channel calls: ${cap.calls.length}`)
    if (cap.calls[0].title !== "CAP[121212]") throw new Error(`channel template title: ${cap.calls[0].title}`)
    if (cap.calls[0].body !== "耗时 3m12s") throw new Error(`channel template body: ${JSON.stringify(cap.calls[0].body)}`)

    // events.stop.enabled=false → dispatch silences Stop (timing stamp still recorded)
    const offCfgFile = path.join(dir, "off.jsonc")
    writeFileSync(offCfgFile, JSON.stringify({ events: { stop: { enabled: false } } }))
    const dir2 = tmpState()
    const off = fakeChannel("cap")
    const offDeps: DispatchDeps = {
      ...baseDeps(),
      cfg: resolveConfig({ NOTIFY_CONFIG: offCfgFile }, { stateDir: dir2 }),
      channels: [off.ch],
      stateDir: dir2,
      now: () => 1000,
    }
    await dispatch(envOf("UserPromptSubmit", "ses_main_131313", { prompt: "x" }), offDeps)
    offDeps.now = () => 193000
    await dispatch(envOf("Stop", "ses_main_131313", { stop_hook_active: false }), offDeps)
    if (off.calls.length !== 0) throw new Error(`disabled stop still notified: ${off.calls.map((c) => c.title).join(",")}`)

    // events.digest.enabled=false → buffered Stops flush to nothing
    const digestCfg = resolveConfig({ NOTIFY_CONFIG: cfgFile }, { stateDir: dir2, globalTemplatesDir: globalTpl, projectTemplatesDir: projTpl })
    digestCfg.aggregate.windowMs = 1
    const dir3 = tmpState()
    const dig = fakeChannel("cap")
    const digDeps: DispatchDeps = { ...baseDeps(), cfg: digestCfg, channels: [dig.ch], stateDir: dir3, now: () => Date.now(), sleep: realSleep }
    await Promise.all(["ses_sub_300001", "ses_sub_300002"].map((sid) => dispatch(envOf("Stop", sid, { stop_hook_active: false }), digDeps)))
    if (dig.calls.length !== 0) throw new Error(`disabled digest still flushed: ${dig.calls.map((c) => c.title).join(",")}`)
  },
])

// A19: template spec that cannot be satisfied → compiled hardcoded copy (the A2/A3/A4/A17
// literals). Two distinct fallback branches in the render pipeline: (1) spec names a file
// no layer has → resolveTemplateFile returns undefined → renderedCopy returns the
// notification untouched (registry.ts "file === undefined" path); (2) absolute spec that
// exists but is not a readable file (a directory) → readFileSync throws → the registry.ts
// catch logs "unreadable, using default copy" and returns the default. Both must be
// byte-identical (===) to the template-less baseline dispatch of the same envelope.
scenarios.push([
  "A19 missing/unreadable template → compiled hardcoded copy",
  async () => {
    const dir = tmpState()
    const summary = "模板缺失回退硬编码文案验证"
    const run = async (cfgFile: string, logs: string[]) => {
      const { ch, calls } = fakeChannel("cap")
      const deps: DispatchDeps = {
        ...baseDeps(),
        cfg: resolveConfig({ NOTIFY_CONFIG: cfgFile }, { stateDir: dir }),
        channels: [ch],
        stateDir: dir,
        now: () => 1000,
        log: (l) => logs.push(l),
      }
      await dispatch(envOf("UserPromptSubmit", "ses_main_191919", { prompt: "hi" }), deps)
      deps.now = () => 1000 + 192000
      await dispatch(envOf("Stop", "ses_main_191919", { stop_hook_active: false, last_assistant_message: summary }), deps)
      return calls
    }
    const baseLogs: string[] = []
    const base = await run(noConfig(dir), baseLogs)
    if (base.length !== 1) throw new Error(`baseline calls: ${base.length}`)
    if (base[0].title !== "OpenCode: 回合完成 [191919]") throw new Error(`baseline title: ${base[0].title}`)
    if (base[0].body !== `耗时 3m12s\n${summary}`) throw new Error(`baseline body: ${base[0].body}`)

    // (1) spec hits no layer (project > global > module-default all miss) → silent fallback
    const missCfg = path.join(dir, "missing-template.jsonc")
    writeFileSync(missCfg, JSON.stringify({ events: { stop: { template: "no-such-template.txt" } } }))
    const missLogs: string[] = []
    const miss = await run(missCfg, missLogs)
    if (miss.length !== 1) throw new Error(`missing-template calls: ${miss.length}`)
    if (miss[0].title !== base[0].title || miss[0].body !== base[0].body) throw new Error(`missing-template copy diverged: ${JSON.stringify(miss[0])}`)
    if (missLogs.some((l) => l.includes("unreadable"))) throw new Error(`unresolvable spec must take the undefined path, not the catch path: ${missLogs.join(",")}`)

    // (2) absolute spec that exists but is a directory → readFileSync throws → catch path + log
    const notAFile = path.join(dir, "not-a-file")
    mkdirSync(notAFile)
    const unreadCfg = path.join(dir, "unreadable-template.jsonc")
    writeFileSync(unreadCfg, JSON.stringify({ events: { stop: { template: notAFile } } }))
    const unreadLogs: string[] = []
    const unread = await run(unreadCfg, unreadLogs)
    if (unread.length !== 1) throw new Error(`unreadable-template calls: ${unread.length}`)
    if (unread[0].title !== base[0].title || unread[0].body !== base[0].body) throw new Error(`unreadable-template copy diverged: ${JSON.stringify(unread[0])}`)
    if (!unreadLogs.some((l) => l.includes("unreadable, using default copy"))) throw new Error(`catch-path fallback not logged: ${unreadLogs.join(",")}`)
  },
])

// A20: new-structure config paths positive read — the resolveConfig candidate table must
// pick <cwd>/.opencode/notify/notify.jsonc (project) and ~/.config/opencodeg/notify/
// notify.jsonc (global) FIRST, with the legacy flat notify.jsonc files still serving when
// the new file is absent (an upgrade never drops config, and old files never shadow new
// ones). Global default-path derivation is exercised hermetically by faking os.homedir
// (restored in finally). Every asserted key is explicitly set in the layer that must win,
// so the developer's real local/deprecated files cannot perturb the outcome.
scenarios.push([
  "A20 new-structure notify/notify.jsonc read: project + global + legacy fallback",
  async () => {
    const dir = tmpState()
    const fakeHome = path.join(dir, "fake-home")
    const globalNew = path.join(fakeHome, ".config", "opencodeg", "notify", "notify.jsonc")
    mkdirSync(path.dirname(globalNew), { recursive: true })
    writeFileSync(globalNew, `// 全局新结构（注释须被剥离）\n{ "channels": { "dingtalk": { "webhook": "https://newglobal.example/hook?access_token=GN", "secret": "gn-sec" } }, "aggregate": { "windowMs": 2600 } }\n`)
    writeFileSync(path.join(fakeHome, ".config", "opencodeg", "notify.jsonc"), `{ "channels": { "dingtalk": { "webhook": "https://oldglobal.example/hook?access_token=OG" } }, "aggregate": { "windowMs": 2900 } }\n`)

    const realHomedir = os.homedir
    os.homedir = () => fakeHome
    try {
      // global layer alone (cwd without any project file)
      const bareProj = path.join(dir, "bare-proj")
      mkdirSync(bareProj)
      const g = resolveConfig({}, { cwd: bareProj, stateDir: dir })
      if (g.channels.dingtalk.webhook !== "https://newglobal.example/hook?access_token=GN") throw new Error(`global notify/notify.jsonc not read: ${g.channels.dingtalk.webhook}`)
      if (g.channels.dingtalk.secret !== "gn-sec") throw new Error("global new-structure secret not applied")
      if (g.aggregate.windowMs !== 2600) throw new Error(`legacy global must lose the candidate race: ${g.aggregate.windowMs}`)
      if (g.globalTemplatesDir !== path.join(fakeHome, ".config", "opencodeg", "notify", "templates")) throw new Error(`globalTemplatesDir derivation: ${g.globalTemplatesDir}`)

      // project layer: new structure wins over legacy flat; global inherited below it
      const projRoot = path.join(dir, "proj")
      const projNew = path.join(projRoot, ".opencode", "notify", "notify.jsonc")
      mkdirSync(path.dirname(projNew), { recursive: true })
      writeFileSync(projNew, `// 项目新结构\n{ "channels": { "dingtalk": { "webhook": "https://newproj.example/hook?access_token=NP", "secret": "np-sec" } }, "events": { "stop": { "template": "proj-stop.txt" } } }\n`)
      writeFileSync(path.join(projRoot, ".opencode", "notify.jsonc"), `{ "channels": { "dingtalk": { "webhook": "https://oldproj.example/hook?access_token=OP" } }, "events": { "stop": { "template": "legacy-stop.txt" } } }\n`)
      const p = resolveConfig({}, { cwd: projRoot, stateDir: dir })
      if (p.channels.dingtalk.webhook !== "https://newproj.example/hook?access_token=NP") throw new Error(`project notify/notify.jsonc not preferred: ${p.channels.dingtalk.webhook}`)
      if (p.channels.dingtalk.secret !== "np-sec") throw new Error("project new-structure secret not applied")
      if (p.events.stop.template !== "proj-stop.txt") throw new Error(`events parsed from the wrong layer: ${p.events.stop.template}`)
      if (p.aggregate.windowMs !== 2600) throw new Error(`global new-structure not inherited: ${p.aggregate.windowMs}`)
      if (p.projectTemplatesDir !== path.join(projRoot, ".opencode", "notify", "templates")) throw new Error(`projectTemplatesDir derivation: ${p.projectTemplatesDir}`)

      // legacy fallback: new file absent → flat notify.jsonc still serves
      const legacyProj = path.join(dir, "legacy-proj")
      mkdirSync(path.join(legacyProj, ".opencode"), { recursive: true })
      writeFileSync(path.join(legacyProj, ".opencode", "notify.jsonc"), `{ "channels": { "dingtalk": { "webhook": "https://legacyproj.example/hook?access_token=LP" } }, "events": { "stop": { "template": "legacy-stop.txt" } } }\n`)
      const legacy = resolveConfig({}, { cwd: legacyProj, stateDir: dir })
      if (legacy.channels.dingtalk.webhook !== "https://legacyproj.example/hook?access_token=LP") throw new Error(`legacy project fallback not read: ${legacy.channels.dingtalk.webhook}`)
      if (legacy.channels.dingtalk.secret !== "gn-sec") throw new Error("legacy project layer must still inherit global secret")
      if (legacy.events.stop.template !== "legacy-stop.txt") throw new Error(`legacy events fallback: ${legacy.events.stop.template}`)
    } finally {
      os.homedir = realHomedir
    }
  },
])

// A21 (structured vars): UserPromptSubmit prompt persists as the Stop/StopFailure
// task title (oneLine'd); full sessionId + zh eventLabel + project ride vars;
// a legacy {ts}-only stamp file degrades prompt to "".
scenarios.push([
  "A21 prompt→taskTitle flow + full sessionId/eventLabel vars",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const deps = { ...baseDeps({ stateDir: dir, channels: [ch] }), now: () => 1000 }
    await dispatch(envOf("UserPromptSubmit", "ses_main_211111", { prompt: "  重构认证模块\n并补齐测试  " }), deps)
    deps.now = () => 1000 + 192000
    await dispatch(envOf("Stop", "ses_main_211111", { stop_hook_active: false, last_assistant_message: "完成" }), deps)
    if (calls.length !== 1) throw new Error(`expected 1 call, got ${calls.length}`)
    const stop = calls[0]
    if (stop.vars?.taskTitle !== "重构认证模块 并补齐测试") throw new Error(`taskTitle: ${stop.vars?.taskTitle}`)
    if (stop.vars?.sessionId !== "ses_main_211111") throw new Error(`sessionId: ${stop.vars?.sessionId}`)
    if (stop.vars?.eventLabel !== "回合完成") throw new Error(`eventLabel: ${stop.vars?.eventLabel}`)
    if (stop.vars?.project !== "OpenCode-GraphAgent") throw new Error(`project: ${stop.vars?.project}`)

    // StopFailure consumes the same stamp → taskTitle flows; no stamp → ""
    await dispatch(envOf("UserPromptSubmit", "ses_main_232323", { prompt: "修登录超时" }), deps)
    deps.now = () => 1000 + 200000
    await dispatch(envOf("StopFailure", "ses_main_232323", { stop_hook_active: false, error: "provider 502" }), deps)
    const fail = calls[1]
    if (fail.vars?.taskTitle !== "修登录超时") throw new Error(`stopFailure taskTitle: ${fail.vars?.taskTitle}`)
    if (fail.vars?.sessionId !== "ses_main_232323") throw new Error(`stopFailure sessionId: ${fail.vars?.sessionId}`)
    if (fail.vars?.eventLabel !== "回合失败") throw new Error(`stopFailure eventLabel: ${fail.vars?.eventLabel}`)
    await dispatch(envOf("StopFailure", "ses_main_242424", { stop_hook_active: false, error: "x" }), deps)
    if (calls[2].vars?.taskTitle !== "") throw new Error(`stampless taskTitle: ${calls[2].vars?.taskTitle}`)

    // legacy {ts}-only stamp (pre-upgrade file) → prompt degrades to "", ts still serves duration
    writeFileSync(path.join(dir, "prompt-ses_main_252525.json"), JSON.stringify({ ts: 1000 + 300000 }))
    deps.now = () => 1000 + 492000
    await dispatch(envOf("Stop", "ses_main_252525", { stop_hook_active: false, last_assistant_message: "旧格式" }), deps)
    const legacy = calls[3]
    if (legacy.vars?.taskTitle !== "") throw new Error(`legacy taskTitle: ${legacy.vars?.taskTitle}`)
    if (!legacy.body.includes("3m12s")) throw new Error(`legacy duration lost: ${legacy.body}`)
  },
])

// A22 (event label map): the six-value plaintext mapping is exactly the
// documented table; PermissionRequest/Notification/QuestionAsked vars carry
// full sessionId + their label + project (+ empty taskTitle).
scenarios.push([
  "A22 event label map (6 values) + vars on remaining branches",
  async () => {
    const want = { stop: "回合完成", stopFailure: "回合失败", permissionRequest: "需要你批准", notification: "通知", questionAsked: "需要你回答", digest: "并行回合完成" }
    if (JSON.stringify(EVENT_LABELS) !== JSON.stringify(want)) throw new Error(`EVENT_LABELS: ${JSON.stringify(EVENT_LABELS)}`)
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const deps = { ...baseDeps({ stateDir: dir, channels: [ch] }), now: () => 1000 }
    await dispatch(envOf("PermissionRequest", "ses_main_262626", { tool_name: "Bash", tool_input: { command: "ls" } }), deps)
    // 推进时钟越过 PermissionRequest 的 8s 抑制窗（A5 行为），Notification 才不被吞
    deps.now = () => 9001
    await dispatch(envOf("Notification", "ses_main_272727", { message: "等待输入" }), deps)
    await dispatch(envOf("QuestionAsked", "ses_main_282828", { title: "t", questions: [{ question: "q", header: "h" }] }), deps)
    const [perm, noti, qa] = calls
    if (perm.vars?.eventLabel !== "需要你批准" || perm.vars?.sessionId !== "ses_main_262626" || perm.vars?.project !== "OpenCode-GraphAgent" || perm.vars?.taskTitle !== "")
      throw new Error(`permissionRequest vars: ${JSON.stringify(perm.vars)}`)
    if (noti.vars?.eventLabel !== "通知" || noti.vars?.sessionId !== "ses_main_272727") throw new Error(`notification vars: ${JSON.stringify(noti.vars)}`)
    if (qa.vars?.eventLabel !== "需要你回答" || qa.vars?.sessionId !== "ses_main_282828") throw new Error(`questionAsked vars: ${JSON.stringify(qa.vars)}`)
  },
])

// A23 (digest structured vars): digest vars carry taskTitle "" and the FULL
// session id list; the compiled body keeps short codes for compact channels.
scenarios.push([
  "A23 digest vars: empty taskTitle, full-ID sessions",
  async () => {
    const dir = tmpState()
    const { ch, calls } = fakeChannel("cap")
    const cfg = resolveConfig({ NOTIFY_CONFIG: noConfig(dir) }, { stateDir: dir })
    cfg.aggregate.windowMs = 150
    const deps: DispatchDeps = { ...baseDeps(), cfg, channels: [ch], stateDir: dir, now: () => Date.now(), sleep: realSleep }
    await Promise.all(["ses_sub_510001", "ses_sub_510002"].map((sid) => dispatch(envOf("Stop", sid, { stop_hook_active: false }), deps)))
    if (calls.length !== 1) throw new Error(`expected 1 digest, got ${calls.length}`)
    const n = calls[0]
    if (n.vars?.taskTitle !== "") throw new Error(`digest taskTitle: ${JSON.stringify(n.vars?.taskTitle)}`)
    if (n.vars?.sessions !== "ses_sub_510001,ses_sub_510002") throw new Error(`digest sessions: ${n.vars?.sessions}`)
    if (n.vars?.eventLabel !== "并行回合完成") throw new Error(`digest eventLabel: ${n.vars?.eventLabel}`)
    if (!n.body.includes("510001") || !n.body.includes("510002")) throw new Error(`digest body short codes lost: ${n.body}`)
  },
])

// A24 (dingtalk structured markdown): eventLabel present → 标题行（项目名 + 会话 id +
// 通知类型）/ --- 分割线 / 描述（digest 退化为「类型 (数量)」标题 + 会话全 ID 列表行）;
// custom keyword missing from the message → prefix fallback still hits;
// vars without eventLabel → legacy title+body bytes (template path unregressed).
scenarios.push([
  "A24 dingtalk structured markdown + keyword fallback + legacy fallback",
  async () => {
    const seen: Array<{ url: string; body: any }> = []
    const cfg = resolveConfig(
      { NOTIFY_CONFIG: noConfig(tmpState()), NOTIFY_DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=TESTTOKEN", NOTIFY_DINGTALK_SECRET: VEC_SECRET },
      { stateDir: tmpState() },
    )
    const ctx = {
      cfg,
      fetchImpl: (async (url: any, init: any) => {
        seen.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response('{"errcode":0,"errmsg":"ok"}')
      }) as typeof fetch,
      spawnImpl: Bun.spawn,
      now: () => VEC_MS,
      log: () => {},
    }
    await dingtalkChannel.send(
      {
        kind: "normal",
        title: "OpenCode: 回合完成 [222222]",
        body: "耗时 3m12s\n已完成重构",
        event: "Stop",
        vars: { code: "222222", duration: "3m12s", summary: "已完成重构", taskTitle: "重构认证模块", sessionId: "ses_main_222222", eventLabel: "回合完成", project: "OpenCode-GraphAgent" },
      },
      ctx,
    )
    const md = seen[0].body.markdown
    if (md.title !== "OpenCode-GraphAgent ses_main_222222 回合完成") throw new Error(`title: ${md.title}`)
    const expectText = [
      "**OpenCode-GraphAgent ses_main_222222 回合完成**",
      "---",
      "任务: 重构认证模块",
      "耗时 3m12s",
      "已完成重构",
    ].join("\n\n")
    if (md.text !== expectText) throw new Error(`structured text: ${JSON.stringify(md.text)}`)

    // digest: no single session/project → title degrades to 类型 (数量); the full-ID
    // sessions list rides below the divider as its own 会话 line
    seen.length = 0
    await dingtalkChannel.send(
      { kind: "digest", title: "OpenCode: 2 个并行回合完成", body: "会话: 510001,510002", event: "Stop", vars: { count: "2", sessions: "ses_sub_510001,ses_sub_510002", taskTitle: "", sessionId: "", eventLabel: "并行回合完成" } },
      ctx,
    )
    const dig = seen[0].body.markdown
    if (dig.title !== "并行回合完成 (2)") throw new Error(`digest title: ${dig.title}`)
    // digest 文本无项目名 → 默认关键词兜底前置 "OpenCode"
    if (!dig.text.endsWith("**并行回合完成 (2)**\n\n---\n\n会话: ses_sub_510001,ses_sub_510002\n\n会话: 510001,510002")) throw new Error(`digest text: ${JSON.stringify(dig.text)}`)

    // custom keyword absent from the message → prefix fallback still prepends
    const dir = tmpState()
    const kwCfgFile = path.join(dir, "kw.jsonc")
    writeFileSync(kwCfgFile, JSON.stringify({ channels: { dingtalk: { keyword: "专属关键词" } } }))
    const kwCfg = resolveConfig(
      { NOTIFY_CONFIG: kwCfgFile, NOTIFY_DINGTALK_WEBHOOK: "https://oapi.dingtalk.com/robot/send?access_token=TESTTOKEN", NOTIFY_DINGTALK_SECRET: VEC_SECRET },
      { stateDir: dir },
    )
    seen.length = 0
    await dingtalkChannel.send(
      { kind: "normal", title: "OpenCode: 回合完成 [222222]", body: "耗时 3m12s", event: "Stop", vars: { eventLabel: "回合完成", sessionId: "ses_main_222222" } },
      { ...ctx, cfg: kwCfg },
    )
    if (!seen[0].body.markdown.text.startsWith("专属关键词\n\n")) throw new Error(`keyword fallback missing: ${seen[0].body.markdown.text}`)

    // vars present but eventLabel missing → byte-identical legacy title+body copy
    seen.length = 0
    await dingtalkChannel.send(
      { kind: "normal", title: "OpenCode: 回合完成 [222222]", body: "耗时 3m12s\n已完成", event: "Stop", vars: { code: "222222", duration: "3m12s", summary: "已完成" } },
      ctx,
    )
    if (seen[0].body.markdown.text !== "**OpenCode: 回合完成 [222222]**\n\n耗时 3m12s\n\n已完成") throw new Error(`legacy text: ${JSON.stringify(seen[0].body.markdown.text)}`)
  },
])

async function main() {
  mkdirSync(path.join(HERE, "logs"), { recursive: true })
  const results: Array<[string, string]> = []
  for (const [name, fn] of scenarios) {
    try {
      await fn()
      results.push([name, "PASS"])
    } catch (e) {
      results.push([name, `FAIL: ${e instanceof Error ? e.message : String(e)}`])
    }
  }
  for (const [name, status] of results) console.log(`${status === "PASS" ? "✔" : "✘"} ${name} → ${status}`)
  const failed = results.filter(([, s]) => s !== "PASS")
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

void main()
