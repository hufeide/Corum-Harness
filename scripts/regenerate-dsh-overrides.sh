#!/usr/bin/env bash
#
# regenerate-dsh-overrides.sh —— `pnpm-workspace.yaml` 里 dsh override 的**对齐检查**与**重生成**。
#
# ## 为什么需要它（2026-09-28 立，来自 docs/HANDOFF-desktop-0.1.0-hardening.md §4.4）
#
# `pnpm-workspace.yaml` 的 dsh override 是**按当前工作区实际安装集合生成**的：pnpm 11 不支持 glob，
# 必须逐个把 `@deepseek-ai/dsh-*` 钉到**同一个版本**，否则打包闭包会**混版**——而混版的后果不是
# 报错，是 `.app` 里两棵树模块实例混用（`dsh-scope` 的 `kScope` symbol 被切成两份 ⇒ agent 挂载失败
# ⇒ 整套 MCP 每秒重启，2026-09-18 那次血案）。基座版本 bump 时**必须整体重生成**这张表。
#
# 权威判据仍在打包期：`pack-macos.mjs` 会核「host 闭包只有一个 dsh 版本」，并在不满足时直接抛。
# 本脚本是**上一步**的便宜检查：在跑那 10 分钟的 pack 之前，就能发现「表与安装集合不一致」。
#
# ## 用法
#
#   ./scripts/regenerate-dsh-overrides.sh            # 检查（默认）：表里每条钉的版本 vs 实际安装
#   ./scripts/regenerate-dsh-overrides.sh --check    # 同上（显式）
#   ./scripts/regenerate-dsh-overrides.sh --write    # 按 --target 重生成整块并写回（改前备份）
#   ./scripts/regenerate-dsh-overrides.sh --write --target 0.1.3-alpha.1
#
# 退出码：0 = 对齐；1 = 有漂移/有包装了多个版本（检查模式）或写回失败。
#
# ## 判据（检查模式，逐条钉的包）
#
#   ① 表里钉的版本 == `.pnpm` 里该包**唯一**的已安装版本；
#   ② 该包**没有**装了多个版本（多版本 = 混版风险，正是这张表要防的）；
#   ③ 反向：`.pnpm` 里装了、但表里**没钉**的 dsh 包（漏钉 ⇒ 下次 bump 时它会漂）。
#
# ⚠️ ③ 只警告不失败：`node_modules/.pnpm` 会同时容纳**其它 peer 组合**留下的旧版本残留，
# 判据②已覆盖真正的混版风险。要不要删残留由人决定，脚本不擅自清。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_FILE="$REPO_ROOT/pnpm-workspace.yaml"
PNPM_DIR="$REPO_ROOT/node_modules/.pnpm"

MODE="check"
TARGET=""
while (($# > 0)); do
  case "$1" in
    --check) MODE="check"; shift ;;
    --write) MODE="write"; shift ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数：%s（用 --help）\n' "$1" >&2; exit 2 ;;
  esac
done

[ -f "$WORKSPACE_FILE" ] || { printf '找不到 %s\n' "$WORKSPACE_FILE" >&2; exit 2; }
[ -d "$PNPM_DIR" ] || { printf '找不到 %s（先在仓库根 pnpm install）\n' "$PNPM_DIR" >&2; exit 2; }

# ── 解析：表里钉的（包名 → 版本）─────────────────────────────────────────────
pinned_of() {
  grep -oE "^  '@deepseek-ai/dsh-[a-z0-9-]+': '[^']+'" "$WORKSPACE_FILE" \
    | sed -E "s/^  '(@deepseek-ai\/dsh-[a-z0-9-]+)': '([^']+)'/\1 \2/"
}

# ── 解析：实际安装的（包名 → 版本集合）──────────────────────────────────────
# `.pnpm` 目录名形如 `@deepseek-ai+dsh-core@0.1.3-alpha.1_<peer hash>` ⇒ 取 `@` 后的版本段。
installed_of() {
  for dir in "$PNPM_DIR"/@deepseek-ai+dsh-*; do
    [ -d "$dir" ] || continue
    base="$(basename "$dir")"          # @deepseek-ai+dsh-core@0.1.3-alpha.1_<peer hash>
    # 名字：`@scope+pkg` → `@scope/pkg`。
    name="$(printf '%s' "$base" | sed -E 's/^@([^+]+)\+([^@]+)@.*/@\1\/\2/')"
    # 版本：**第一个 `@` 之后、下一个 `@`（或 `_`）之前**。
    # ⚠️ peer 后缀里也含 `@`（`..._@deepseek-ai+cordis@4.0.2_...`）⇒ 不能用 `^.*@`（贪婪会吃到 peer
    # 的版本上，实测踩过：`dsh-api-gateway` 会读出 `4.0.2`）。
    version="$(printf '%s' "$base" | sed -E 's/^@[^@]*@([^_]*).*$/\1/')"
    if [ -n "$name" ] && [ -n "$version" ]; then
      printf '%s %s\n' "$name" "$version"
    fi
  done
}

PINNED="$(pinned_of)"
INSTALLED="$(installed_of)"

if [ "$MODE" = "write" ]; then
  [ -n "$TARGET" ] || TARGET="$(printf '%s\n' "$INSTALLED" | awk '{print $2}' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')"
  [ -n "$TARGET" ] || { printf '无法推断 --target（安装集合为空）\n' >&2; exit 1; }
  cp "$WORKSPACE_FILE" "$WORKSPACE_FILE.bak-$(date +%Y%m%d-%H%M%S)"
  names="$(printf '%s\n' "$INSTALLED" | awk '{print $1}' | sort -u)"
  count="$(printf '%s\n' "$names" | grep -c .)"
  block="$(printf '%s\n' "$names" | sed "s|^|  '|; s|\$|': '$TARGET'|")"
  python3 - "$WORKSPACE_FILE" "$block" <<'PY'
import re, sys, pathlib
path = pathlib.Path(sys.argv[1])
block = sys.argv[2].rstrip('\n')
text = path.read_text(encoding='utf-8')
# 用「第一条 dsh override」到「第一条非 dsh override」之间的区间整块替换。
lines = text.split('\n')
first = next((i for i, l in enumerate(lines) if re.match(r"^  '@deepseek-ai/dsh-", l)), None)
if first is None:
    sys.exit('pnpm-workspace.yaml 里找不到 dsh override 行')
last = first
while last + 1 < len(lines) and re.match(r"^  '@deepseek-ai/dsh-", lines[last + 1]):
    last += 1
lines[first:last + 1] = block.split('\n')
path.write_text('\n'.join(lines), encoding='utf-8')
print(f'✓ 已重写 {len(block.splitlines())} 条 override（目标版本 {sys.argv[2].splitlines()[0].split(": ")[-1] if block else "?"}）')
PY
  printf '目标版本：%s（%s 条）\n' "$TARGET" "$count"
  exit $?
fi

# ── 检查模式 ────────────────────────────────────────────────────────────────
DRIFT=0
MULTI=0
CHECKED=0
LINKS=0
while read -r name version; do
  [ -n "$name" ] || continue
  CHECKED=$((CHECKED + 1))
  # `link:` 是**故意的 fork 覆盖**（dsh-fs-local → corum-fs-local、dsh-tools → corum-tools，
  # pack-macos.mjs 另有两条硬断言守它们）⇒ 判据是「目标路径存在且有 package.json」，不是版本比对。
  case "$version" in
    link:*)
      LINKS=$((LINKS + 1))
      target="$REPO_ROOT/${version#link:}"
      if [ -f "$target/package.json" ]; then
        printf '  · %-40s link → %s ✓\n' "$name" "${version#link:}"
      else
        printf '  ✗ %-40s link 目标不存在或缺 package.json：%s\n' "$name" "${version#link:}"
        DRIFT=$((DRIFT + 1))
      fi
      continue
      ;;
  esac
  versions="$(printf '%s\n' "$INSTALLED" | awk -v n="$name" '$1 == n {print $2}' | sort -u)"
  count="$(printf '%s\n' "$versions" | grep -c .)"
  if [ "$count" -eq 0 ]; then
    printf '  ✗ %-40s 表里钉了 %s，但 .pnpm 里没装\n' "$name" "$version"
    DRIFT=$((DRIFT + 1))
    continue
  fi
  if [ "$count" -gt 1 ]; then
    printf '  ✗ %-40s 装了 %s 个版本：%s\n' "$name" "$count" "$(printf '%s' "$versions" | tr '\n' ' ')"
    MULTI=$((MULTI + 1))
  fi
  if ! printf '%s\n' "$versions" | grep -qx "$version"; then
    printf '  ✗ %-40s 表里钉 %s，实际装 %s\n' "$name" "$version" "$(printf '%s' "$versions" | tr '\n' ' ')"
    DRIFT=$((DRIFT + 1))
  fi
done <<< "$PINNED"

missing="$(comm -23 <(printf '%s\n' "$INSTALLED" | awk '{print $1}' | sort -u) <(printf '%s\n' "$PINNED" | awk '{print $1}' | sort -u))"
missing_count="$(printf '%s\n' "$missing" | grep -c .)"
# 多数版本 = 表里钉得最多的那个（link: 不算）⇒ 任何**其它**版本都是混版信号。
majority="$(printf '%s\n' "$PINNED" | awk '$2 !~ /^link:/ {print $2}' | sort | uniq -c | sort -rn | head -1 | awk '{print $2}')"

printf '\n检查了 %s 条 override：版本漂移 %s 条、装多版本 %s 条、link 覆盖 %s 条；未钉的已安装包 %s 个\n' \
  "$CHECKED" "$DRIFT" "$MULTI" "$LINKS" "$missing_count"
if [ "$missing_count" -gt 0 ]; then
  printf '  ⚠️ 未钉（多为 peer 组合残留；**若版本不等于多数版本 %s，就是混版信号**）：\n' "$majority"
  while read -r m; do
    [ -n "$m" ] || continue
    mv="$(printf '%s\n' "$INSTALLED" | awk -v n="$m" '$1 == n {print $2}' | sort -u | tr '\n' ' ')"
    if [ "$mv" = "$majority " ]; then
      printf '      %s @ %s（与多数一致）\n' "$m" "$mv"
    else
      printf '      \033[33m%s @ %s（≠ %s ⇒ 混版信号）\033[0m\n' "$m" "$mv" "$majority"
    fi
  done <<< "$missing"
fi

if [ "$DRIFT" -gt 0 ] || [ "$MULTI" -gt 0 ]; then
  printf '\n\033[31m不一致\033[0m：跑 `%s --write --target <目标版本>` 重生成，再 `pnpm install` + 重新打包。\n' "${BASH_SOURCE[0]}"
  exit 1
fi
printf '\n\033[32m对齐\033[0m：表里每条钉的版本都与实际安装一致、且没有包装多版本。\n'
exit 0
