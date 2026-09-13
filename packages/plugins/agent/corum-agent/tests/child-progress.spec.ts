/**
 * 子 Agent 进度投影的纯判定（2026-09-13 抽出时补的单测）。
 *
 * 背景：这条判定此前长在 `agent-service.ts` 的 RPC 方法体里，没有任何单测能碰它——
 * 而 2026-09-12 那个把 8 张卡片全卡在 Running 的事故正是这条路径（`agents.list` 被
 * 当成可迭代属性用 → `getChildSessionProgress` 整体抛 `function is not iterable`
 * → 渲染层冷启动基线全废）。纯函数化 + 单测，就是不让同一个坑再无声复发。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { childRunInterruptOf } from '../src/child-progress.ts'

const BOOT = 1_700_000_000_000

describe('childRunInterruptOf — 「半途失去运行」的判据', () => {
  it('turn 已闭合（done）→ 不算中断，交给 stopReason 记账', () => {
    expect(childRunInterruptOf({
      done: true, stopReason: undefined, agentRunning: () => false, lastActive: BOOT - 1000, bootAt: BOOT,
    })).toBeUndefined()
  })

  it('有权威 stopReason → 不算中断（不覆盖权威原因）', () => {
    expect(childRunInterruptOf({
      done: false, stopReason: 'aborted', agentRunning: () => false, lastActive: BOOT - 1000, bootAt: BOOT,
    })).toBeUndefined()
  })

  it('registry 说它没在跑 → not-running（一次性子会话被 dispose 的那类）', () => {
    expect(childRunInterruptOf({
      done: false, stopReason: undefined, agentRunning: () => false, lastActive: BOOT + 1000, bootAt: BOOT,
    })).toBe('not-running')
  })

  it('最后事件发生在本进程启动之前 → pre-boot（常驻子会话不 dispose，判据 ① 对它无效）', () => {
    expect(childRunInterruptOf({
      done: false, stopReason: undefined, agentRunning: () => true, lastActive: BOOT - 1, bootAt: BOOT,
    })).toBe('pre-boot')
  })

  it('两个判据都不成立（真在跑）→ 不算中断', () => {
    expect(childRunInterruptOf({
      done: false, stopReason: undefined, agentRunning: () => true, lastActive: BOOT + 5000, bootAt: BOOT,
    })).toBeUndefined()
  })

  it('问不到 registry（没有 agents 服务）且事件在启动之后 → 不算中断（不猜）', () => {
    expect(childRunInterruptOf({
      done: false, stopReason: undefined, agentRunning: () => undefined, lastActive: BOOT + 5000, bootAt: BOOT,
    })).toBeUndefined()
  })

  it('registry 查询是惰性的：已由 done/stopReason 定局时不扫 agents', () => {
    const probe = vi.fn(() => false)
    childRunInterruptOf({ done: true, stopReason: undefined, agentRunning: probe, lastActive: 0, bootAt: BOOT })
    childRunInterruptOf({ done: false, stopReason: 'error', agentRunning: probe, lastActive: 0, bootAt: BOOT })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('宿主 RPC 的两处回归钉子（文本守卫，与 fork-drift §事件段对账同款）', () => {
  const source = readFileSync(new URL('../src/agent-service.ts', import.meta.url), 'utf8')

  it('迭代 agents registry 必须兼容「方法 / 可迭代属性」两种形态（2026-09-12 事故根因）', () => {
    // `agents.list` 是方法（list(): Agent[]）——直接 for...of 它会抛
    // `function is not iterable`，整条 RPC 挂掉、所有卡片永远 Running。
    expect(source).toContain('typeof raw === \'function\' ? raw() : raw')
  })

  it('辅助信息（角色/隔离/改动摘要）不得打挂主 RPC：关键取数处有 try/catch 兜底', () => {
    const guarded = source.match(/try \{/g)?.length ?? 0
    expect(guarded).toBeGreaterThan(20)
  })
})
