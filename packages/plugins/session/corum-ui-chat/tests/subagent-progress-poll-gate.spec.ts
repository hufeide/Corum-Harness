/**
 * `shouldFallbackPoll` 契约（2026-09-28 卡顿修复 C1）。
 *
 * 背景（`docs/PENDING-ui-lag-multiround.md` §2.12 实测）：推送只在**进度变化**时发帧 ⇒ 已结束的子会话
 * 永远零帧 ⇒ 每张卡都回退 2s 轮询，一轮动作打 **132 次** `getChildSessionProgress`，主机被逐卡轮询占满。
 * 终态是稳定事实 ⇒ 不该再轮询。本文件钉住这条判据，防止有人「顺手」把它改回无条件轮询。
 */
import { describe, expect, it } from 'vitest'
import { shouldFallbackPoll } from '../src/client/chat/SubagentCard.tsx'

describe('shouldFallbackPoll', () => {
  it('还没拿到基线 ⇒ 该拉（undefined 不是终态）', () => {
    expect(shouldFallbackPoll(undefined)).toBe(true)
  })

  it('仍在跑（done=false 且无 stopReason）⇒ 继续轮询到结束', () => {
    expect(shouldFallbackPoll({ turn: 1, step: 3, done: false })).toBe(true)
    expect(shouldFallbackPoll({ turn: 1, step: 3, done: false, currentAction: 'bash' })).toBe(true)
  })

  it('★ 终态（done=true）⇒ 不再轮询（卡顿主因的判据）', () => {
    expect(shouldFallbackPoll({ turn: 2, step: 9, done: true })).toBe(false)
    expect(shouldFallbackPoll({ turn: 2, step: 9, done: true, stopReason: 'completed' })).toBe(false)
    expect(shouldFallbackPoll({ turn: 2, step: 9, done: true, interrupted: true })).toBe(false)
  })

  it('★ 有 stopReason（终态的不同表达）⇒ 不再轮询', () => {
    expect(shouldFallbackPoll({ turn: 2, step: 9, done: false, stopReason: 'aborted' })).toBe(false)
  })
})
