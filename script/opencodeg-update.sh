#!/usr/bin/env bash
# opencodeg 更新脚本（fork 更新链路）
# 源管理副本：script/opencodeg-update.sh（与本安装副本逐字节一致）
# 安装：cp script/opencodeg-update.sh ~/.local/bin/opencodeg-update && chmod +x ~/.local/bin/opencodeg-update
#
# 更新策略：merge 上游原作者仓库（upstream = LeXwDeX/OpenCode-GraphAgent）的 main，
# 不用 rebase——保留本地提交、无需 force-push。fork 定制文件（PROTECTED_FILES）冲突时
# 以本地为准（--ours）；非定制文件冲突则 git merge --abort 中止，交人工处理。
#
# 可测性开关（默认行为不变）：
#   OPENCODEG_WORKDIR=...      覆盖目标仓库路径（夹具测试用）
#   OPENCODEG_SKIP_BUILD=1     merge 成功后跳过编译安装与 DAG 同步（演练 merge 路径用）
#   --check                    仅 fetch 并报告落后 upstream 的提交数，不做任何变更
set -euo pipefail

WORKDIR=${OPENCODEG_WORKDIR:-/mnt/f/projects/AI/OpenCode-GraphAgent}
LOG="$HOME/.local/share/opencodeg/updates.log"
BIN_DST="$HOME/.local/bin/opencodeg"
BIN_SRC="$WORKDIR/packages/opencode/dist/opencode-linux-x64/bin/opencodeg"
BIN_DIR=/tmp/opencode/bin
BUILD_LOG=/tmp/opencode/update-build.log
MODELS_SNAPSHOT=/tmp/opencode/models-api.json
BUN_VERSION=bun-v1.3.14
BUN_ZIP_URL="https://registry.npmmirror.com/-/binary/bun/$BUN_VERSION/bun-linux-x64.zip"
LOCAL_BRANCH=feat/opencodeg-local
UPSTREAM_REF=refs/remotes/upstream/main

# fork 定制文件清单：merge 冲突时以本地为准（--ours），上游对它们的改动会被丢弃
# ⚠️ 新增 fork 定制文件需同步登记到此清单，否则 merge 冲突时不会以本地为准
PROTECTED_FILES=(
  packages/core/src/global.ts
  packages/opencode/src/command-name.ts
  packages/opencode/src/cli/cmd/pr.ts
  packages/opencode/src/cli/cmd/run/splash.ts
  packages/opencode/src/cli/error.ts
  packages/opencode/src/provider/error.ts
  packages/opencode/src/provider/provider.ts
  packages/opencode/src/question/index.ts
  packages/opencode/src/hook/settings.ts
  .github/workflows/specgit-accept.yml
  .opencode/opencode.jsonc
  spec_git/policy.yaml
)

CHECK_ONLY=0
for arg in "$@"; do
  case $arg in
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      cat <<'EOF'
usage: opencodeg-update [--check]

  --check   仅 fetch（origin + upstream）并报告落后 upstream/main 的提交数后退出，
            不切换分支、不 merge、不编译
EOF
      exit 0
      ;;
    *)
      echo "未知参数: $arg（仅支持 --check）" >&2
      exit 2
      ;;
  esac
done

log() {
  echo "[$(date '+%F %T')] $*" | tee -a "$LOG"
}

rollback() {
  git reset --hard "$OLD_HEAD" >/dev/null 2>&1 || log "⚠️ 回滚失败，仓库停留在 merge 态，请人工处理"
}

ensure_bun() {
  if ! command -v curl >/dev/null 2>&1 || ! command -v unzip >/dev/null 2>&1; then
    log "❌ 缺少依赖命令（curl/unzip），无法下载 bun，无法编译"
    return 1
  fi
  if [ -x "$BIN_DIR/bun" ] && "$BIN_DIR/bun" --version >/dev/null 2>&1; then
    return 0
  fi
  log "⚠️ Linux bun 缺失，尝试从 npmmirror 下载..."
  local zip=/tmp/opencode/bun-linux-x64.zip
  if ! curl -fsSL -o "$zip" "$BUN_ZIP_URL"; then
    log "❌ Linux bun 下载失败，无法编译"
    return 1
  fi
  rm -rf /tmp/opencode/bun-linux
  mkdir -p /tmp/opencode/bun-linux
  unzip -q "$zip" -d /tmp/opencode/bun-linux
  mkdir -p "$BIN_DIR"
  ln -sf /tmp/opencode/bun-linux/bun-linux-x64/bun "$BIN_DIR/bun"
  "$BIN_DIR/bun" --version >/dev/null 2>&1
}

mkdir -p "$(dirname "$LOG")"
mkdir -p "$(dirname "$BUILD_LOG")"

CUR_VER=$("$BIN_DST" --version 2>/dev/null || echo unknown)

cd "$WORKDIR" || { log "❌ 工作目录不存在（$WORKDIR），中止更新"; exit 1; }

# ① 拉取仓库：origin（镜像通道 + 超时保护）+ upstream 原作者仓库（失败仅跳过本轮，不炸）
if ! timeout 180 git fetch origin --tags; then
  log "❌ fetch origin 失败（网络异常），跳过更新"
  exit 1
fi
if ! timeout 180 git fetch upstream --tags; then
  log "⚠️ fetch upstream 失败（网络异常），跳过本轮更新（不视为错误）"
  exit 0
fi

# ② 比对版本：本地分支落后 upstream/main 才视为有新版本
if ! git rev-parse --verify -q "$UPSTREAM_REF" >/dev/null; then
  log "❌ 无法解析 $UPSTREAM_REF 引用，跳过更新"
  exit 1
fi
LOCAL=$(git rev-parse "$LOCAL_BRANCH")
REMOTE=$(git rev-parse "$UPSTREAM_REF")
NEW_COUNT=$(git rev-list --count "$LOCAL_BRANCH..$UPSTREAM_REF" || { log "❌ 版本比对失败，跳过更新"; exit 1; })

if [ "$CHECK_ONLY" -eq 1 ]; then
  log "ℹ️ --check: branch=$LOCAL_BRANCH head=$LOCAL behind-upstream=$NEW_COUNT upstream=$REMOTE installed=$CUR_VER"
  exit 0
fi

if [ "$NEW_COUNT" -eq 0 ]; then
  log "ℹ️ 无新版本（HEAD=$LOCAL, installed=$CUR_VER），跳过更新"
  exit 0
fi
log "🔔 发现新版本（落后 upstream $NEW_COUNT 个提交）: $(git log --oneline -1 "$UPSTREAM_REF")"

# ③ merge 到最新（保留本地 opencodeg 改动，无需 force-push）
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "❌ 工作目录存在未提交改动，中止更新（请先提交或暂存本地改动）"
  exit 1
fi
if ! git checkout "$LOCAL_BRANCH"; then
  log "❌ 无法切换到分支 $LOCAL_BRANCH，中止更新"
  exit 1
fi
OLD_HEAD=$(git rev-parse HEAD)
OLD_LOCK_SHA=$(sha256sum bun.lock | cut -d' ' -f1)

# 提取上游最新 graphagent release 版本号（钉死 CHANNEL 以稳定 DB 路径，勿改为动态）
UPSTREAM_VER=$(git tag --sort=-v:refname --merged "$UPSTREAM_REF" | grep -E '^graphagent-v[0-9]+(\.[0-9]+){2}$' | head -1 | sed 's/^graphagent-v//' || true)
if [ -z "$UPSTREAM_VER" ]; then
  UPSTREAM_VER="0.0.0-$(git branch --show-current)-$(date +%Y%m%d%H%M)"
fi

if ! git merge --no-edit "$UPSTREAM_REF"; then
  if ! git rev-parse --verify -q MERGE_HEAD >/dev/null; then
    log "❌ merge 未能开始（非冲突原因），中止更新，请人工处理"
    exit 1
  fi
  # 冲突处理：fork 定制文件以本地为准（--ours），其余冲突交人工
  UNMERGED=$'\n'"$(git diff --name-only --diff-filter=U)"$'\n'
  KEPT_LOCAL=()
  for p in "${PROTECTED_FILES[@]}"; do
    if [[ $UNMERGED == *$'\n'"$p"$'\n'* ]]; then
      if git checkout --ours -- "$p" && git add -- "$p"; then
        KEPT_LOCAL+=("$p")
      fi
    fi
  done
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    git merge --abort >/dev/null 2>&1 || true
    log "❌ 非保护文件存在合并冲突，已 git merge --abort 回到 $OLD_HEAD，请人工处理"
    exit 1
  fi
  if ! git commit --no-edit; then
    git merge --abort >/dev/null 2>&1 || true
    log "❌ merge 提交失败，已 git merge --abort 回到 $OLD_HEAD，请人工处理"
    exit 1
  fi
  if [ ${#KEPT_LOCAL[@]} -gt 0 ]; then
    log "🛡️ fork 定制文件冲突已按本地为准保留: ${KEPT_LOCAL[*]}（上游改动已丢弃，请按需人工比对）"
  fi
fi
NEW_LOCK_SHA=$(sha256sum bun.lock | cut -d' ' -f1)

# ③.5 演练模式：merge 成功即止，不编译、不安装、不同步 DAG
if [ "${OPENCODEG_SKIP_BUILD:-0}" = "1" ]; then
  log "✅ merge 完成（OPENCODEG_SKIP_BUILD=1，跳过编译安装与 DAG 同步）: $LOCAL → $(git rev-parse HEAD)"
  exit 0
fi

# ④ 编译（复用 T004/T006 构建环境：Linux bun 前置 PATH）
trap 'rollback; exit 130' INT TERM
if ! ensure_bun; then
  rollback
  log "❌ 构建环境不可用，已回滚 merge，保留旧版 $BIN_DST"
  exit 1
fi

# ④.5 依赖：merge 后 bun.lock 变化才重新 bun install（npmmirror registry）
if [ "$OLD_LOCK_SHA" != "$NEW_LOCK_SHA" ]; then
  log "📦 bun.lock 已变化，执行 bun install（npmmirror registry）..."
  if ! BUN_CONFIG_REGISTRY=https://registry.npmmirror.com "$BIN_DIR/bun" install; then
    rollback
    log "❌ bun install 失败，已回滚 merge，保留旧版 $BIN_DST"
    exit 1
  fi
else
  log "ℹ️ bun.lock 无变化，跳过依赖安装"
fi

log "🛠️ 开始编译（后台，约 12 分钟；日志: $BUILD_LOG）"
(
  cd "$WORKDIR/packages/opencode" || exit 1
  export PATH="$BIN_DIR:$PATH"
  if [ -f "$MODELS_SNAPSHOT" ]; then
    export MODELS_DEV_API_JSON="$MODELS_SNAPSHOT"
  fi
  # OPENCODE_CHANNEL 钉死为 feat/opencodeg-local：稳定数据库路径（opencode-feat-opencodeg-local.db），确保会话保留。勿改为动态值（分支改名会致 DB 漂移、会话消失）
  # OPENCODE_VERSION 取上游版本号：版本号 = <上游版本>-opencodeg
  export OPENCODE_CHANNEL=feat/opencodeg-local
  export OPENCODE_VERSION="${UPSTREAM_VER}-opencodeg"
  timeout 1200 bun run script/build.ts --single --skip-embed-web-ui
) >"$BUILD_LOG" 2>&1 &
BUILD_PID=$!
while kill -0 "$BUILD_PID" 2>/dev/null; do
  sleep 20
  echo "⏳ 构建进行中（$(date '+%F %T')），日志: $BUILD_LOG"
done
if ! wait "$BUILD_PID"; then
  rollback
  log "❌ 编译失败（详见 $BUILD_LOG），已回滚 merge，保留旧版 $BIN_DST"
  exit 1
fi

# ⑤ 安装新二进制（临时文件 + 原子改名，失败不覆盖旧版）
if ! "$BIN_SRC" --version >/dev/null 2>&1; then
  rollback
  log "❌ 新二进制自检失败（$BIN_SRC），已回滚 merge，保留旧版 $BIN_DST"
  exit 1
fi
TMP_BIN="$HOME/.local/bin/.opencodeg-update.tmp"
trap 'rm -f "$TMP_BIN"' EXIT
trap 'rm -f "$TMP_BIN"; rollback; exit 130' INT TERM
if ! cp "$BIN_SRC" "$TMP_BIN" || ! chmod +x "$TMP_BIN" || ! mv "$TMP_BIN" "$BIN_DST"; then
  rm -f "$TMP_BIN"
  rollback
  log "❌ 安装失败，已回滚 merge，保留旧版 $BIN_DST"
  exit 1
fi

# ⑥ 验证 + 记录
NEW_VER=$("$BIN_DST" --version) || { log "❌ 新版本验证失败（$BIN_DST 无法运行）"; exit 1; }
log "✅ 更新完成: $LOCAL → $REMOTE, version=$NEW_VER"

# ⑥.5 DAG 配置同步（智能同步：未自定义→更新；自定义→保留；失败不阻断更新）
if command -v opencodeg-sync-dag >/dev/null 2>&1; then
  if opencodeg-sync-dag; then
    log "✅ DAG 配置已同步"
  else
    log "⚠️ DAG 配置同步失败（不影响已完成的更新）"
  fi
else
  log "ℹ️ opencodeg-sync-dag 未安装，跳过 DAG 配置同步"
fi
