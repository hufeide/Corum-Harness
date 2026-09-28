#!/usr/bin/env bash
#
# recheck-fork-delta.sh —— 按 `docs/fork-delta.md` §1 的口径，**逐包重算** fork 差异分类。
#
# ## 为什么需要它（2026-09-28 立，来自 HANDOFF-desktop-0.1.0-hardening.md §4.3）
#
# §4.6 那次复核发现：台账总览表的数字**与文件集不符**（模型页自研新增的 12 个文件根本没进表）。
# 也就是说「数字靠人考古」会静默失真——而这张表是**升级 rebase 的工作量依据**，错了会低估冲突面。
# 本脚本把口径固化成命令：对 6 个会话域 fork 包逐包比对 `src/`，输出可直接抄进 §1 的一行。
#
# ## 口径（与 §1 注释一致）
#
#   官方基线 = dsh 检出里 **标签** `<tag>:packages/client/<官方包>/src`
#              （⚠️ 不能用工作区：检出已前进到 0.1.7-rc.2，其 src 不是 0.1.2-alpha.2）
#   · 逐字节相同：`cmp -s` 相同
#   · 仅改名    ：把两侧的包名归一（`@deepseek-ai/dsh-*` / `@corum/corum-*` → `@PKG`）后逐字节相同
#   · 实质修改  ：其余共享文件（含 CSS、locale、逻辑差异）
#   · corum 新增：corum 有、官方无
#   · 官方有但 corum 删：官方有、corum 无
#
# ⚠️ **两套 scope 都要出**（2026-09-28 复核时发现的历史含糊）：`docs/fork-delta.md` §1 表头写的是对
#   整包 `src/`，而 §4.6 的复核口径写的是 `src/client/` —— 两者数字当然不同。本脚本同时输出
#   `src/`（全包）与 `src/client/`（消费面）两行，台账里引用时必须写明是哪一个。
#
# ## 用法
#
#   ./scripts/recheck-fork-delta.sh                    # 默认 tag dsh-v0.1.2-alpha.2（§1 的基线）
#   ./scripts/recheck-fork-delta.sh --tag dsh-v0.1.3-alpha.1
#   ./scripts/recheck-fork-delta.sh --explain          # 附每包的差异文件清单（前 20 个）
#
# ⚠️ 官方包**随 npm 只发 `lib/`**（没有 `src/`）⇒ 基线只能取自 dsh 检出的标签，不能用
#    `node_modules/.pnpm`。检出路径可用 `--dsh <路径>` 覆盖（缺省 /Users/kukucai/dsh）。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH="${DSH_CHECKOUT:-/Users/kukucai/dsh}"
TAG="dsh-v0.1.2-alpha.2"
EXPLAIN=0

while (($# > 0)); do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --dsh) DSH="${2:-}"; shift 2 ;;
    --explain) EXPLAIN=1; shift ;;
    -h|--help) sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数：%s（用 --help）\n' "$1" >&2; exit 2 ;;
  esac
done

[ -d "$DSH/.git" ] || { printf 'dsh 检出不存在：%s（用 --dsh 指定）\n' "$DSH" >&2; exit 2; }
git -C "$DSH" rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
  || { printf 'dsh 检出里没有标签 %s\n' "$TAG" >&2; exit 2; }

# fork 包 → 官方对照包（§1 的六行）
PAIRS=(
  "corum-ui-conversation:ui-conversation"
  "corum-ui-chat:ui-chat"
  "corum-ui-approval:ui-approval"
  "corum-ui-questions:ui-user-questions"
  "corum-ui-model-selection:ui-model-selection"
  "corum-ui-settings-models:ui-settings-models"
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 归一包名（只影响「仅改名」判定）
normalize() {
  sed -E \
    -e 's/@deepseek-ai\/dsh-client-ui-[a-z0-9-]+/@PKG/g' \
    -e 's/@corum\/corum-ui-[a-z0-9-]+/@PKG/g' \
    -e 's/dsh-client-ui-[a-z0-9-]+/PKG/g' \
    -e 's/corum-ui-[a-z0-9-]+/PKG/g' \
    "$1"
}

# 一个 scope 的分类：$1=corum_dir $2=official_dir $3=scope 前缀（空 = 整包 src）
classify() {
  local corum_dir="$1" official_dir="$2" scope="$3"
  local ident=0 rename=0 subst=0 f
  ( cd "$corum_dir/src/$scope" 2>/dev/null && find . -type f | sed 's|^\./||' | sort ) > "$WORK/c.list"
  ( cd "$official_dir/$scope" 2>/dev/null && find . -type f | sed 's|^\./||' | sort ) > "$WORK/o.list"
  while read -r f; do
    [ -n "$f" ] || continue
    if cmp -s "$corum_dir/src/$scope/$f" "$official_dir/$scope/$f"; then ident=$((ident + 1)); continue; fi
    # ⚠️ 判据用 **cmp**，不要用 `diff -q`：这些源码里含 `\0`/超长行时 diff 会按二进制处理，
    # 行为与逐字节比较不一致（实测踩过：`diff` 一行不输出、`cmp` 明明不同）。
    if cmp -s <(normalize "$corum_dir/src/$scope/$f") <(normalize "$official_dir/$scope/$f"); then
      rename=$((rename + 1))
    else
      subst=$((subst + 1))
      [ "$EXPLAIN" = 1 ] && printf '      实质[%s]：%s\n' "${scope:-src}" "$f"
    fi
  done < <(comm -12 "$WORK/c.list" "$WORK/o.list")
  local new del
  new="$(comm -23 "$WORK/c.list" "$WORK/o.list" | grep -c .)"
  del="$(comm -13 "$WORK/c.list" "$WORK/o.list" | grep -c .)"
  if [ "$EXPLAIN" = 1 ]; then
    printf '      独有[%s] corum：%s\n' "${scope:-src}" "$(comm -23 "$WORK/c.list" "$WORK/o.list" | tr '\n' ' ')"
    printf '      独有[%s] 官方：%s\n' "${scope:-src}" "$(comm -13 "$WORK/c.list" "$WORK/o.list" | tr '\n' ' ')"
  fi
  printf '%s %s %s %s %s' "$(grep -c . "$WORK/c.list")" "$(grep -c . "$WORK/o.list")" "$ident" "$rename" "$subst"
  printf ' %s %s' "$new" "$del"
}

printf '基线标签：%s（dsh 检出 %s）\n\n' "$TAG" "$DSH"

for scope_label in "src:" "src/client:client/"; do
  label="${scope_label%%:*}"; scope="${scope_label##*:}"
  printf '【scope = %s】\n' "$label"
  printf '%-28s %6s %6s %6s %6s %6s %6s %6s\n' 包 corum 官方 相同 改名 实质 新增 删除
  T_I=0; T_R=0; T_S=0; T_N=0; T_D=0
  for pair in "${PAIRS[@]}"; do
    corum_name="${pair%%:*}"; official="${pair##*:}"
    corum_dir="$(ls -d "$REPO_ROOT"/packages/plugins/*/"$corum_name" 2>/dev/null | head -1)"
    [ -n "$corum_dir" ] || { printf '%-28s （本地找不到该 fork 包）\n' "$corum_name"; continue; }
    out_dir="$WORK/$official"
    mkdir -p "$out_dir"
    git -C "$DSH" archive "$TAG" "packages/client/$official/src" 2>/dev/null \
      | tar -x -C "$out_dir" --strip-components=4 2>/dev/null
    set -- $(classify "$corum_dir" "$out_dir" "$scope")
    printf '%-28s %6s %6s %6s %6s %6s %6s %6s\n' "$corum_name" "$1" "$2" "$3" "$4" "$5" "$6" "$7"
    T_I=$((T_I + $3)); T_R=$((T_R + $4)); T_S=$((T_S + $5)); T_N=$((T_N + $6)); T_D=$((T_D + $7))
  done
  printf '%-28s %6s %6s %6s %6s %6s %6s %6s\n' 合计 - - "$T_I" "$T_R" "$T_S" "$T_N" "$T_D"
  printf '\n'
done
printf '（口径见本脚本头；台账里引用时必须写明 scope —— §1 历史用整包 src、§4.6 复核用 src/client）\n'
