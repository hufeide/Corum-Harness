/**
 * fork（corum）：**子 Agent 终态改动摘要**——从 `agent-service.ts` 按关注点抽出（2026-09-21）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 本模块只回答一个问题：**子会话跑完后，它改了哪些文件、进没进隔离台账**。
 * 它对会话生命周期、权限、指挥模式、泳道一无所知。
 *
 * ## 两个数据源（host source of truth）
 *
 * | 来源 | 取什么 | 缺席/抛错时 |
 * |---|---|---|
 * | `corumReview.snapshot(childSessionId)` | 子会话轮次的影子 git 快照（每文件 ±N 与改前状态） | 降级为「无文件列表」（只留 count） |
 * | `corumOrchestration.entriesOf(parentSessionId)` | worktree 台账条目（slug/branch/path/status） | 降级为「无隔离状态」 |
 *
 * **全部可选 + 防御**：两个来源都取不到 ⇒ 返回 `undefined`（卡片降级为不显示改动区）。
 * 这条纪律有实机出处：改动摘要属于**可见性增强**，绝不能把主 RPC 打挂
 * （2026-09-12 的教训，与 `agents.list` 那次误用同源 —— 见下面的 ⚠️）。
 *
 * ## ⚠️ 两处必须保留的兼容写法（删掉即复活已修事故）
 *
 * `agents.list` 在官方 registry 上是**方法**（`list(): Agent[]`），按属性 `for...of`
 * 会抛 `function is not iterable`；而这里被外层 `try/catch` 吞掉 ⇒ `integrated` 标记
 * **长期静默失效**（2026-09-12 实测）。故两处都写成
 * `typeof raw === 'function' ? raw() : raw` 以兼容「方法 / 可迭代属性」两种形态。
 * `tests/characterization` 与 `scripts/verify-refactor-guard.sh` 都钉住了它。
 *
 * @module @corum/corum-agent/change-summary
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubagentChangeSummary } from '@corum/corum-api-remotes/corum-events'

/** `corumReview.snapshot` 的返回值形状（只声明用到的字段）。 */
interface ReviewSnapshotValue {
  files: Array<{
    path: string
    added: number
    removed: number
    status?: 'content' | 'absent' | 'unavailable' | 'missing'
  }>
}

/** worktree 台账面（只声明用到的字段）。 */
interface OrchestrationFace {
  entriesOf(id: string): Array<{ slug: string; branch: string; path: string; status: string; runId?: string }>
}

/**
 * 从两个 host 来源合成子会话的改动摘要。
 *
 * @param ctx - 用于 `ctx.get('corumReview')` / `ctx.get('corumOrchestration')` / `ctx.get('agents')`。
 * @param childSessionId - 子会话 id。
 * @returns 摘要；两个来源都取不到内容时 `undefined`（卡片降级）。
 */
export async function buildChangeSummary(
  ctx: Context,
  childSessionId: string,
): Promise<SubagentChangeSummary | undefined> {
  // ① corumReview.snapshot(childSessionId) —— 子会话轮次的改动快照。
  let filesChanged = 0
  let files: SubagentChangeSummary['files'] | undefined
  let worktreeSlug: string | undefined
  let worktreeBranch: string | undefined
  let worktreePath: string | undefined
  const committed: boolean | undefined = undefined
  try {
    const review = ctx.get('corumReview') as
      | { snapshot: (sid: string) => Promise<ReviewSnapshotValue> }
      | undefined
    if (review !== undefined) {
      const snap = await review.snapshot(childSessionId)
      filesChanged = snap.files.length
      // 问题 1-④⑤ 收口：透传每文件改前状态（unavailable 的行 UI 置灰并标注
      // 「无可撤销内容」——常见于轮末并集兜底误算进来的非本 Agent 所写文件）。
      files = snap.files.map(f => ({
        path: f.path,
        added: f.added,
        removed: f.removed,
        ...f.status === undefined ? {} : { status: f.status },
      }))
    }
  } catch {
    // corumReview 缺席或取不到 → 改动摘要降级为只给 count（已知 0 或缺省）。
  }
  // ② worktree 台账 —— 隔离状态 + integrated 判定。
  //
  // 台账条目按 slug 相关（SubagentChildEvent.worktree.slug → entry.slug）。
  // 并发任务正在给台账加 childSessionId 字段——届时可改成按 childSessionId 精确匹配，
  // 此处暂用 slug 过渡。
  let integrated: boolean | undefined
  try {
    const orchestration = ctx.get('corumOrchestration') as OrchestrationFace | undefined
    if (orchestration !== undefined) {
      // 台账按父会话 id 查；子会话的父由 session.header.parentSession 给出。
      // 此处用 agents 服务反查父会话（与 settleFromEnd 的兜底同路）。
      // ⚠️ `.list` 是**方法**，按属性迭代会抛 `function is not iterable`
      // （此处被外层 try/catch 吞掉 → integrated 标记长期静默失效）。故两种形态都兼容。
      type ParentAgentLike = { session: { id: string; header?: { parentSession?: string } } }
      const agents = ctx.get('agents') as
        | { list?: Iterable<ParentAgentLike> | (() => Iterable<ParentAgentLike>) }
        | undefined
      let parentSessionId: string | undefined
      const rawList = agents?.list
      const parentCandidates: Iterable<ParentAgentLike> = typeof rawList === 'function' ? rawList() : rawList ?? []
      for (const agent of parentCandidates) {
        if (String(agent.session.id) === childSessionId) {
          parentSessionId = agent.session.header?.parentSession
          break
        }
      }
      if (parentSessionId !== undefined) {
        const entries = orchestration.entriesOf(parentSessionId)
        // 并发任务加 childSessionId 后可改成精确匹配；当前按 slug 过渡。
        for (const entry of entries) {
          // integrated 状态：一旦台账说 integrated，就标记。
          if (entry.status === 'integrated') {
            integrated = true
          }
          // 记录 slug/branch/path 供卡片展示 + diff 打开（首次遇到的隔离条目）。
          if (worktreeSlug === undefined) {
            worktreeSlug = entry.slug
            worktreeBranch = entry.branch
            worktreePath = entry.path
          }
        }
      }
    }
  } catch {
    // 台账取不到 → 隔离状态降级（不阻断改动列表）。
  }
  if (filesChanged === 0 && worktreeSlug === undefined && integrated === undefined) return undefined
  return {
    filesChanged,
    ...files === undefined ? {} : { files },
    ...worktreeSlug === undefined ? {} : { worktreeSlug },
    ...worktreeBranch === undefined ? {} : { worktreeBranch },
    ...worktreePath === undefined ? {} : { worktreePath },
    ...committed === undefined ? {} : { committed },
    ...integrated === undefined ? {} : { integrated },
  }
}

/**
 * 终态改动摘要的**异步补发**：终态帧已同步发出（含 `stopReason`），此处 fire-and-forget
 * 追加一帧带 `changeSummary` 的进度帧——卡片收到后渲染「改动」区。
 *
 * 不阻塞终态帧本身（`corumReview.snapshot` 是 async 的，子 Agent 已完工，延几十 ms 追发
 * 不影响体验）。失败静默（卡片降级为不显示改动区）。
 *
 * @param ctx - 见 {@link buildChangeSummary}。
 * @param childSessionId - 子会话 id。
 * @param emitTerminalFrame - 发帧回调（由进度跟踪器提供；会话已 dispose 时它自己会拒发）。
 */
export function emitChangeSummary(
  ctx: Context,
  childSessionId: string,
  emitTerminalFrame: (sessionId: string, summary: SubagentChangeSummary) => void,
): void {
  void (async () => {
    const summary = await buildChangeSummary(ctx, childSessionId)
    if (summary === undefined) return
    emitTerminalFrame(childSessionId, summary)
  })()
}
