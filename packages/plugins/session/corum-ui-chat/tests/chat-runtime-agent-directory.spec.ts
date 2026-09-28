/**
 * `chatRuntime.agentDirectory` 契约（2026-09-28 卡顿修复 E1）。
 *
 * 背景（打包态实测，`docs/PENDING-ui-lag-multiround.md` §2.23）：`apply.ts` 的 `getAgentName` 回调每被消费
 * 一次就发 `listTaskAgents` + `listProfiles` **两个** RPC；一次「打开重会话」实测各打 **6 次**
 * （≈2.1 s 主机工作），而这两份数据在一次交互里根本不变。
 *
 * 契约：① 并发去重；② TTL 内复用；③ 过期重取；④ 形状正确（task→profileId、profileId→显示名，
 * nickname 优先其次 title）；⑤ 失败给空表且**不缓存**（下次仍重试）。
 */
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { AGENT_DIRECTORY_TTL_MS, createChatRuntime } from '../src/client/chat-runtime.ts'

const makeConnection = (calls: string[], options: { readonly failTasks?: boolean } = {}) => ({
  rpc: {
    call: async (_svc: string, method: string) => {
      calls.push(method)
      if (method.endsWith('listTaskAgents')) {
        if (options.failTasks === true) throw new Error('down')
        return { ok: true, value: { tasks: [{ sessionId: 'corum-task-1', profileId: 'p1' }] } }
      }
      return { ok: true, value: { profiles: [{ id: 'p1', title: '标题名', nickname: '昵称' }, { id: 'p2', title: '第二个' }] } }
    },
  },
}) as unknown as ConnectionHandle

describe('chatRuntime.agentDirectory — 共享目录快照', () => {
  it('① 并发去重 + ② TTL 内复用：多次调用只打两个 RPC（各一次）', async () => {
    const calls: string[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls))
    const results = await Promise.all(Array.from({ length: 6 }, () => runtime.agentDirectory()))
    expect(calls.filter(c => c.endsWith('listTaskAgents'))).toHaveLength(1)
    expect(calls.filter(c => c.endsWith('listProfiles'))).toHaveLength(1)
    for (const dir of results) expect(dir.taskProfiles.get('corum-task-1')).toBe('p1')
    await runtime.agentDirectory()
    expect(calls).toHaveLength(2)
  })

  it('④ 形状正确：nickname 优先，其次 title', async () => {
    const calls: string[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls))
    const dir = await runtime.agentDirectory()
    expect(dir.profileNames.get('p1')).toBe('昵称')
    expect(dir.profileNames.get('p2')).toBe('第二个')
  })

  it('③ 过期 ⇒ 重新打一次', async () => {
    const calls: string[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls))
    await runtime.agentDirectory()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + AGENT_DIRECTORY_TTL_MS + 1)
    await runtime.agentDirectory()
    expect(calls.filter(c => c.endsWith('listTaskAgents'))).toHaveLength(2)
    vi.restoreAllMocks()
  })

  it('⑤ 失败 ⇒ 空表且不缓存（下次仍重试）；无连接 ⇒ 空表', async () => {
    const calls: string[] = []
    const runtime = createChatRuntime()
    runtime.setSession('s1', makeConnection(calls, { failTasks: true }))
    const first = await runtime.agentDirectory()
    expect(first.taskProfiles.size).toBe(0)
    await runtime.agentDirectory()
    expect(calls.filter(c => c.endsWith('listTaskAgents')).length).toBeGreaterThanOrEqual(2)

    const bare = createChatRuntime()
    bare.setSession('s1', undefined)
    expect((await bare.agentDirectory()).profileNames.size).toBe(0)
  })
})
