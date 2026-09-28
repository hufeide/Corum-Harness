/**
 * `SubagentProgressService` 的**读路径快照**契约（2026-09-27 卡顿修复 A）。
 *
 * 背景（打包态实测，`docs/PENDING-ui-lag-multiround.md` §2.10）：`getChildSessionProgressRemote`
 * 原先**每次调用**都重扫子会话的持久化日志再折叠——一个 4.8 万条事件的子会话要 **1.35 s**，
 * 而 47 轮会话会**成批**拉 30+ 张卡片 ⇒ 几十秒卡顿。
 *
 * 本文件锁住修复所依赖的**信任口径**（错了会显示过期进度，比慢更糟）：
 *   ① `remember` 写入的态在窗口内可用，且带出 `lastActive`（中断判定要用它）；
 *   ② **非终态**且超出信任窗口 ⇒ 必须 `undefined`（调用方回落读盘），绝不假装新鲜；
 *   ③ **终态**（`done === true`）是稳定事实 ⇒ 窗口过期后仍可用；
 *   ④ `clear` 与容量淘汰必须**连伴随表一起清**，否则等于内存泄漏。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SubagentProgressTracker, SUBAGENT_PROGRESS_CAP, SUBAGENT_PROGRESS_TRUST_MS } from '../src/subagent-progress.ts'

const makeService = () => new SubagentProgressTracker({} as Context, {} as never)

describe('SubagentProgressTracker 读路径快照', () => {
  it('① remember ⇒ snapshotOf 原样返回态与 lastActive', () => {
    const service = makeService()
    service.remember('child-1', { turn: 3, step: 7, done: false, currentAction: 'bash' }, 1700000000000)
    expect(service.snapshotOf('child-1')).toEqual({
      state: { turn: 3, step: 7, done: false, currentAction: 'bash' },
      lastActive: 1700000000000,
    })
  })

  it('② 非终态超出信任窗口 ⇒ undefined（回落读盘，不假装新鲜）', () => {
    const service = makeService()
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    service.remember('child-2', { turn: 1, step: 2, done: false }, now)
    expect(service.snapshotOf('child-2')).toBeDefined()
    vi.spyOn(Date, 'now').mockReturnValue(now + SUBAGENT_PROGRESS_TRUST_MS + 1)
    expect(service.snapshotOf('child-2')).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('③ 终态是稳定事实 ⇒ 窗口过期后仍可用', () => {
    const service = makeService()
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    service.remember('child-3', { turn: 9, step: 40, done: true, stopReason: 'completed' }, now - 10 * SUBAGENT_PROGRESS_TRUST_MS)
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * SUBAGENT_PROGRESS_TRUST_MS)
    expect(service.snapshotOf('child-3')?.state.stopReason).toBe('completed')
    vi.restoreAllMocks()
  })

  it('④ clear 连伴随表一起清（清完不可再读出）', () => {
    const service = makeService()
    service.remember('child-4', { turn: 1, step: 1, done: true, stopReason: 'completed' }, 1)
    service.clear('child-4')
    expect(service.snapshotOf('child-4')).toBeUndefined()
  })

  it('④ 容量淘汰时伴随表一起清（否则随委派次数无上限增长 = 内存泄漏）', () => {
    const service = makeService()
    service.remember('oldest', { turn: 1, step: 1, done: true }, 1)
    for (let i = 0; i < SUBAGENT_PROGRESS_CAP; i += 1) {
      service.remember(`filler-${i}`, { turn: 1, step: 1, done: true }, 2)
    }
    // oldest 已被淘汰：既读不到，也不该留下 lastActive/foldedAt 残条。
    expect(service.snapshotOf('oldest')).toBeUndefined()
    expect(service.size).toBeLessThanOrEqual(SUBAGENT_PROGRESS_CAP)
  })
})
