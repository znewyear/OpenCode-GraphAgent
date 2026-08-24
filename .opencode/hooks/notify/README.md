# opencode 多渠道消息提醒（Win10 + WSL2）

基于 opencode hooks 的 agent 回合通知：单一 dispatcher 脚本 fan-out 到 **Windows 10 桌面 toast**（WSL interop powershell.exe）、**钉钉机器人 webhook**、**飞书机器人 webhook**。渠道以注册表方式可扩展。纯 `.opencode/` 实现，不触碰 `packages/` 运行时代码。

## 事件映射

| hook 事件 | 行为 |
|---|---|
| `UserPromptSubmit` | 静默计时：写 `state/prompt-<sid>.json` 时间戳 |
| `Stop`（会话有待测时间戳 = 主会话） | 立即通知 `OpenCode: 回合完成 [短码]`，正文含耗时 + 摘要 |
| `Stop`（无时间戳 = DAG 子会话） | 进入聚合缓冲，窗口（默认 10s）关闭后 1 条 digest `OpenCode: N 个并行回合完成` |
| `StopFailure` | critical，立即通知，**豁免一切节流/聚合** |
| `PermissionRequest` | critical，立即通知 `OpenCode: 需要你批准 [短码]`，**豁免** |
| `Notification` | 兜底；PermissionRequest 后 8s 内抑制（防双发），同文 5s 去重；`notification_type=elicitation` 时记录时间戳 |
| `QuestionAsked` | critical，立即通知 `OpenCode: 需要你回答 [短码]`，正文含项目名（cwd basename）/标题/描述；elicitation Notification 后 10s 内抑制（MCP elicitation 已通知，防双发） |

> 澄清：elicitation 路径下用户实际收到的是 Notification 分支的 normal「通知」（MCP 提问先经 Notification 送达）；critical 的「需要你回答」仅非 elicitation 直连 ask 的 QuestionAsked 时出现。

钉钉频控 20 条/分钟：最坏「1 立即 + 每窗口 1 digest」≈ 6 条/分钟 ✅。

## 部署

```bash
cd .opencode/hooks/notify

# 1. 布线 hooks（项目级；.opencode/hooks.json 已被 gitignore）
cp hooks.example.json ../../../.opencode/hooks.json
# 若 .opencode/hooks.json 已存在（如 specgit init 生成）：手动把 6 个事件条目合并进去，
# 不要整文件覆盖 —— specgit init 会重写该文件，重跑 init 后需重新合并（verify.ts A12 可自检）。

# 2. 配置两级化（JSONC，支持注释；真实凭据绝不提交）
#    全局（对所有项目生效，本机启用）：
cp ../../../.opencode/notify.jsonc.example ~/.config/opencodeg/notify.jsonc   # 按需编辑
#    项目级覆盖（可选，只写需要覆盖的字段）：
cp ../../../.opencode/notify.jsonc.example ../../../.opencode/notify.jsonc   # 已被 gitignore
#    或沿用旧版本地文件 notify.config.json（deprecated 兜底层，仍可用）：
cp notify.config.json.example notify.config.json
#    env（NOTIFY_DINGTALK_WEBHOOK 等）始终最高优先；见下

# 3. 行为验收（离线，无真实 webhook 流量，无真实 powershell spawn）
bun verify.ts   # 20/20 passed

# 4. 本机冒烟（L1，真实 toast，需 Win10 桌面可见）
echo '{"hook_event_name":"UserPromptSubmit","session_id":"ses_l1smoke01","prompt":"smoke"}' | bun dispatcher.ts
echo '{"hook_event_name":"Stop","session_id":"ses_l1smoke01","stop_hook_active":false,"last_assistant_message":"L1 冒烟完成"}' | bun dispatcher.ts
# → Windows 桌面应弹出 "OpenCode: 回合完成 [moke01]"；证据见 logs/dispatcher.log
```

## 配置

优先级 **env > 项目 `<cwd>/.opencode/notify.jsonc` > 全局 `~/.config/opencodeg/notify.jsonc` > 旧版 `notify.config.json`（deprecated）> 编译默认**。`NOTIFY_CONFIG`（或测试用 opts.configPath）设定时整链替换为该单文件。文件层之间按字段覆盖（channels 按渠道逐字段深合并，开关与凭据均可两级）；数组整体替换。两级新层均为 JSONC（字符串感知的注释剥离，解析失败静默回落低层）。dispatcher 从 hook envelope 的 `cwd` 定位项目层。

| env | 作用 |
|---|---|
| `NOTIFY_DINGTALK_WEBHOOK` / `NOTIFY_DINGTALK_SECRET` | 钉钉凭据 |
| `NOTIFY_FEISHU_WEBHOOK` / `NOTIFY_FEISHU_SECRET` | 飞书凭据 |
| `NOTIFY_DISABLE` | 逗号分隔渠道 id，临时禁用（如 `windows-toast,feishu`） |
| `NOTIFY_STATE_DIR` / `NOTIFY_CONFIG` | 测试用：状态目录 / 配置文件路径 |
| `NOTIFY_DRYRUN=1` | 干跑：钉钉/飞书打印请求体到日志，不发送 |
| `NOTIFY_STOP_MODE` | `auto`（默认）/ `all-immediate` / `all-digest` |

渠道实际启用 = `notify.config.json 里 channels.<id>.enabled` **且** 凭据齐全 **且** 不在 `NOTIFY_DISABLE`。钉钉/飞书开关默认 true 但凭据为空即禁用——开箱仅 toast。

关键 json 键：`aggregate.windowMs`（聚合窗口，默认 10000）、`stopMode`、`durationMinMs`（耗时低于阈值则省略耗时行，默认 0=总是显示）、`channels["windows-toast"].timeoutMs`（powershell 超时，默认 8000）。

## WSL interop 前提

1. WSL2 interop 开启：`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command 'echo ok'` 应输出 `ok`。若失败检查 `/etc/wsl.conf` 的 `[interop] enabled=true`。
2. powershell 冷启动 1–2s，偶发超 8s：仅记日志不崩；调大 `timeoutMs`。
3. Toast 依赖 PowerShell 的 AUMID；若不弹：检查 Windows「专注助手/勿扰模式」与通知设置中 PowerShell 是否被禁。

## 排障

| 症状 | 处置 |
|---|---|
| 钉钉 `errcode 310000`/sign 错误 | secret 与机器人「加签」页不一致 |
| 钉钉 `errcode 19021` timestamp 过期 | WSL 时钟漂移 >1h：`sudo hwclock -s` |
| 飞书 `code 19021` invalid sign | 同上时钟漂移，或 secret 错 |
| 飞书频控（100/min、5/s） | 正常不会触发；风暴时调大 `windowMs` |
| toast 不弹但日志无错 | Windows 专注助手/通知设置；或换 `appId` 为已注册 AUMID |
| DAG 结束没 digest | `flushDueBuffers` 仅冲刷**到期**缓冲（`flushAt≤now`）；未到期缓冲依赖**最后那个子会话 Stop 的 sleep 进程**守到窗口到期（该进程被杀则缓冲留存，待下一次任意 hook 事件触发时冲刷）。检查 `state/agg-stop.json` 残留与 `agg.lock` |
| hook 完全不触发 | `bun` 不在 agent 进程 PATH；确认 `which bun`；A12 检查布线 |

## 安全

- 真实凭据只存 `notify.config.json`（gitignored）或 env；入库 example 全为空占位。
- `logs/dispatcher.log` 中 webhook 仅记脱敏形式；secret 永不落日志。
- `state/`、`logs/` 均被 `.gitignore`（本目录下）覆盖；`bun verify.ts` A11 对全部交付文件（cached + untracked，排除 ignored，含未跟踪）做凭据模式扫描——**staging 前即生效**，持续自检。

## 交付指纹

交付清单共 17 个文件（含防 secret 的 `.gitignore`）。内容指纹对除本 README 外的 16 个交付文件逐文件 sha256 后整体再 sha256（README 是指纹值的载体，不自哈希）。复现命令（在仓库根执行一行）：

`git ls-files --cached --others --exclude-standard .opencode/hooks/notify ':(exclude).opencode/hooks/notify/README.md' | LC_ALL=C sort | xargs -r sha256sum | sha256sum`

`sort` 段钉 `LC_ALL=C`：文件顺序与 locale 无关，指纹跨机可复现。

当前值 `sha256:fba86d843a4e5cd490d5912d9cb4536def7fe470b5692586f6f95801f3ed12b5`。交付文件任何变动后须重算并更新本节；`bun verify.ts` A15 持续自检（含 LC_ALL=C 钉扎校验）。项目级模板 `.opencode/notify.jsonc.example` 在本目录之外，不进指纹/A11 清单。

## 扩展渠道

1. 新建 `channels/<id>.ts` 实现 `Channel` 接口（`id` / `enabled(cfg)` / `send(n, ctx)`；send 自捕获错误，永不抛出）。
2. `channels/index.ts` 加一行 `registerChannel(...)`。
3. `config.ts` 的 `channels` 增加对应键 + `notify.config.json.example` 占位。

测试缝：`SendCtx = { cfg, fetchImpl, spawnImpl, now, log }` 全部可注入（见 `verify.ts` A6/A7 用假 fetch 断言固定签名向量；A16 用假 spawn 断言 powershell 命令行契约与 toastXml base64 往返）。

## 已知限制（设计接受）

- 聚合缓冲并发写竞态可能偶发少计 digest 条数（critical 类不经缓冲，绝不被吞）。
- DAG 子会话若也触发 `UserPromptSubmit`（带时间戳），auto 模式会退化为逐条立即发——用 `"stopMode": "all-digest"` 逃生。
- `async: true` 的 hook 在 agent 进程退出时可能被截断（后台 fiber 随进程消亡）；正常回合内 ≤8s 完成，无实际影响。
