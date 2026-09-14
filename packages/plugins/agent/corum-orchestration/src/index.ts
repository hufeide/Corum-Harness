/**
 * @corum/corum-orchestration — 子 Agent 编排器独立包入口。
 *
 * 从 @corum/corum-tool-subagent 拆出的编排层（docs/plan/PLAN-refactor-
 * orchestration-package-and-settings-center.md 重构 1）：台账状态（红线 1 合规的
 * cordis 服务）+ worktree 编排纯函数 + 台账持久化 domain 的单一事实源。
 *
 * 挂载方式（用户选定「新包自己挂 cordis 行 provide」）：
 * - `cordis.patch.yml` 的 insert 段挂本包行（name `@corum/corum-orchestration`），
 *   行序**必须**在 corum-tool-subagent 的 preset 双实例 apply 之前；
 * - 本 apply 在根上下文幂等 provide `corumOrchestration`（get-or-create）；
 * - tool-subagent 的 apply 改为「只读不建」（`ctx.root.get('corumOrchestration')`，
 *   缺则抛装配错误——顺序由 patch.yml 行序承担）。
 *
 * 服务名 `corumOrchestration` 不变，消费方零感知。纯函数/类型/domain 全量
 * re-export，tool-subagent 的 `orchestration.ts` 改为从本包 re-export 保持
 * 内部 import 路径与单测 `from '../src/orchestration.ts'` 不变（零破坏）。
 *
 * @module @corum/corum-orchestration
 */

import type { Context } from '@deepseek-ai/cordis'
import { CorumOrchestration } from './orchestration.ts'

/** cordis 插件名（patch.yml insert 行的 name 即包名，本常量仅声明用途）。 */
export const name = 'corum-orchestration'

/**
 * 在根上下文幂等 provide 编排器 service（已 provide 则复用）。
 * 挂到根上下文：台账语义是会话级（key=父 session id），必须跨会话/跨 bundle 单例
 * 共享（红线 1）。新包独立挂载后，tool-subagent 只读消费，不再自建兜底。
 */
export function apply(ctx: Context): void {
  const orchestration = ctx.root.get('corumOrchestration', false) as CorumOrchestration | undefined
    ?? new CorumOrchestration(ctx.root)
  void orchestration
}

export {
  CorumOrchestration,
  corumBranchIntegrated,
  corumBranchMerged,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumEffectiveToolFilter,
  corumEntryDead,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumDirtyOwnershipLines,
  corumIntegrationFailure,
  corumMutationToolsForPlatform,
  corumAutoIntegrate,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumBranchTip,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumIntegrationTruth,
  corumPartialIntegrationNotice,
  corumPortBranchDiff,
  corumPortPendingBranches,
  corumMergeBase,
  corumIntegratorPersona,
  corumDirectWriteNotice,
  corumIsGitRepo,
  corumIsolationBoundaryNotice,
  corumIsolationNotice,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumVisibleToolNames,
  corumWorktreeHasUncommitted,
  corumWriteToolsForPlatform,
  corumOrchestrationDomainSpec,
} from './orchestration.ts'
export type {
  CorumWorktreeChild,
  CorumWorktreeChildOptions,
  CorumCleanupOptions,
  CorumIntegrationTruth,
  CorumWorktreeEntry,
  CorumWorktreeLedgerFrame,
  CorumLedgerRecord,
} from './orchestration.ts'
