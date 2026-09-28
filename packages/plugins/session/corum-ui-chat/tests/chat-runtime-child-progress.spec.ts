/**
 * `chatRuntime.childProgress` 契约（2026-09-28 卡顿修复 C3）。
 *
 * 背景（`docs/PENDING-ui-lag-multiround.md` §2.13）：卡片每次挂载（切会话 / 跳轮次）都拉一次进度基线，
 * 一轮动作实测 **128 次** `getChildSessionProgress`（~270 ms/次），而**终态是稳定事实**——同一批已结束的
 * 子会话被反复拉纯属重复劳动。
 *
 * 契约：① 终态结果共享缓存（重复调用不再打 RPC）；② **运行中不缓存**（必须实时）；
 * ③ 并发去重；④ 缓存过期后重打；⑤ 失败不缓存（下次仍重试）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { CHILD_PROGRESS_TERMINAL_TTL_MS, createChatRuntime } from '../src/client/chat-runtime.ts'

const terminal = { progress: { turn: 2, step: 9, done: true, stopReason: 'completed' } }
const running = { progress: { turn: 2, step: 3, done: false } }

const makeConnection = (calls: number[], value: unknown) => ({
  rpc: {
    call: async () => {
      calls.push(1)
      return { ok: true, value }
    },
  },
}) as unknown as ConnectionHandle

describe('chatRuntime.childProgress — 终态共享缓存', () => {
  it('① 终态结果：重复调用只打一次 RPC', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, terminal))
    expect(await runtime.childProgress('child-1')).toEqual(terminal)
    expect(await runtime.childProgress('child-1')).toEqual(terminal)
    expect(calls).toHaveLength(1)
  })

  it('② 运行中**不**缓存（必须实时）', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, running))
    await runtime.childProgress('child-2')
    await runtime.childProgress('child-2')
    expect(calls).toHaveLength(2)
  })

  it('③ 并发去重：同一子会话的并发调用只打一次', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, terminal))
    await Promise.all([runtime.childProgress('child-3'), runtime.childProgress('child-3'), runtime.childProgress('child-3')])
    expect(calls).toHaveLength(1)
  })

  it('④ 缓存过期 ⇒ 重新打一次', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, terminal))
    await runtime.childProgress('child-4')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + CHILD_PROGRESS_TERMINAL_TTL_MS + 1)
    await runtime.childProgress('child-4')
    expect(calls).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it('⑤ 失败不缓存（下次仍重试）；无连接 ⇒ undefined', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', {
      rpc: { call: async () => { calls.push(1); throw new Error('down') } },
    } as unknown as ConnectionHandle)
    expect(await runtime.childProgress('child-5')).toBeUndefined()
    expect(await runtime.childProgress('child-5')).toBeUndefined()
    expect(calls).toHaveLength(2)

    const bare = createChatRuntime()
    bare.setSession('s1', undefined)
    expect(await bare.childProgress('child-6')).toBeUndefined()
  })
})
