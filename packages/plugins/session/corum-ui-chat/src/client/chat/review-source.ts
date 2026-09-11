// fork（corum）：Review 卡的数据源 —— **git 影子仓库版**（2026-09-11 重构）。
//
// 旧实现从会话事件流（tool/call 的 oldString/newString）反推「改动前」，有三个绕
// 不过去的缺陷：整文件覆盖（`write`）的旧内容不可知；反推要求唯一匹配、会随外部
// 改动漂移；增删行数只能自写 LCS 近似。现在全部交给 host 的 `corumReview` 影子
// git 仓库（见 packages/desktop/src/host/corum-review.ts）：
//
//   本模块只做三件事：订阅刷新信号 → 拉 `snapshot` RPC → 转成卡片要的形状。
//   撤销/查看改动前/单文件保留 也都是一次 RPC，没有任何本地重算。
//
// 保留的客户端内状态只有一个：**单文件「保留」= 「我已看过」**（用户定调
// 2026-09-11）。它纯客户端、仅本轮有效 —— 轮次变化（roundIndex 变了）就清空。

import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { emptyReviewChanges, type ReviewChanges } from './review-changes.ts'

/** Review 卡对外面：当前聚合 + 动作 + 单文件原文（供看 diff）。 */
export interface ReviewSource extends ObservableSnapshot<ReviewChanges> {
  /** 「全部撤销」：把本轮所有改动回退到改前。 */
  revertAll(): Promise<RevertAllResult>
  /** 「全部保留」：本轮改动就是工作区现状，不需要做什么 —— 清空「已看过」标记即可。 */
  keepAll(): void
  /** 「保留此文件」：标记为已看过（仅本轮），它随即从卡片消失。 */
  keepFile(path: string): void
  /** 「撤销此文件」：只回退这一个文件。 */
  revertFile(path: string): Promise<RevertAllResult>
  /** 取某文件「改动前」的内容，供编辑器开 diff。 */
  fileBefore(path: string): Promise<ReconstructResult>
}

/** 撤销结果（沿用旧形状，UI 不用改）。 */
export interface RevertAllResult {
  readonly ok: boolean
  readonly reverted: number
  readonly failed: number
  readonly skipped: number
  readonly message?: string
}

/** 取「改动前」内容的结果（沿用旧形状）。 */
export interface ReconstructResult {
  ok: boolean
  content: string
  /** 是否完整（git 版恒为 true：内容是精确的）。 */
  complete: boolean
  path: string
  note?: string | undefined
  message?: string | undefined
}

/** host `corumReview/snapshot` 的响应。 */
interface SnapshotValue {
  workspace: string | null
  roundIndex: number
  files: { path: string; added: number; removed: number; hash: string }[]
}

/** 把 RPC 信封拆开；失败返回 null 并打印原因。 */
function unwrap<T>(response: { ok: boolean; value?: T; error?: { message?: string } }): T | null {
  if (response.ok && response.value !== undefined) return response.value
  console.warn('[ui-chat] corumReview rpc failed:', response.error?.message)
  return null
}

/**
 * 创建 Review 数据源。
 * @param sessionId - 会话 id（host 用它索引活轮次）。
 * @param connection - RPC 句柄。
 * @param eventSource - 会话事件窗；仅用作**刷新信号**（写入会推进事件序列号）。
 */
export function createReviewSource(
  sessionId: string,
  connection: ConnectionHandle,
  eventSource: SessionEventSource,
): ReviewSource {
  let current: ReviewChanges = emptyReviewChanges()
  let roundIndex = 0
  /**
   * 单文件「已看过」标记：`path → 当时的内容 blob 哈希`。
   *
   * 记**内容哈希**而不是裸 path（C1）：文件被再改一次后哈希变了，标记自然失效、
   * 条目重新出现。只按 path 记的话，用户「保留」过一个文件之后它再被改也一直隐藏。
   * 轮次变化（roundIndex 变）时整体清空 —— 用户定调：标记仅本轮有效。
   */
  let seen = new Map<string, string>()
  const listeners = new Set<() => void>()
  let inFlight = false
  let again = false

  const call = async <T,>(method: string, args: Record<string, unknown>): Promise<T | null> => {
    try {
      const response = await connection.rpc.call('/api', method, { args }) as
        { ok: boolean; value?: T; error?: { message?: string } }
      return unwrap<T>(response)
    } catch (error) {
      console.warn(`[ui-chat] ${method} threw:`, error)
      return null
    }
  }

  /** 拉一次快照并转成卡片形状。 */
  const refresh = async (): Promise<void> => {
    if (inFlight) { again = true; return }
    inFlight = true
    try {
      const value = await call<SnapshotValue>('corumReview/snapshot', { sessionId })
      if (value === null) return
      // 轮次变了 → 「已看过」标记作废（用户定调：仅本轮有效）。
      if (value.roundIndex !== roundIndex) { roundIndex = value.roundIndex; seen = new Map() }
      const files = value.files
        .filter(file => seen.get(file.path) !== file.hash)
        .map(file => ({
          path: file.path,
          added: file.added,
          removed: file.removed,
          // git 版不需要逐条 op（旧实现用它做反推与统计），留空数组保持形状兼容。
          ops: [],
        }))
      const next: ReviewChanges = {
        totalAdded: files.reduce((sum, f) => sum + f.added, 0),
        totalRemoved: files.reduce((sum, f) => sum + f.removed, 0),
        files,
        revertOrder: [],
      }
      // 内容没变就不通知（避免每次事件都重渲染卡片）。
      const same = next.totalAdded === current.totalAdded
        && next.totalRemoved === current.totalRemoved
        && next.files.length === current.files.length
        && next.files.every((f, i) => f.path === current.files[i]?.path
          && f.added === current.files[i]?.added
          && f.removed === current.files[i]?.removed)
      if (same) return
      current = next
      for (const listener of listeners) listener()
    } finally {
      inFlight = false
      if (again) { again = false; void refresh() }
    }
  }

  // 事件窗每次发布都重拉（写入会推进 seq）。这里刻意**不做节流窗口**：写入频率
  // 受 inFlight+again 合并（并发去重 + 尾随一次），足够挡住密集写入。
  eventSource.subscribe(() => { void refresh() })
  void refresh()

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    revertAll: async () => {
      const value = await call<{ ok: boolean; restored: number; failed: number; message?: string }>(
        'corumReview/rollback', { sessionId },
      )
      if (value === null) return { ok: false, reverted: 0, failed: 0, skipped: 0, message: 'RPC 失败' }
      await refresh()
      return {
        ok: value.ok,
        reverted: value.restored,
        failed: value.failed,
        skipped: 0,
        ...value.message === undefined ? {} : { message: value.message },
      }
    },
    keepAll: () => {
      // 「全部保留」= 「这些我都看过了，收起卡片」。
      //
      // git 版下改动**本来就已经应用**（工作区现状即是保留的结果，轮次边界还会自动
      // 提交），所以这个按钮不需要对磁盘做任何事 —— 它唯一的作用就是把当前列出的文件
      // 全部标记为「已看过」。
      //
      // ⚠️ 这里曾经写成 `seen = new Set()`（清空标记），语义正好反了：刚被单独「保留」
      // 过的文件会重新冒出来、卡片也不收起 —— 与按钮字面意思相反（用户报的
      // 「点全部保留不生效」就是它）。
      // 记下「当时的内容哈希」：文件之后再变，标记自动失效。
      for (const file of current.files) { if (file.hash !== undefined) seen.set(file.path, file.hash) }
      current = emptyReviewChanges()
      for (const listener of listeners) listener()
    },
    keepFile: (path: string) => {
      const target = current.files.find(f => f.path === path)
      // 记内容哈希（C1）：该文件之后再被改动时标记自动失效。
      if (target?.hash !== undefined) seen.set(path, target.hash)
      const files = current.files.filter(f => f.path !== path)
      current = {
        totalAdded: files.reduce((sum, f) => sum + f.added, 0),
        totalRemoved: files.reduce((sum, f) => sum + f.removed, 0),
        files,
        revertOrder: [],
      }
      for (const listener of listeners) listener()
    },
    revertFile: async (path: string) => {
      const value = await call<{ ok: boolean; restored: number; failed: number; message?: string }>(
        'corumReview/rollback', { sessionId, path },
      )
      if (value === null) return { ok: false, reverted: 0, failed: 0, skipped: 0, message: 'RPC 失败' }
      await refresh()
      return {
        ok: value.ok,
        reverted: value.restored,
        failed: value.failed,
        skipped: 0,
        ...value.message === undefined ? {} : { message: value.message },
      }
    },
    fileBefore: async (path: string) => {
      const value = await call<{ exists: boolean; content: string; created: boolean }>(
        'corumReview/fileBefore', { sessionId, path },
      )
      if (value === null || !value.exists) {
        return { ok: false, content: '', complete: false, path, message: '该文件不在本轮改动里' }
      }
      return {
        ok: true,
        content: value.content,
        complete: true,
        path,
        // 新建文件：左侧为空是**正确**的（改前确实不存在），不该当成「重建不完整」。
        ...value.created ? { note: '该文件是本轮新建的，左侧为空' } : {},
      }
    },
  }
}
