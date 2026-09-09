# `.dbg/` 目录索引（证据记录）

> 本目录存放**原始证据**：机制勘察、探针实录、审计分片、决策过程稿、CDP 截图。
> 它**不是规范也不是经验沉淀**——结论性内容已提炼到：
>
> - **规则（必须/禁止）** → [`docs/dev-conventions.md`](../docs/dev-conventions.md)（附录含 rule ↔ evidence 索引）
> - **经验（现象 → 根因 → 做法）** → [`docs/LESSONS.md`](../docs/LESSONS.md)
> - **fork 差异** → [`docs/fork-delta.md`](../docs/fork-delta.md)
>
> 引用纪律：文档/规范引用本目录文件时**必须写明小节锚点**（如
> `.dbg/c1-slot-registry-service.md` §关键设计决策 2），不要只给文件名。
> 删除或移动本目录文件前，先 `grep -rn "<文件名>" docs AGENTS.md README.md`
> 确认无 live 引用（多数文件被 AGENTS.md 红线 / 规范附录 / NEXT-PHASE-DEFERRED 直接引用）。

## A. 证据锚点（**保留，勿删**）

| 文件 | 内容 | 被谁引用 |
|---|---|---|
| `cordis-singleton-probe.md` | cordis 服务跨 bundle 单例实证（root `reflect.store`） | AGENTS.md 红线 1；dev-conventions §1/§附录；LESSONS §3.7 |
| `c3a-sidebar-mode-service.md` | sidebarMode 服务化落地（provide + inject + uSES + InjectFace） | AGENTS.md 红线 3；dev-conventions §1/§2.4；LESSONS §3.4/§3.7 |
| `c1-slot-registry-service.md` | slotRegistry 服务化 + visibility 三态替代 24 条 EXCLUDE | dev-conventions §2.3/§附录；NEXT-PHASE-DEFERRED §1；LESSONS §2.1/§3.8 |
| `b1-boot-graph-findings.md` | boot 模块表机制 + external 化白屏实证 | AGENTS.md 红线 2；dev-conventions §3.1/§3.2；LESSONS §2.11–2.13/§3.3 |
| `b1-official-mechanism-recheck.md` | 0.1.2-alpha.2 官方复核：机制墙 + 规范墙 | dev-conventions §3.1/§3.4b；LESSONS §2.12/§2.14 |
| `event-bus-audit-2026-09.md` | 事件总线三期范围审计 + P2 收尾台账 | UNIFIED-EVENT-BUS §4；PROGRESS；LESSONS §7.4/§7.8–7.10 |
| `audit-B-session.md` | 会话域审计分片（fork 整改清单） | `docs/fork-delta.md` §1 |
| `audit-{A,C,D,E}-*.md`、`audit-crosscut-findings.md` | CODE-AUDIT-REPORT 分片原文（局部过时，需对照台账读） | `docs/audit/CODE-AUDIT-REPORT.md`；LESSONS §9.11 |
| `agent-presets-requirements.md` | 用户原话约束（Agent 预设功能） | 该功能设计基线 |
| `agent-presets-final-design.md` | Agent 预设功能定稿（代码落点唯一对照物） | dev-conventions §13；LESSONS §10.10 |
| `B4-cross-package-css-issue.md` | 跨包 CSS 初诊 + 后续修正（正文初诊已被推翻，读时注意「状态」段） | ARCHITECTURE-REMEDIATION-TODO §B4；LESSONS §1.8/§1.9 |
| `unified-event-bus/san3-2-report.md` | 三期验证报告（同目录 png 为截图） | LESSONS §7.8 |

## B. 过程稿 / 已被取代（保留作决策留痕，**不作为事实源**）

| 文件 | 状态 |
|---|---|
| `agent-presets-pm-review.md` | 过程稿：Q2「名片不显示」、Q3「保存自动缩回」均被用户否决；结论以 `agent-presets-final-design.md` 为准 |
| `agent-presets-ux-recommendations.md` | 过程稿：Q1–Q4 建议，被 final-design 部分覆盖 |
| `b1-ui-base-external-plan.md` | 早期勘察，机制结论已被 `b1-boot-graph-findings.md` + `b1-official-mechanism-recheck.md` 完整覆盖 |
| `phase5-*.png`、`phase6-*.png`、`sidebar-*.png` | CDP 验证截图，被 `docs/HANDOFF-0.1.3-upgrade.md` / `docs/fork-delta.md` 引用，**暂留** |

## C. 待办

- 若要把 B 组移入 `.dbg/archive/`：先摘出 `b1-ui-base-external-plan.md` 独有的
  「B1-main 补充勘察：事件桥根源（attachPanels 模式）」并入 dev-conventions，并同步
  修改 `docs/audit/NEXT-PHASE-DEFERRED.md` §参考文档第 5 条的引用。
- `unified-event-bus/*.png|jpg`（19 张）体积较大，可迁出仓库；文字报告保留。
