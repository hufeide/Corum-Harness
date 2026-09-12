# corum Agent OS — Development Conventions (auto-injected into every session)

> This file is auto-injected into every new session by dsh agent-instructions
> (project-root `AGENTS.md`; mechanism: `packages/context/agent-instructions`,
> which walks up from cwd to the `.git` marker to locate this root).
> It lists **red lines + entry points only**; the full conventions live in
> `docs/dev-conventions.md` (read it in full before touching cross-bundle state
> or adding a plugin).

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
  `docs/audit/ARCHITECTURE-REMEDIATION-TODO.md` §C1 carries a superseded
  "precondition not met" conclusion — this file wins.
- `docs/fork-delta.md` — diff ledger of the fork packages (now 13, incl. the
  sandbox fork) + official-upgrade runbook (required reading before touching
  fork packages).
- `docs/HANDOFF-2026-09-10-orchestration-unification.md` — 编排统一化交接（官方四模式 +
  指挥模式 + orchestrate 双模式 + 隔离下沉 provider 层 + 提示词英文 + 非 git 降级核查）。
- `docs/HANDOFF-2026-09-12-session-orchestration.md` — **最新交接入口**（2026-09-12：
  第四轮交付真机验穿 + BUG-26/27/30~35、编排卡状态机（队列中/集成中/已集成/待集成/集成失败）、
  隔离台账 durable 判据与「并行工作区」栏分档、通知栏列表与浮窗解耦、浮窗可关、
  ui-verify 装置升级）；下个 session 从这里开始。
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
- Fork drift guard: `./scripts/verify-fork-drift.sh` (byte-identity of fork core
  files vs the dsh checkout, corum event declaration↔allowlist both ways,
  domain-event name alignment, host emit presence). Run it after any fork or
  event change.
- On-device verification / CDP: see the `corum-cdp-verify` skill
  (`./scripts/cdp.sh start|status|stop`).
