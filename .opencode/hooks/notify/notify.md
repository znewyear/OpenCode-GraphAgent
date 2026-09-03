# notify 配置目录与消息模板指南

notify 模块的事件级开关与消息模板均通过 JSONC 配置驱动。本文是这两项能力的完整参考；部署与渠道配置总览见 [README.md](./README.md)。

## 目录结构

```
~/.config/opencodeg/notify/            # 全局层（本机所有项目生效）
├── notify.jsonc                       # 全局配置（JSONC，支持注释）
└── templates/                         # 全局模板目录

<project>/.opencode/notify/            # 项目层（只写需要覆盖的字段；整个目录已 gitignore）
├── notify.jsonc                       # 项目配置（覆盖全局同名字段）
└── templates/                         # 项目模板目录（优先于全局）

.opencode/hooks/notify/templates/      # 模块默认模板（随仓库交付，可直接引用或复制改造）
```

- 旧扁平路径仍兼容读取（新路径优先）：全局 `~/.config/opencodeg/notify.jsonc`、项目 `<project>/.opencode/notify.jsonc`。
- 配置层优先级：env > 项目 > 全局 > 旧版 `notify.config.json`（deprecated）> 编译默认；`channels` 按渠道逐字段深合并。
- dispatcher 从 hook envelope 的 `cwd` 定位项目层。

## 事件开关（events）

`events` 节六个事件均可独立开关，全部可省略，`enabled` 默认 `true`：

| 事件 key | hook 事件 | 默认模板文件 |
|---|---|---|
| `stop` | `Stop`（主会话立即通知 / DAG 子会话进聚合） | `stop.txt` |
| `stopFailure` | `StopFailure` | `stopfailure.txt` |
| `permissionRequest` | `PermissionRequest` | `permissionrequest.txt` |
| `notification` | `Notification` | `notification.txt` |
| `questionAsked` | `QuestionAsked` | `questionasked.txt` |
| `digest` | 聚合窗口冲刷（源自 DAG 子会话 `Stop`） | `digest.txt` |

```jsonc
{
  "events": {
    // enabled: false → 整事件静默（digest 关闭时聚合缓冲冲刷为空，不发送）
    "permissionRequest": { "enabled": false },
    // template: 事件级模板（对该事件所有启用渠道生效）
    // channels.<渠道id>.template: 渠道级模板，覆盖事件级
    "stop": { "enabled": true, "template": "stop.txt", "channels": { "feishu": { "template": "stop-feishu.txt" } } },
    "stopFailure": { "enabled": true },
    "notification": { "enabled": true },
    "questionAsked": { "enabled": true },
    "digest": { "enabled": true }
  }
}
```

> `UserPromptSubmit` 是纯计时事件（供 `Stop` 计算耗时），不可开关、不产生通知。

## 消息模板

### .txt 格式

模板为 `.txt` 纯文本：**首行 = 标题，其余行 = 正文**。渲染后标题 trim 为空时回落编译硬编码标题。

### {var} 占位符规则

- `{var}` 替换为该事件的变量值；未提供或未知的变量替换为空串。
- **空值折叠**：替换产生的空行不占位——正文首部空行丢弃、连续空行合并为一条、尾部空行去除；非空行仅去尾部空白。
- 渠道级文件命名约定 `<event>-<channelid>.txt`（如 `stop-feishu.txt`），仅是命名习惯，仍须在配置中显式指定才会生效。

### 模板查找顺序

1. spec 取 `events.<key>.channels.<渠道id>.template`，无则取 `events.<key>.template`；均无 → 编译硬编码文案。
2. spec 为**绝对路径** → 直接使用（文件存在才有效）。
3. spec 为文件名/相对路径 → 依次在三层 templates/ 目录中查找，第一个存在的文件胜出：
   **项目** `<project>/.opencode/notify/templates/` > **全局** `~/.config/opencodeg/notify/templates/` > **模块默认** `.opencode/hooks/notify/templates/`。
4. 全部未命中 → 编译硬编码文案（默认路径，用户可见外观与历史完全一致；模板不可读时记日志并回落）。

### 快速定制

```bash
# 项目层定制 stop 文案（复制模块默认模板后编辑，外观起点与默认一致）
mkdir -p .opencode/notify/templates
cp .opencode/hooks/notify/templates/stop.txt .opencode/notify/templates/
# 渠道级变体（飞书专属文案）
cp .opencode/hooks/notify/templates/stop.txt .opencode/notify/templates/stop-feishu.txt
```

```jsonc
// <project>/.opencode/notify/notify.jsonc
{ "events": { "stop": { "template": "stop.txt", "channels": { "feishu": { "template": "stop-feishu.txt" } } } } }
```

## 变量表

| 事件 | 变量 | 含义 |
|---|---|---|
| stop | `{code}` | 会话 ID 后 6 位（通知短码） |
| stop | `{duration}` | 回合耗时（如 `3m12s`；低于 `durationMinMs` 或超过 24h 时为空；注意仅整行空白行才折叠，含固定前缀的「耗时 {duration}」空值时残留裸「耗时」行） |
| stop | `{summary}` | 最后一条助手消息的单行摘要（≤120 字符，可空） |
| stopFailure | `{code}` | 会话 ID 后 6 位 |
| stopFailure | `{error}` | 错误信息单行摘要（≤200 字符） |
| permissionRequest | `{code}` | 会话 ID 后 6 位 |
| permissionRequest | `{tool}` | 工具名（`tool_name`） |
| permissionRequest | `{input}` | 工具输入摘要（优先 `command`/`filePath`/`path` 字段，≤160 字符，可空） |
| notification | `{code}` | 会话 ID 后 6 位 |
| notification | `{message}` | 通知文本单行摘要（≤500 字符） |
| questionAsked | `{code}` | 会话 ID 后 6 位 |
| questionAsked | `{project}` | 项目目录名（hook envelope `cwd` 的 basename） |
| questionAsked | `{title}` | 问题标题（`env.title` 或首个问题的 `header`，可空） |
| questionAsked | `{question}` | 首个问题内容单行摘要（≤200 字符） |
| digest | `{count}` | 聚合窗口内完成的回合总数 |
| digest | `{sessions}` | 会话短码列表（逗号分隔，最多展示 6 个，超出以 `…` 结尾） |

行为验收：`cd .opencode/hooks/notify && bun verify.ts`（离线，23/23）。
