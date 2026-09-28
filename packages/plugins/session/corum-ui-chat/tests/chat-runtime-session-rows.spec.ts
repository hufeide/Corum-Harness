/**
 * `chatRuntime.sessionRows` 的服务契约（2026-09-27 卡顿修复 B）。
 *
 * 背景（打包态实测，`docs/PENDING-ui-lag-multiround.md` §2.10）：`session/list` 在打包态返回
 * **651 KB / 1.3 s**，而 `SubagentCard` / `OrchestrateCard` 原先**各自**在挂载时调一次
 * ⇒ 47 轮会话 30+ 张卡片 = 同一份列表被拉几十次，主线程被大 payload 解析占满。
 *
 * 本文件锁住共享读取的三条契约：
 *   ① **并发去重**：同一批卡片的并发调用只打一次 RPC（in-flight 复用）；
 *   ② **TTL 缓存**：窗口内重复调用不再打；窗口外重打一次（拿到新数据）；
 *   ③ **失败不缓存**：失败返回 `undefined` 且不留缓存（下次仍会重试，不把错误固化成"空列表"）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { createChatRuntime, SESSION_ROWS_TTL_MS } from '../src/client/chat-runtime.ts'

interface StubOptions {
  readonly items?: readonly unknown[]
  readonly ok?: boolean
  readonly throwError?: boolean
}

const makeConnection = (calls: number[], options: StubOptions = {}) => ({
  rpc: {
    call: async () => {
      calls.push(1)
      if (options.throwError === true) throw new Error('rpc down')
      if (options.ok === false) return { ok: false }
      return { ok: true, value: { items: options.items ?? [] } }
    },
  },
}) as unknown as ConnectionHandle

describe('chatRuntime.sessionRows — 共享读取契约', () => {
  it('① 并发去重：10 个并发调用只打一次 RPC', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, { items: [{ sessionId: 'a' }] }))
    const results = await Promise.all(Array.from({ length: 10 }, () => runtime.sessionRows()))
    expect(calls).toHaveLength(1)
    for (const rows of results) expect(rows?.[0]?.sessionId).toBe('a')
    // ② 窗口内再调仍不再打。
    expect((await runtime.sessionRows())?.[0]?.sessionId).toBe('a')
    expect(calls).toHaveLength(1)
  })

  it('② 超出 TTL ⇒ 同一个实例会重新打一次', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, { items: [{ sessionId: 'old' }] }))
    expect((await runtime.sessionRows())?.[0]?.sessionId).toBe('old')
    expect(calls).toHaveLength(1)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + SESSION_ROWS_TTL_MS + 1)
    expect((await runtime.sessionRows())?.[0]?.sessionId).toBe('old')
    expect(calls).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it('③ 失败返回 undefined 且**不缓存**（下次仍重试，不把错误固化成空列表）', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, { throwError: true }))
    expect(await runtime.sessionRows()).toBeUndefined()
    expect(calls).toHaveLength(1)
    // 第二次仍会真的再打（说明第一次没有留下缓存）。
    expect(await runtime.sessionRows()).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('③ rpc 返回 ok:false 同样不缓存', async () => {
    const calls: number[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, { ok: false }))
    expect(await runtime.sessionRows()).toBeUndefined()
    expect(await runtime.sessionRows()).toBeUndefined()
    expect(calls).toHaveLength(2)
  })

  it('无连接 ⇒ undefined（不抛）', async () => {
    const runtime = createChatRuntime()
    runtime.setSession('s1', undefined)
    expect(await runtime.sessionRows()).toBeUndefined()
  })
})
