/**
 * 「同一父会话同一角色**只问一次**」的机制测试（2026-09-21 用户实测后定调）。
 *
 * ## 实机现场（为什么要有这条）
 *
 * 用户会话 `corum-task-1b927cf3` 的 step 27：主 Agent 在**同一条消息**里发了两个并行
 * `subagent` 调用（`:187` / `:188`）。配置的 `deepseek-v4.1-flash` 不可用 ⇒
 *
 * | seq | 事实 |
 * |---|---|
 * | 190 | 「Your Agent preset was updated permanently… now localhost/glm-5.3-flash」——第 1 个已答 |
 * | 191 | 「Subagent model unavailable (模型卡片纵向布局) … **No choice was made**」——第 2 个**又问了一遍** |
 *
 * 两个子 Agent 都在决定落地**之前**就用旧模型起跑 ⇒ 各自失败 ⇒ 用户被同一个根因连问两次。
 *
 * ## 断言什么
 *
 * ① 并发两次失败 ⇒ **只问一次**，两个调用方拿到**同一个**结果；
 * ② 决定落地后锁**即刻释放** ⇒ 之后新起的失败仍可以问（不是「一次会话只问一次」）；
 * ③ 键含**角色**（worker/research 写的是预设里不同的键，并成一次会答非所问）；
 * ④ 不同的父会话各问各的；
 * ⑤ 询问抛错时锁也要释放（否则一次异常把该会话永久锁死）。
 *
 * @module @corum/corum-tool-subagent/tests/model-ask-share
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  corumAskAboutModelOnce,
  corumResetModelAskLocks,
  type CorumDelegationPolicyState,
  type CorumModelAskChannel,
  type CorumModelAskOutcome,
} from '../src/model-ask-run.ts'
import type { CorumModelFailureFacts } from '../src/model-ask.ts'

afterEach(() => {
  corumResetModelAskLocks()
})

/** 一个只记账的 state 面（本文件不关心覆盖值，关心的是「问了几次」）。 */
function makeState(): CorumDelegationPolicyState {
  const overrides = new Map<string, unknown>()
  return {
    setModelOverride: (sessionId, route) => { overrides.set(sessionId, route) },
    clearModelOverride: (sessionId) => { overrides.delete(sessionId) },
    modelOverrideOf: (sessionId) => overrides.get(sessionId) as never,
  } as unknown as CorumDelegationPolicyState
}

/** 造一个父 Agent stub（只需要 `session.id`）。 */
function makeParent(sessionId: string): Agent {
  return { session: { id: sessionId }, ctx: {} } as unknown as Agent
}

/** 失败事实。 */
function makeFacts(role: 'worker' | 'research', label = '模型卡片纵向布局'): CorumModelFailureFacts {
  return {
    label,
    role,
    configured: { provider: 'localhost', model: 'deepseek-v4.1-flash' },
    fallback: { provider: 'localhost', model: 'kimi-k3-1' },
    cause: 'subagent run failed',
  } as CorumModelFailureFacts
}

/** 造一个只记账的提问通道：每次 `call` 计一次数，恒返回给定答案。 */
function channelThatAnswers(answer: { kind: string, route?: { provider: string, model: string } }): { channel: CorumModelAskChannel, count: () => number } {
  let n = 0
  return {
    channel: {
      call: async () => {
        n += 1
        return answer as never
      },
    },
    count: () => n,
  }
}

const silentLogger = { warn: () => {}, info: () => {} }

/** 跑一次 `corumAskAboutModelOnce`（普通 `temporary` 档，最省依赖）。 */
function ask(
  channel: CorumModelAskChannel,
  parent: Agent,
  facts: CorumModelFailureFacts,
): Promise<CorumModelAskOutcome> {
  return corumAskAboutModelOnce(
    { state: makeState(), channel },
    parent,
    facts,
    new AbortController().signal,
    silentLogger,
  )
}

describe('corumAskAboutModelOnce —— 同一父会话同一角色只问一次', () => {
  it('★ 并发两次失败 ⇒ 只问一次，且两个调用方拿到同一个决定', async () => {
    const { channel, count } = channelThatAnswers({ kind: 'temporary' })
    const parent = makeParent('corum-task-x')
    const facts = makeFacts('worker')

    const [a, b] = await Promise.all([ask(channel, parent, facts), ask(channel, parent, facts)])

    expect(count(), '实机缺陷形态：这里会是 2（连问两次）').toBe(1)
    expect(a).toBe(b) // 同一个结果对象 ⇒ 真的是共享，不是各自算了一遍
    expect(a.decision.kind).toBe('temporary')
    expect(a.override).toEqual({ provider: 'localhost', model: 'kimi-k3-1' })
  })

  it('★ 决定落地后锁释放：之后新起的失败仍会问（不是「一次会话只问一次」）', async () => {
    const { channel, count } = channelThatAnswers({ kind: 'temporary' })
    const parent = makeParent('corum-task-y')
    const facts = makeFacts('worker')

    await ask(channel, parent, facts)
    expect(count()).toBe(1)
    await ask(channel, parent, facts)
    expect(count(), '第二轮应当可以再问').toBe(2)
  })

  it('★ 角色不同 ⇒ 各问各的（worker / research 写的是预设里不同的键）', async () => {
    const { channel, count } = channelThatAnswers({ kind: 'temporary' })
    const parent = makeParent('corum-task-z')
    await Promise.all([
      ask(channel, parent, makeFacts('worker')),
      ask(channel, parent, makeFacts('research')),
    ])
    expect(count()).toBe(2)
  })

  it('不同父会话 ⇒ 各问各的', async () => {
    const { channel, count } = channelThatAnswers({ kind: 'temporary' })
    await Promise.all([
      ask(channel, makeParent('sess-1'), makeFacts('worker')),
      ask(channel, makeParent('sess-2'), makeFacts('worker')),
    ])
    expect(count()).toBe(2)
  })

  it('★ 询问抛错也要释放锁（否则一次异常把该会话永久锁死）', async () => {
    let calls = 0
    const channel: CorumModelAskChannel = {
      call: async () => {
        calls += 1
        throw new Error('channel down')
      },
    }
    const parent = makeParent('corum-task-w')
    const facts = makeFacts('worker')

    const first = await ask(channel, parent, facts)
    // 通道抛错 ⇒ 机制降级为「没作答」，不抛给调用方（见 corumAskAboutModelFailure 的 catch）
    expect(first.decision.kind).toBe('dismissed')
    expect(calls).toBe(1)

    await ask(channel, parent, facts)
    expect(calls, '锁未释放 ⇒ 这里仍是 1，该会话被永久锁死').toBe(2)
  })

  it('三连并发也只问一次', async () => {
    const { channel, count } = channelThatAnswers({ kind: 'permanent-follow' })
    const parent = makeParent('corum-task-v')
    const facts = makeFacts('worker')
    const all = await Promise.all([ask(channel, parent, facts), ask(channel, parent, facts), ask(channel, parent, facts)])
    expect(count()).toBe(1)
    expect(all[0]).toBe(all[2])
  })

  it('没有通道（headless）时共享也成立：只告警一次', async () => {
    const parent = makeParent('corum-task-u')
    const facts = makeFacts('worker')
    const warn = vi.fn()
    const deps = { state: makeState(), channel: undefined as CorumModelAskChannel | undefined }
    const [a, b] = await Promise.all([
      corumAskAboutModelOnce(deps, parent, facts, new AbortController().signal, { warn }),
      corumAskAboutModelOnce(deps, parent, facts, new AbortController().signal, { warn }),
    ])
    expect(a.decision.kind).toBe('dismissed')
    expect(b.decision.kind).toBe('dismissed')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
