/**
 * corum-desktop/corum-review-round-policy — Review 轮次的**纯策略**（无 I/O、无 git）。
 *
 * 为什么单独成文件：`corum-review.ts` 是本仓最大的 host 文件之一，而这里的两条判定
 * 是**归因正确性**的关键（错了会让审查卡把别人的改动算到某个 Agent 头上、或让一个
 * 已完工的子 Agent 看起来什么都没改）。抽取成零 import 的纯函数后，可以按本仓既有
 * 约定跨包单测（desktop 包没有 vitest 装置，见
 * `packages/plugins/agent/corum-tool-subagent/tests/review-bash-writes.spec.ts` 头部的
 * 说明），而 `corum-review.ts` 只负责把现场值喂进来。
 *
 * 两条判定的来历（2026-09-18 真机缺陷收口，证据见 docs/LESSONS.md §6.30）：
 *
 * 1. `isSharedWorkspaceRound` —— 「轮末并集兜底」按 **mtime ≥ 本轮开始时刻** 从
 *    `git status --porcelain` 里挑改动，这个判据只在**本轮独占该工作区**时成立。
 *    只读调研子会话与父会话**共用**父工作区，父 Agent 在同一时间窗里编辑的每一个文件
 *    都会被并集扫进子会话的轮次 → 子会话的 pre-image 抓到的是父 Agent 的半成品 →
 *    审查卡的子条目**覆盖**父条目并打上「子 Agent」标签（真机实测：9/9 条全被误标）。
 *
 * 2. `resolveSnapshotSource` —— 隔离 worktree 在集成后会被回收（正常happy path），
 *    而轮次的 `workspace` 仍指向那个**已不存在的目录**。此时按实时重算读到的「当前
 *    内容」是「文件不存在」⇒ 每个文件都算成「全删」；若 pre-image 也取不回，条目会被
 *    `净变化 0 → 跳过` 静默丢掉 ⇒ 子 Agent 卡片的改动区显示为空。所以工作区不在时
 *    **一律不许重算**，只能回放「工作区还在时算出的那一份真相」。
 */

/**
 * 判定「本轮是否在**别人的**工作区里读改动」（guest 轮次）—— guest 轮次禁止 mtime 并集兜底。
 *
 * 三条分支，全部朝「宁可漏，不可猜」的方向倒（与 `scanWorktreeChanges` 同一条原则）：
 *   1. 父子关系**已知**：父 cwd 已知且等于本轮工作区 ⇒ guest；父 cwd 未知 ⇒ guest（不猜）；
 *      父 cwd 不同 ⇒ 不是 guest（隔离子会话独占自己的 worktree，兜底网该留着）。
 *   2. 父子关系**未知**且本轮是**回放**出来的（`fromJournal`）：按 guest 处理，直到该会话
 *      被证明是工作区所有者。为什么必须有这一条：旧版 journal 行没有 `parent` 字段，
 *      重启后回放出的 guest 轮次认不出父会话 —— 若按「所有者」放行，并集兜底会立刻把
 *      父 Agent 当时的脏文件重新记到子 Agent 头上，修好的缺陷原样复活。
 *   3. 其余（在线看到的会话、已证明是所有者）⇒ 不是 guest，保留兜底网。
 *
 * @param input.parentSession - 本会话的父会话 id（会话 header 的 `parentSession`）。
 * @param input.parentCwd - 父会话的 cwd；未知时给 `undefined`。
 * @param input.workspace - 本轮的工作区（会话 cwd）。
 * @param input.fromJournal - 本轮是从 journal 回放出来的（重启后恢复）。
 * @param input.knownWorkspaceOwner - 该会话已被证明是工作区所有者（见过它的会话事件且没有父会话）。
 * @returns true = 禁止对本轮做 mtime 并集兜底。
 */
export function isGuestRound(input: {
  readonly parentSession: string | undefined
  readonly parentCwd: string | undefined
  readonly workspace: string
  readonly fromJournal: boolean
  readonly knownWorkspaceOwner: boolean
}): boolean {
  const parent = input.parentSession
  if (parent !== undefined && parent !== '') {
    if (input.parentCwd === undefined || input.parentCwd === '') return true
    return input.parentCwd === input.workspace
  }
  return input.fromJournal && !input.knownWorkspaceOwner
}

/** `resolveSnapshotSource` 的结论。 */
export type SnapshotSource =
  /** 有活轮次且工作区健在：照常实时重算。 */
  | { readonly kind: 'live' }
  /** 不许重算：回放冻结态（附理由，便于调用方决定日志/降级话术）。 */
  | { readonly kind: 'frozen'; readonly reason: 'round-closed' | 'workspace-gone' }
  /** 既没有活轮次也没有冻结态：诚实地报「不知道」。 */
  | { readonly kind: 'none' }

/**
 * 决定一次 `snapshot` 该从哪里取数据。
 *
 * 关键约束：**工作区不在时绝不实时重算**。重算的输入是「工作区里的当前内容」，
 * 目录没了就只剩「文件全被删」这一个假结论。
 *
 * @param input.hasLiveRound - `rounds` 里还有该会话的活轮次。
 * @param input.workspaceAlive - 活轮次的 `workspace` 目录当下存在。
 * @param input.hasFrozen - 有该会话的冻结态（工作区健在时算出的最后一份改动列表）。
 * @returns 取数来源；`frozen` 只会在 `hasFrozen` 为真时返回。
 */
export function resolveSnapshotSource(input: {
  readonly hasLiveRound: boolean
  readonly workspaceAlive: boolean
  readonly hasFrozen: boolean
}): SnapshotSource {
  if (input.hasLiveRound && input.workspaceAlive) return { kind: 'live' }
  if (input.hasFrozen) return { kind: 'frozen', reason: input.hasLiveRound ? 'workspace-gone' : 'round-closed' }
  return { kind: 'none' }
}

/** 冻结态最多保留多少个会话（内存护栏：冻结态会钉住 pre-image，不能无界增长）。 */
export const MAX_FROZEN_ROUNDS = 16

/** 会话 id → cwd / 父会话的记账上限（长进程里见过的会话数无界）。 */
export const MAX_SESSION_LEDGER = 1024

/**
 * 冻结态淘汰名单（按 `at` 最旧优先）。
 *
 * 纯函数便于单测「上限生效」这条不变量 —— 内存护栏写错了在真机上只表现为
 * 「进程越跑越胖」，几乎不可能靠人工发现。
 *
 * @param entries - 当前冻结态（sessionId + 写入时刻）。
 * @param max - 保留上限。
 * @returns 需要删除的 sessionId 列表（按最旧→最新）；未超限时为空数组。
 */
export function selectFrozenEvictions(
  entries: readonly { readonly sessionId: string; readonly at: number }[],
  max: number = MAX_FROZEN_ROUNDS,
): string[] {
  if (max <= 0) return entries.map(e => e.sessionId)
  const overflow = entries.length - max
  if (overflow <= 0) return []
  return [...entries]
    .sort((a, b) => (a.at === b.at ? a.sessionId.localeCompare(b.sessionId) : a.at - b.at))
    .slice(0, overflow)
    .map(e => e.sessionId)
}
