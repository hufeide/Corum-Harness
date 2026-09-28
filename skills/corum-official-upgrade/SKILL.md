---
name: corum-official-upgrade
description: Use when upgrading this repo (corum Agent OS / kkc-desktop) to a newer official dsh release, or when resyncing the fork packages after such a bump — picking a target version that actually exists on the registry, the per-package upgrade loop (declaration + root override together, install, compile, commit), the fork-resync merge手法 (official base + paste back corum deltas), the fork-counterpart override rules, and the guard/environment traps that have already cost this project time.
---

# corum 官方基座升级（升级技能）

本技能是**升级**这件事的可执行投影。规则的家仍是 `docs/dev-conventions.md`，
逐包台账是 `docs/fork-delta.md`（18 个 fork 包 + §5 runbook），
**本次（0.1.3-alpha.1 → 0.1.5-rc.3）的逐步实录与全部坑**在 `docs/UPGRADE-0.1.7-rc2.md`（活文档，边做边追加）。
两者冲突时以文档为准，并回来修本技能。

## 0. 一句话

**先确认目标版本在 registry 上"整套装齐"，再一个一个升；每个包"包声明 + 根 override"必须同时改，
改完立刻装 + 编译 + 提交；fork 包用"官方为底 + 贴回 corum 增量"，并把增量逐 marker 对齐验证。**

## 1. 升级前必须做的三件事（不做会白干）

1. **确认目标版本完整性**（最容易翻车的一步）：
   官方 `0.1.7-rc.2` 的**源码**标签存在，但 npm 上**缺 5 个包**（`dsh-agent-presets` /
   `dsh-code-runtime` / `dsh-code-runtime-worker-thread` / `dsh-settings-file` /
   `dsh-workflow-worker-thread`）⇒ `overrides` 全量切过去**装不上**。
   **判据**：把 `pnpm-workspace.yaml` 里被钉的每个包名逐个问 registry「有没有该版本」，
   统计覆盖率；**只有 100% 覆盖的版本才能当目标**。实测：`0.1.5-alpha.1→rc.3` 全部覆盖 189/189 ✓，
   `0.1.7-rc.2` 只覆盖 185/190 ✗。
2. **确认基线标签**：官方包**随 npm 只发 `lib/`**（**没有 `src/`**）⇒ 逐字节比对与合并的基线
   **只能取自 dsh 检出的标签**（`git -C /Users/kukucai/dsh archive <tag> <path>`），
   **不能用检出工作区**（HEAD 会前进，实测已到 0.1.7-rc.2）。
3. **停掉所有实例**：改 override 会**重建整个 `node_modules`** ⇒ 必须先停 9333 + 9222
   （`./scripts/corum-instance.sh stop --home=verify` + 打包实例）。

## 2. 每条命令的准确形态（照抄，别凭记忆）

```bash
# 安装：**必须全工作区**，且无 TTY 时必须 CI=true，改过 override 必须 --no-frozen-lockfile
CI=true pnpm install --no-frozen-lockfile

# 校验
pnpm --filter @corum/<pkg> run typecheck     # 单包
pnpm -r typecheck                            # 全仓（这一步不能省）
pnpm -r build                                # ⚠️ build 才会暴露"缺导出"类问题（tsc 发现不了）

# fork 守卫（**必须带基线标签**，否则拿 HEAD 当基线长期假红）
DSH_CHECKOUT=/Users/kukucai/dsh DSH_BASELINE_TAG=dsh-v0.1.5-rc.3 ./scripts/verify-fork-drift.sh
```

**已付学费的四个命令级坑**：

| 坑 | 现象 | 正确做法 |
|---|---|---|
| `pnpm install --filter <pkg>` | 把工作区依赖**裁到子集**（实测 `.pnpm` 里 dsh 包 **246 → 2**），全仓 typecheck 立刻挂 | **永远不带 `--filter`** |
| 无 TTY 跑 install | `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | `CI=true` |
| 改过 override 跑 install | `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` | `--no-frozen-lockfile` |
| `timeout` 命令 | macOS 无此命令 | 用后台 job 或脚本内轮询 |

## 3. 逐包升级循环（未 fork 包）

**每个包三步，缺一不可**：

1. 改包 `package.json` 里对 `@deepseek-ai/dsh-*` 的版本 → 目标版；
2. **同时**改根 `pnpm-workspace.yaml` overrides 里的**同名条目** → 目标版
   （⚠️ 只改包声明**没用**：override 会把它顶回旧版，实测确认）；
3. `CI=true pnpm install --no-frozen-lockfile` → 单包 typecheck → 全仓 typecheck → 提交。

**升级顺序**：按官方依赖数升序（依赖面小的先做，爆炸半径小）。

### ⚠️ 部分升级期唯一必须记住的规则：`^` 范围会静默带走未升级的包

实测白屏事故：`corum-ide-sidebar-ui` 声明 `^0.1.3-alpha.1`，我只升了**别的**包 ⇒ lockfile 重解析
把它依赖的 `ui-primitives` 带到 0.1.5 ⇒ 新版的 `require("anser")` 进了 bundle，而宿主模块表没有 ⇒
**白屏**（`Failed to load plugins` + `missed the module table`）。

**规则**：只要有包未升级，**被未升包共享的官方依赖就不能单独跳版**。
**修法**：把该官方依赖钉回旧版（`ui-primitives` 锁回 `0.1.3-alpha.1`），等它所有消费者都升完再一起升。

## 4. fork 批次（三方合并）

### 4.1 手法（本场定型）：官方为底 + 贴回 corum 增量

不要"在 corum 文件上补官方改动"（容易漏官方新功能）；要**以官方目标版文件为底**，
再把 corum 增量**逐处贴回**。这样自动获得官方全部新功能，corum 增量也能逐 marker 对齐验证。

**动手顺序**（前两步能省掉大量瞎猜）：

1. **先对齐"函数清单"**，不要先看 diff 片段：
   ```bash
   grep -nE "^(export )?(async )?function |^export const [a-zA-Z]+ = " <官方文件>
   grep -nE "^(export )?(async )?function |^export const [a-zA-Z]+ = " <corum 文件>
   ```
   实测教训：我曾以为 corum 是"就地改写官方那几行"✗，按 `record.key`/`record.env` 做锚点直接失败
   —— 对齐函数清单才发现 corum 是**新增了一个独立函数**（`encryptRecordSecrets`）✓。
2. **看 corum 侧的 `fork（corum）` / `CORUM-PATCH` 标记注释**（作者留下的意图就是增量清单）。
3. 逐处贴回，**贴完立刻逐 marker 计数比对**（`grep -c` 与备份对照），确认一处不漏：
   ```bash
   for pat in <marker1> <marker2>; do
     printf '%-24s %s\n' "$pat" "$(grep -c "$pat" <新文件>)"
   done
   # 与原 corum 备份对照：corumGitWriteRoots=5 existsSync=2 bind-try=2
   ```
4. 用脚本做替换时，**断言写在写盘之前**（`assert count == 1`）——
   失败时文件不会被写坏，可安全重试（本场靠这点省了多次回滚）。
5. **正则要按实际形态写**：本场两次因正则不符失败（多行 vs 单行、括号未转义）。
   先用 `grep -n` 打印**官方原文**，再写锚点。

### 4.2 三类 fork 的判别与升法

| 类型 | 判别 | 升法 | 实例 |
|---|---|---|---|
| **落后型** | 差异只是"官方后来改了/改名了" | 直接采用官方（corum 无增量） | `api-remotes`（14 行，0.1.3 时代的拷贝）|
| **挂点型** | corum 在官方文件里插了少量 hook/调用 | 官方为底 + 贴回挂点 | `credentials-local`（7 处加解密）、`fs-local`（2 处文案）|
| **自研替换型** | 文件名全不同、渲染层整体重写 | **保 corum** + 只跟非渲染层面（`index.ts`/`locales`/`d.ts`）| `ui-questions`（台账已定性"无法逐文件合并"）|

> `ui-questions` 的实测：官方 `PlanReviewPanel.tsx`/`QuestionComposer.tsx`/`contract/slots.ts`/`draft-store.ts`
> 对应 corum 的 `PlanReviewCard.tsx`/`QuestionCard.tsx`/`contract.ts`/`index.tsx` —— **名字全不同**，
> 强行合并会丢掉自研渲染层。**先读 `docs/fork-delta.md` 对应章节**（台账对每个 fork 都有"rebase 风险"定性）。

### 4.3 官方改名/重命名：要跟，而且要跨包全跟

实测两类，**都必须跟随，并检查跨包消费方**：

- **包名重命名**：`@deepseek-ai/node-addon-landlock-run` → `node-addon-system`
  （0.1.5 起）⇒ 改 import + `package.json` + `tsdown.config.ts`（全仓 4 处）。
- **事件名重命名**：`tool/code-dispatch(-start)` → `tool/ptc-dispatch(-start)`
  ⇒ corum 侧 **3 个包 8 个文件**消费该名（`corum-tools` / `ui-chat` / `ui-trajectory`）⇒
  **必须同步改**，否则轨迹视图与工具卡**静默失效**（不报错，只是没数据）。
  **方法**：`grep -rln "<旧名>" packages --include=*.ts` 找全消费方（含注释）。

## 5. fork 顶替名的 override 处置（判据唯一）

**判据 = 这个官方名在本仓还有没有"非 fork 消费者"**：

```bash
grep -rl '"@deepseek-ai/dsh-<名>"' packages --include=package.json | grep -vE '/lib/|/build/|/dist/|node_modules'
```

| 情形 | 处置 | 实例 |
|---|---|---|
| A. 已被 `link:` 顶替 | **不动**（消费者自动用 fork） | `dsh-fs-local`、`dsh-tools` |
| B. 有非 fork 消费者 | **随消费者一起升** | `dsh-api-remotes`（`ui-chat`/`ui-approval`/… 消费）|
| C. **无任何**非 fork 消费者 | **保持旧版不动** | `dsh-sandbox-local`、`dsh-credentials-local` |

- C 的理由：该名在本仓**根本不会被解析**（corum 用自己的 fork 包）⇒ 升它只会把无用的官方包
  拉进打包闭包、增加混版面。实测这两名在仓库内**零**消费者，且 0.1.3 与 0.1.5 **导出符号完全一致**。
- **包对"自身官方对照名"的声明不构成消费者**（例：`ui-questions` 声明 `dsh-client-ui-user-questions`）
  —— 那是升级期解析残留，**不驱动 override 升级**。
- **fork 顶替名的实际分档（实测，2026-09-28）** —— 18 个 fork 包的官方对照名并不都在 override 里：

  | 分档 | 官方名 | 现状 |
  |---|---|---|
  | override 里钉着旧版（合并前**必须保持**）| `dsh-agent`、`dsh-subagent`、`dsh-tool-subagent`、`dsh-sandbox-local`、`dsh-credentials-local`、`dsh-goal-round-driver` | 保持旧版 |
  | override 里是 `link:` 顶替 | `dsh-tools`、`dsh-fs-local` | 不动 |
  | override 里已随消费者升到目标版 | `dsh-api-remotes`、`dsh-client-ui-*`（会话域 6 个）| 随消费者 |
  | **根本不在 override 里**（零消费者、未安装）| `dsh-session-queue-revert` | 无需处置 |

  ⇒ **先查再动**：`grep -nE "'@deepseek-ai/dsh-<名>'" pnpm-workspace.yaml` —— 不在表里的名字不要凭空加进去。

## 6. 验证与验收

- **每个包**：单包 `typecheck` + **全仓 `typecheck`**（每步都跑，别攒着）+ **提交**（粒度 = 一个包一个提交，可独立回滚）。
- **必跑 `pnpm -r build`**：`tsc` 发现不了"缺导出"（`MISSING_EXPORT`）——
  实测 `dsh-client-ui-primitives@0.1.7` 需要 `dsh-util-workspace-path` 的 `pathPartsOf`，
  typecheck 全绿但 **build 直接失败**。
- **fork 守卫必须带基线标签**：`DSH_CHECKOUT=... DSH_BASELINE_TAG=<tag> ./scripts/verify-fork-drift.sh`
  （本场给守卫新增了 `DSH_BASELINE_TAG`；不设则拿检出工作区当基线 ⇒ 长期假红且无法区分
  「我们落后」与「我们改错了」）。**留意"跳过 N 项"** —— 环境变量没给全时，逐字节断言会**静默跳过**，
  那种"绿"不是绿。
- **打包前必须全部升完**：部分升级期同包多版本并存是正常的，但 `pack-macos` 的
  `closure uniform at <版本>` 断言会挡住混版闭包（2026-09-18 那次"两棵树模块实例"血案的成因）。
- **启动实测**：`./scripts/corum-instance.sh start|restart --home=verify` + 探针
  （外壳渲染 / 侧栏会话数 / `domNodes`）+ **查启动日志**（`renderer:error` / `Failed to load plugins` /
  `missed the module table`）。**「编译通过」不等于「能起来」** —— 白屏那次编译全绿。

## 7. 环境陷阱（本机特有，先记住）

| 陷阱 | 现象 | 做法 |
|---|---|---|
| **PATH 上的 `diff` 是 HarmonyOS SDK 的** | 对内容不同的文件**输出 0 行、退出 0** ⇒ 任何用 `diff` 判差异的脚本**静默漏报** | 判差异用 **`cmp -s`**；人读差异用 **`/usr/bin/diff`** |
| `sort`/`comm` 的 locale | 两侧不同 collation 时，同一路径会**同时出现在两个"独有"列表** | 统一 `LC_ALL=C` |
| `wc -l` 于无换行结尾 | 计数偏差 | 必要时用 `grep -c .` |
| 官方包无 `src/` | 仓库内 `packages/core/...` 是**路径错误**而非空结果 | 一律 `git -C /Users/kukucai/dsh archive <tag> <path>` |
| tar 的 `--strip-components` | 层级数猜错会解出**空目录**（本场错 4 次）| 解完先 `find ... -type d -name src` 定位，再对比 |

## 8. 收尾纪律

- 每完成一个包：**更新 `docs/UPGRADE-0.1.7-rc2.md`（活文档，追加本包结论）+ `docs/tasks/log.jsonl` 台账 + 提交**。
- **如实标注没做的事**（本场明确写了"只做版本对齐 + 编译，未跑测试/打包/实机"）。
- 发现自己的判断错误要**写进文档**（本场三处：误把 `credentials-local` 当未 fork 包、
  误按"就地改写"做锚点、误改注释里的官方包名导致守卫判红）—— 这些比成功经验更值钱。
- **守卫要求"逐字节一致"的文件，连文件头注释里的包名都不要改**（实测：注释也是判据的一部分）。
