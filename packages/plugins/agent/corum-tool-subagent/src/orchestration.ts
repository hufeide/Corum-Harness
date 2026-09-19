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
  CorumIntegrateRejected,
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
  // fork（corum）2026-09-16：机制侧 verify 门禁（git 实况 ∧ 声明式 verify 退出码）。
  corumIntegrationVerdict,
  corumRunIntegrateVerify,
  corumVerifyFailureNotice,
  corumResolveRejectedIntegration,
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
  // fork（corum）2026-09-20：集成判定按条目 + 分支 tip 快照——修「集成实际成功却被
  // 误判未落地」（集成者 merge 后合规 `branch -D`，按分支名判定必然假阴）。
  corumEntryIntegrated,
  corumShaInHead,
  corumSnapshotBranchTips,
  corumReconcileIntegrated,
  corumMergedBranches,
  corumPendingIntegration,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumCommitWorktreeOnSettle,
  CORUM_AUTO_COMMIT_SUBJECT,
  CORUM_INTEGRATE_VERIFY_TIMEOUT_MS,
  corumDirtyParentRefusal,
  corumVisibleToolNames,
  corumWorktreeHasUncommitted,
  corumWriteToolsForPlatform,
  corumOrchestrationDomainSpec,
} from '@corum/corum-orchestration'
export type {
  CorumChildSpawnFacts,
  CorumCleanupOptions,
  CorumSettleCommitFailure,
  CorumIntegrationTruth,
  CorumVerifyResult,
  CorumWorktreeEntry,
  CorumWorktreeLedgerFrame,
  CorumLedgerRecord,
} from '@corum/corum-orchestration'
