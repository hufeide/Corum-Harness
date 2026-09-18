# corum Agent OS — Development Conventions (auto-injected into every session)

> This file is auto-injected into every new session by dsh agent-instructions
> (project-root `AGENTS.md`; mechanism: `packages/context/agent-instructions`,
> which walks up from cwd to the `.git` marker to locate this root).
> It lists **red lines + entry points only**; the full conventions live in
> `docs/dev-conventions.md` (read it in full before touching cross-bundle state
> or adding a plugin).

> `.dbg/` was moved out of the working tree in commit `e74a5b44`: the `.dbg/...` paths in this document are historical evidence anchors — retrieval instructions and the per-file index are in [docs/DBG-ARCHIVE-INDEX.md](docs/DBG-ARCHIVE-INDEX.md).

## Red Lines (know these first)

1. **Cross-bundle shared state: always a cordis service, never a window global
   or module-level singleton.**
   dsh inlines `@corum/*` sources into every consumer bundle, so module-level /
   window-mounted state is split per bundle and never reconciled (the
   `__corumSidebarMode` case: it degraded into dead writes and broke the sidebar
   linkage). A cordis service instance's uniqueness is guaranteed by the root
   context `reflect.store` — **naturally singleton across bundles** (proven in
   `.dbg/cordis-singleton-probe.md`). Model shared state as a cordis service
   (provide + inject); no externalization needed.
   - Exceptions (legal window mounts — all "written once, read-only", not shared
     mutable state): `window.corumDesktop` (IPC bridge), `__corumNotify`,
     `__DSH_BOOT__` (the only client-side read path), `__corumSlotRegistry`
     (the cordis-free `ui-base/grid.ts` handoff — deleting it breaks the
     slotRegistry singleton).
2. **Don't casually externalize `@corum/*`**: the dsh module table has only 8
   hardcoded seeds; a custom shared module via the `dsh.client` plugin path
   white-screens the app (proof in `.dbg/b1-boot-graph-findings.md`). Route
   around it with the cordis service from rule 1.
3. **Cross-bundle type-face mismatch → narrow with a local capability
   interface**: the service type a consumer injects may be the official
   baseline's narrow interface (the corum runtime is a superset). Don't couple
   to the implementation package — narrow with a capability interface + helper
   (e.g. conversation's `SidebarModeCapableLayout`, recorded in
   `.dbg/c3a-sidebar-mode-service.md`).
4. **Consume cordis services via `inject` declarations, never `ctx.get` on an
   unassembled service** (the `ctx.remote` pitfall).
5. **Host-plugin changes require an app restart**; only renderer changes hot-
   reload via HMR. Any cross-package state / shell / scheduler change must pass
   the three-layer on-device CDP verification (UI renders + behavior + zero
   console errors). "It compiles" is not "done".

## Key Documents (read as needed)

- **`corum-dev-conventions` 技能** — 本文件与 `docs/dev-conventions.md` 的**可执行投影**
  （红线 / 改动工作流 / 已付学费的坑 / 证据标准 / 协作纪律），源码在本仓
  `skills/corum-dev-conventions/SKILL.md`，装进 corum 技能库并绑定给「Corum 开发」。
  改规范时**先改 docs，再同步这份技能**（docs 是规则的唯一家）。
- `docs/dev-conventions.md` — **the single home for rules** (must/never, decision
  trees, code do/don't, evidence index; §4a = subagent dual-instance discipline,
  §8 = event bus, §9 = mounting, §10 = agent/LLM mechanism, §11 = documentation
  discipline, §12 = team scheduler log, §13 = UI interaction red lines).
- `docs/LESSONS.md` — **the single home for experience**: phenomenon → root cause
  → practice, with source anchors (build/bundling, cordis, cross-bundle state,
  UI/CSS, sessions, subagents/orchestration, event bus, models, debugging
  recipes, collaboration). Rules do **not** go here; they graduate into
  `dev-conventions.md`.
- `docs/audit/NEXT-PHASE-DEFERRED.md` — deferred/closed architecture items
  (sidebarMode service done, slot-registry service done). Note
  `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md` §C1 was corrected in place
  (2026-09), but its **§C3a still carries an uncorrected superseded
  "precondition not met" conclusion** — `NEXT-PHASE-DEFERRED.md` wins.
  (Tracked: ledger `docs.audit.c3a-contradiction`.)
- `docs/fork-delta.md` — diff ledger of the fork packages (now 13, incl. the
  sandbox fork) + official-upgrade runbook (required reading before touching
  fork packages).
- `docs/HANDOFF-2026-09-10-orchestration-unification.md` — 编排统一化交接（官方四模式 +
  指挥模式 + orchestrate 双模式 + 隔离下沉 provider 层 + 提示词英文 + 非 git 降级核查）。
- `docs/HANDOFF-2026-09-18-packaging-pipeline-and-perf.md` — **最新交接入口**
  （2026-09-18 打包链路场：用户定调「一定要把打包做好，不然开发了不能发布没有意义」。
  **打包版起不了 agent 的真凶** = `pnpm deploy --legacy` 物化的闭包**系统性缺官方包**
  （工作区 208 个官方包里缺 35 个，因为它们在官方侧多为 peer/devDependency，而打包用
  `--prod --auto-install-peers=false`）；而 `.app` 在仓库里让 Node 从**工作区**补上缺包 ⇒ 能跑但
  **两棵树模块实例混用** ⇒ `dsh-scope` 的 `kScope` symbol 被切成两份 ⇒ `agent-presets: refusing to
  compose an unscoped context` ⇒ agent 挂载失败 ⇒ **整套 MCP 每秒重启**（CPU 高、下拉卡死的因）。
  修法 = 闭包按「工作区实际装了什么」补齐 + 去重 + 两个审计脚本 + 打包期断言。同一份交接还含
  **编排归因修复**（guest 轮次禁用 mtime 并集兜底）与 **agent 重建风暴护栏**。**下个 session 从这里开始。**）
- `docs/HANDOFF-2026-09-16-verify-gate-enforcement.md` — 上一份交接（verify 门禁场，已收口）
  （2026-09-16 verify 门禁场：接续上一份的 §2 遗留项并**收口**。根因 = 声明式 verify **从未进机制
  门禁**——`corumIntegrationTruth` 只判「分支是否进 HEAD」，而集成者用普通 `git merge` 时
  **合并提交自己就进了 HEAD**，故 verify 的 exit 1 被完全忽略；对照会话只因集成者恰好用了
  `--no-commit` 才被拦住 ⇒ 成败取决于子 Agent 偶然选的 git 命令。修法：机制自己跑声明并取退出码 +
  总判定收成「git 实况 ∧ verify exit 0」一个函数 + 拒绝形态类型化 + 通知不得说谎 + 被拒后解卡。
  **三条教训尤其值得先读**：加 orchestrate 结果字段**必须同步输出 schema**（漏了会被
  `INVALID_TOOL_OUTPUT` 整块吞掉 results，Bug B 的反向形态）、报告里**不许写与现场不符的承诺**
  （「PRESERVED」实测已被回收）、改 persona 前先想它会不会制造**新的卡死形态**
  （`--no-commit` 留下 `MERGE_HEAD` 毒化后续每一轮）。**下个 session 从这里开始。**）
- `docs/analysis/HANDOFF-2026-09-16-day-cards-empty-state-and-design-cleanup.md` — 同日日场交接
  （卡片 8 条缺陷收口 + 代码片段卡重设计（**照抄官方 token 级流式增量高亮**）+ **空态与会话宽度
  解耦重构**（文件独立、两条不变式）+ 设计稿同步与过时件清理。
  **六条教训**：画布态≠磁盘态（附磁盘侧判据）、`turn/end` 的 `reason.kind` 判成败、
  **CSS 自定义属性在声明它的元素上求值**（改上游 token 无效）、字体简写 token 不能当字族列表、
  删掉的节点不能在同一次 `execute` 里再引用、`.md` 在编辑器里是预览故没有 `.monaco-editor`）。
- `scripts/audit-dsw-tokens.py` — 设计 token 对账器（按官方 `design-platform.css` + corum
  `theme-layer.ts` 建权威表，列出「不存在的 token」与「多余 fallback」）。改 CSS token 前后各跑一次。
- `docs/analysis/HANDOFF-2026-09-16-card-batch-closeout-and-token-audit.md` — 同日凌晨场交接
  （卡片批次收口 + 纠正上一份交接的事实错误（pen 画布态 ≠ 磁盘态）+ 子任务被限流打断的判据
  + 全库设计 token 对账（12 个不存在的名字 / 硬编码 fallback 归零）+ 两份可复跑声明式规格进仓）。
- `docs/analysis/HANDOFF-2026-09-15-night-card-fidelity-isolation-and-settings.md` — 上一份交接
  （2026-09-15 夜场：卡片整改与设计稿对照 + 隔离漏洞补漏（父树未提交致静默失真 / 收口强制提交）
  + `llm-pi-ai` 段注册失败的根因（settings.yaml 里 `off` 被写成布尔 `false`）与两道防线
  + corum-dev 档案修复（conductor→standard）与技能绑定 + 派发了会话 `corum-task-7be7c4b2`）。
- `docs/analysis/HANDOFF-2026-09-15-unified-project-model-implementation.md` — 上一份交接
  （2026-09-15 统一存储/项目模型**实施**场：`type` 字段贯通 + 三条不变式与判定表 + 统一会话索引
  （`sessionId` 作键 —— 修正了原计划会静默丢 82.9% 的复合键形态）+ 泳道复用修复 + 存量迁移）。
- `docs/analysis/HANDOFF-2026-09-14-night-agent-capability-and-project-model.md` — 上一份交接
  （2026-09-14 深夜场：六条工作方式纪律 + Agent 能力核查 + **存储/项目组织模型定稿**）。
- `docs/analysis/HANDOFF-2026-09-14-supervised-rounds.md` — 上一份交接
  （2026-09-14 监督式委派轮：八条硬纪律 + 本场交付 + 待办队列）。
- `docs/HANDOFF-2026-09-12-session-orchestration.md` — 上一份交接（2026-09-12：
  第四轮交付真机验穿 + BUG-26/27/30~35、编排卡状态机（队列中/集成中/已集成/待集成/集成失败）、
  隔离台账 durable 判据与「并行工作区」栏分档、通知栏列表与浮窗解耦、浮窗可关、
  ui-verify 装置升级）。
- `docs/HANDOFF-2026-09-10-tray-and-notification-ownership.md` — 通知归属分档（全局只进主窗 /
  浮窗留直接反馈 toast + macOS 托盘常驻：菜单栏未读数字、关窗隐藏、单实例锁）。
- `docs/HANDOFF-2026-09-10-session-bar-and-notifications.md` — 上一份交接（会话条
  Agent 胶囊 + 通知 5s 收起 + P8 卡片按次锚点 + P1/P2/P4/P10 修复）。
- `docs/plugin-template.md` — new-plugin package template and setup steps.
- `.dbg/cordis-singleton-probe.md`, `.dbg/c3a-sidebar-mode-service.md` — the
  cordis cross-bundle singleton proof + the sidebarMode service implementation
  record (the slot-registry service reuses the same pattern: provide + inject +
  uSES source + InjectFace).

## Repo Quick Reference

- Plugins live in `packages/plugins/<group>/<name>` (groups: ui/session/agent);
  the desktop shell is `packages/desktop`. A new plugin must be added to
  `packages/desktop/package.json` deps + linked via `pnpm install`.
- Build: `pnpm --filter <name> run build` (build dependency packages such as
  ui-base first). Typecheck uses the same package filter.
- **Two checkouts — never confuse them**: this repo is the corum fork
  (`/Users/kukucai/work/kkc-desktop`, the working tree you edit); the official
  upstream checkout kept for comparison is `/Users/kukucai/dsh` (baseline
  `d347e70390` = tag `dsh-v0.1.3-alpha.1`). Official package sources
  (`packages/core`, `packages/api/*`, `packages/client/*`, `packages/subagent/*`)
  exist **only** in the dsh checkout: under this repo such a path resolves to
  nothing, so a repo-relative lookup like `packages/core` is a **path error, not
  an empty result**. Fork sources live here under `packages/plugins/**`
  (mapping ledger: `docs/fork-delta.md`).
- Fork drift guard: `./scripts/verify-fork-drift.sh` (byte-identity of fork core
  files vs the dsh checkout, corum event declaration↔allowlist both ways,
  domain-event name alignment, host emit presence). Run it after any fork or
  event change.
- On-device verification / CDP: see the `corum-cdp-verify` skill
  (`./scripts/cdp.sh start|status|stop`).
