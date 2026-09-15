/**
 * fork（corum）：子 Agent 编排器——隔离台账状态 + worktree 编排的单一事实源。
 *
 * 2026-09 重构 1（docs/plan/PLAN-refactor-orchestration-package-and-settings-center.md）：
 * 编排器已拆出为独立包 `@corum/corum-orchestration`。本文件保留为 **re-export
 * 垫片**——tool-subagent 的 `index.ts` 内部 import 路径与单测
 * `from '../src/orchestration.ts'` 均不变（零破坏）。
 *
 * 消费方：fork #10 工具（经 service 调用保持行为等价）→ orchestrate 工具。
 *
 * @module @corum/corum-tool-subagent/orchestration
 */

export {
  CorumOrchestration,
  corumBranchIntegrated,
  corumBranchMerged,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumDetectIntegrateChecks,
  corumEffectiveToolFilter,
  corumDirectWriteNotice,
  corumEntryDead,
  corumIsolationBoundaryNotice,
  corumIsolationNotice,
  corumGit,
  corumGitHead,
  corumGitStatusPorcelain,
  corumIntegrationFailure,
  corumDirtyOwnershipLines,
  corumIntegrationTruth,
  corumIntegratorPersona,
  corumIsGitRepo,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPartialIntegrationNotice,
  corumPortBranchDiff,
  corumPortPendingBranches,
  corumMergeBase,
  corumMutationToolsForPlatform,
  corumAutoIntegrate,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumBranchAddsCommits,
  corumBranchTip,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumCommitWorktreeOnSettle,
  CORUM_AUTO_COMMIT_SUBJECT,
  corumDirtyParentRefusal,
  corumVisibleToolNames,
  corumWorktreeHasUncommitted,
  corumWriteToolsForPlatform,
  corumOrchestrationDomainSpec,
} from '@corum/corum-orchestration'
export type {
  CorumCleanupOptions,
  CorumSettleCommitFailure,
  CorumIntegrationTruth,
  CorumWorktreeEntry,
  CorumWorktreeLedgerFrame,
  CorumLedgerRecord,
} from '@corum/corum-orchestration'
