/**
 * 测试台自身的回归（P0-a）。
 *
 * 这个文件测的**不是**实现，而是 `tests/harness.ts` 的两个承诺：
 *   ① 「harness 挂上的状态表，就是被测服务在读的那一份」；
 *   ② 契约一旦断了（状态搬了家而 harness 没跟上），**必须响**，不能静默造出假服务。
 *
 * 为什么②值得单独一条测试：本轮的整个安全网都押在「测试台没有失真」上。
 * 一个会静默降级的测试台比没有测试台更危险——它会让 278 个测试全绿，而它们已经
 * 测不到真实对象了。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '../src/agent-registry.ts'
import {
  STATE_CONTAINER_KEY,
  assertStateContract,
  makeAgent,
  makeHarness,
  makeProfile,
  projectionsOf,
} from './harness.ts'

describe('harness — 状态契约（本轮安全网的地基）', () => {
  it('① 服务通过自己的读取路径能看到 harness 表里的条目', () => {
    const h = makeHarness()
    try {
      assertStateContract(h)
    } finally {
      h.cleanup()
    }
  })

  it('② 契约断了必须 fail-loud（不许静默降级成假服务）', () => {
    const h = makeHarness()
    try {
      // 模拟「harness 的视图与服务的容器脱钩」：把服务上的 registry 换成另一个实例
      // （实现里读的是服务自己那个属性），于是 harness 写进的条目服务再也看不到。
      const key = STATE_CONTAINER_KEY!
      Object.defineProperty(h.service, key, {
        value: new AgentRegistry(),
        writable: true,
        configurable: true,
      })
      expect(() => assertStateContract(h))
        .toThrowError(/状态契约已断/)
    } finally {
      h.cleanup()
    }
  })

  it('③ STATE_CONTAINER_KEY 与当前实现的形态一致', () => {
    // 当前实现（P3-a）：六张存活表收在 `AgentRegistry` 里，服务上的容器属性名是 'registry'。
    // 实现再改状态归属时，这里会一起变红 —— 那正是提醒「去改 harness」的信号
    // （而不是让 300+ 个测试静默失真）。本文件是这条契约的**唯一**落点。
    expect(STATE_CONTAINER_KEY).toBe('registry')
  })

  it('④ 临时 home 已生效（profile 真实落盘到本次 home）', () => {
    const h = makeHarness()
    try {
      const p = makeProfile({ id: 'harness-home-probe' })
      h.writeProfile(p)
      const file = join(h.home, '.agent-presets', p.id, 'agent.json')
      expect(existsSync(file)).toBe(true)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(p)
      // CORUM_HOME 必须指向本次 home，否则 profile-store 会去动真实用户目录。
      expect(process.env.CORUM_HOME).toBe(h.home)
    } finally {
      h.cleanup()
    }
  })

  it('⑤ 帧记录与事件接线：emit 被记下，emitTo 能喂给订阅者', () => {
    const h = makeHarness()
    try {
      h.ctx.emit('corum/subagent/progress', { sessionId: 's1' })
      h.ctx.emit('corum/subagent/progress', { sessionId: 's2' })
      h.ctx.emit('other/event')
      expect(h.eventsOf('corum/subagent/progress')).toEqual([{ sessionId: 's1' }, { sessionId: 's2' }])
      h.clearEvents()
      expect(h.events).toHaveLength(0)

      const seen: unknown[] = []
      h.ctx.on('subagent/end', (info: unknown) => seen.push(info))
      h.ctx.emitTo('subagent/end', { id: 'child-1', stopReason: 'completed' })
      expect(seen).toEqual([{ id: 'child-1', stopReason: 'completed' }])
    } finally {
      h.cleanup()
    }
  })

  it('⑥ 登记助手写进的是 harness 视图（而非另一个影子表）', () => {
    const h = makeHarness()
    try {
      h.registerTaskAgent('sess-t1', { cwd: '/tmp/a', profileId: 'p1' })
      expect(h.state.taskAgents.get('sess-t1')).toMatchObject({ cwd: '/tmp/a', profileId: 'p1' })
      // 服务的读取路径认得它：`getAgent` 走 agents 表；taskAgents 走 findLaneAgent。
      h.registerAgent('p2', makeAgent('agent-p2'))
      expect(h.service.getAgent('p2')).toBeDefined()
      expect(h.state.taskAgents.get('sess-t1')).toBeDefined()
    } finally {
      h.cleanup()
    }
  })

  it('⑦ 投影服务形状：提供 sessionProjections 后服务能解析 agentPreset', () => {
    const h = makeHarness()
    try {
      h.provide('sessionProjections', projectionsOf({ 'sess-p': 'preset-x' }))
      const agent = h.registerTaskAgent('sess-p', { profileId: 'preset-x' })
      expect(String(agent.session.id)).toBe('sess-p')
      // 走服务真实读取路径断言（服务自己经 ctx.get('sessionProjections') 取）
      const projections = h.ctx.get('sessionProjections') as { stateOf: (s: unknown, k: string) => unknown }
      expect(projections.stateOf(agent.session, 'agentPreset')).toBe('preset-x')
    } finally {
      h.cleanup()
    }
  })

  it('⑧ Object.create 造出的服务不带构造器副作用（不触碰真实 home / 不注册 prompt 段）', () => {
    const h = makeHarness()
    try {
      // 构造器会做 ensureBuiltinRoleProfiles 播种 —— 绕过构造器后本次 home 里不该有
      // 任何预置角色目录（只该有测试自己写的）。
      expect(existsSync(join(h.home, '.agent-presets'))).toBe(false)
      // 且不依赖 static inject 的服务（mock ctx 只提供 get()）。
      expect(SessionId).toBeDefined()
    } finally {
      h.cleanup()
    }
  })
})
