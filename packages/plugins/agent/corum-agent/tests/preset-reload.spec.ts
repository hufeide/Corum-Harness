/**
 * fork（corum）2026-09-27：**在跑的 Agent 就地重挂 preset 组合**（用户需求「会话中改了 MCP
 * 就该实时生效，不要重启软件」）。
 *
 * 本文件钉两件事：
 *  ① `AgentRegistry.liveAgentsOfProfile` —— 重挂必须点名**哪些**会话（root + task 泳道，
 *     去重；项目制泳道不在列，其键无法反解 profileId）；
 *  ② `preset-reload.ts` 的**能力接口 + 特性检测**语义：拿不到官方 `recompose` 时保持既有行为
 *     （返回 false，绝不假装成功）；调用失败只进 warn、不抛（保存 profile 是用户操作）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '../src/agent-registry.ts'
import { agentPresetReloadFace, reloadAgentPreset } from '../src/preset-reload.ts'

/** 造一个只用作身份占位的假 Agent（注册表只做 Map 存取，不解引用）。 */
function fakeAgent(id: string): { id: string; ctx: Context } {
  return { id, ctx: new Context() }
}

function fakeSessionId(id: string): string {
  return id
}

describe('AgentRegistry.liveAgentsOfProfile — 重挂点名面（2026-09-27）', () => {
  it('root Agent 与 task 泳道都会被点名；无关 profile 不出现', () => {
    const registry = new AgentRegistry()
    const root = fakeAgent('root-1')
    const taskA = fakeAgent('task-a')
    const taskB = fakeAgent('task-b')
    const other = fakeAgent('other')
    registry.registerProfileAgent('p1', root as never)
    registry.registerTask({ agent: taskA as never, sessionId: fakeSessionId('s-a') as never, cwd: '/tmp/a', profileId: 'p1' })
    registry.registerTask({ agent: taskB as never, sessionId: fakeSessionId('s-b') as never, cwd: '/tmp/b', profileId: 'p1' })
    registry.registerTask({ agent: other as never, sessionId: fakeSessionId('s-c') as never, cwd: '/tmp/c', profileId: 'p2' })
    const live = registry.liveAgentsOfProfile('p1')
    expect(live).toHaveLength(3)
    expect(live.map(a => (a as unknown as { id: string }).id).sort()).toEqual(['root-1', 'task-a', 'task-b'])
  })

  it('同一个 Agent 同时出现在 root 与 task 表时只出一次（去重）', () => {
    const registry = new AgentRegistry()
    const same = fakeAgent('same')
    registry.registerProfileAgent('p1', same as never)
    registry.registerTask({ agent: same as never, sessionId: fakeSessionId('s') as never, cwd: '/tmp', profileId: 'p1' })
    expect(registry.liveAgentsOfProfile('p1')).toHaveLength(1)
  })

  it('没有活会话 ⇒ 空数组（保存 profile 时不产生任何重挂动作）', () => {
    const registry = new AgentRegistry()
    expect(registry.liveAgentsOfProfile('p1')).toEqual([])
  })
})

describe('preset-reload — 能力接口 + 特性检测（2026-09-27）', () => {
  it('服务缺失 / 没有 recompose ⇒ face 为 undefined（老宿主保持既有行为）', () => {
    expect(agentPresetReloadFace({ get: () => undefined } as never)).toBeUndefined()
    expect(agentPresetReloadFace({ get: () => ({}) } as never)).toBeUndefined()
    expect(agentPresetReloadFace({ get: () => ({ recompose: 'not-a-function' }) } as never)).toBeUndefined()
  })

  it('有 recompose ⇒ 取到能力面', () => {
    const recompose = async (): Promise<void> => {}
    expect(agentPresetReloadFace({ get: () => ({ recompose }) } as never)?.recompose).toBe(recompose)
  })

  it('★ 能力可用：以 (agentCtx, presetId) 调用一次，返回 true', async () => {
    const calls: unknown[][] = []
    const agentCtx = new Context()
    const ctx = { get: () => ({ recompose: async (...args: unknown[]) => { calls.push(args) } }) }
    const ok = await reloadAgentPreset(ctx as never, agentCtx, 'conductor-lead', () => {})
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(agentCtx)
    expect(calls[0][1]).toBe('conductor-lead')
  })

  it('★ 能力不可用：不调用、返回 false（绝不假装成功）', async () => {
    let called = false
    const ctx = { get: () => ({ recompose: undefined, marker: () => { called = true } }) }
    expect(await reloadAgentPreset(ctx as never, new Context(), 'p', () => {})).toBe(false)
    expect(called).toBe(false)
  })

  it('★ 旧常驻挂载存在：**先销毁、再重挂**（防 MCP server 进程泄漏，2026-09-27 实测）', async () => {
    const order: string[] = []
    // ⚠️ 服务对象只造一次：`ctx.get` 每次返回新对象的话，被测代码删的 Map 与断言看的 Map 不是同一个
    // （首版本用例就是这么写错的，实测红）。
    const service = {
      standing: new Map([['conductor-lead', Promise.resolve({ scope: { dispose: async () => { order.push('dispose-old') } } })]]),
      recompose: async () => { order.push('recompose') },
    }
    const ctx = { get: () => service }
    const ok = await reloadAgentPreset(ctx as never, new Context(), 'conductor-lead', () => {})
    expect(ok).toBe(true)
    expect(order).toEqual(['dispose-old', 'recompose'])
    // 销毁后必须把表项删掉：否则官方 ensureStanding 会认为旧挂载还在、拿指纹相同就复用旧 scope。
    expect(service.standing.has('conductor-lead')).toBe(false)
  })

  it('没有旧常驻挂载 ⇒ 不销毁任何东西，照常重挂', async () => {
    const order: string[] = []
    const service = { standing: new Map<string, Promise<{ scope?: { dispose?: () => Promise<unknown> } }>>(), recompose: async () => { order.push('recompose') } }
    const ctx = { get: () => service }
    expect(await reloadAgentPreset(ctx as never, new Context(), 'p', () => {})).toBe(true)
    expect(order).toEqual(['recompose'])
  })

  it('★ 销毁失败：只进 warn，仍然继续重挂（尽力而为，不阻断）', async () => {
    const warns: string[] = []
    let recomposed = false
    const service = {
      standing: new Map([['p', Promise.resolve({ scope: { dispose: async () => { throw new Error('busy') } } })]]),
      recompose: async () => { recomposed = true },
    }
    const ctx = { get: () => service }
    expect(await reloadAgentPreset(ctx as never, new Context(), 'p', m => warns.push(m))).toBe(true)
    expect(recomposed).toBe(true)
    expect(warns.join(' ')).toContain('busy')
  })

  it('★ 重挂抛错：不抛给调用方，进 warn 通道，返回 false', async () => {
    const warns: string[] = []
    const ctx = { get: () => ({ recompose: async () => { throw new Error('mount failed') } }) }
    const ok = await reloadAgentPreset(ctx as never, new Context(), 'p1', message => warns.push(message))
    expect(ok).toBe(false)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('mount failed')
    expect(warns[0]).toContain('p1')
  })
})
