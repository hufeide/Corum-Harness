/**
 * `installTaskModelSelection` 的**幂等性**回归（2026-09-21 实机缺陷）。
 *
 * ## 缺陷现场
 *
 * 用户主实例会话 `corum-task-1b927cf3`：组装出的 system prompt 里视觉能力段
 * （「You can see images in this conversation…」）**逐字节重复两遍**。
 *
 * 根因链：`system-prompt/assemble` 是 cordis **waterfall** —— 每层
 * `await next()` 拿到**外层已完成**的装配，再各自 append 一次视觉段。而
 * `installTaskModelSelection` 在同一个 agentCtx 上被装了两次：
 *   ① 建会话时按 `corum-dev` 装一层；
 *   ② 用户切 preset 到 `conductor-lead` 走 `selectTaskAgentProfileRemote` 的 fallback
 *      分支（进程重启后内存登记丢失）又装一层。
 * 本函数返回 disposer，但**4 个调用点全部丢弃** ⇒ 重装 = 多留一层永不撤销的旧监听。
 *
 * ## 这个文件在钉什么
 *
 * 用**模拟 waterfall** 跑真实语义：装 N 次后触发一次组装，断言
 *   ① 视觉段只出现一次；
 *   ② 生效的模型是**最后**装的那一个（重装即替换）；
 *   ③ 旧层的 `agent/request` 强制绑定不再生效（不再有陈旧 selection 抢绑定）。
 *
 * 反证：把 `installTaskModelSelection` 开头那句「重装前先撤销上一次」删掉，本文件变红。
 *
 * @module @corum/corum-agent/tests/task-model-selection
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installTaskModelSelection } from '../src/task-model-selection.ts'
import { VISION_CAPABILITY } from '../src/vision.ts'

/** 模拟 cordis 的两个 hook 点（只实现本文件用到的语义）。 */
interface FakeCtx {
  /** `system-prompt/assemble` 的监听器（waterfall 顺序执行）。 */
  assembleHandlers: Array<(assembly: unknown, ctx: unknown, next: () => Promise<Assembly>) => Promise<Assembly>>
  /** `agent/request` 的监听器（waterfall）。 */
  requestHandlers: Array<(payload: unknown, next: () => Promise<LlmConfig>) => Promise<LlmConfig>>
  /** 供 `supportsImageModel` 读的视觉能力（显式声明含 image ⇒ 会注入视觉段）。 */
  llm: { resolveModelInfo: () => Promise<{ inputModalities: string[] }> }
  on: (event: string, handler: unknown) => () => void
}

interface Assembly {
  sections: Array<{ name: string, text: string }>
  variables: Record<string, unknown>
}

interface LlmConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 造一个假的 agentCtx（`on` 按事件名收进两个数组，返回真实可用的 disposer）。 */
function makeFakeCtx(): FakeCtx {
  const ctx: Partial<FakeCtx> & { assembleHandlers: FakeCtx['assembleHandlers'], requestHandlers: FakeCtx['requestHandlers'] } = {
    assembleHandlers: [],
    requestHandlers: [],
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
  }
  ctx.on = (event: string, handler: unknown): (() => void) => {
    if (event === 'system-prompt/assemble') {
      const h = handler as FakeCtx['assembleHandlers'][number]
      ctx.assembleHandlers.push(h)
      return () => {
        const i = ctx.assembleHandlers.indexOf(h)
        if (i >= 0) ctx.assembleHandlers.splice(i, 1)
      }
    }
    if (event === 'agent/request') {
      const h = handler as FakeCtx['requestHandlers'][number]
      ctx.requestHandlers.push(h)
      return () => {
        const i = ctx.requestHandlers.indexOf(h)
        if (i >= 0) ctx.requestHandlers.splice(i, 1)
      }
    }
    return () => {}
  }
  return ctx as FakeCtx
}

/** 按 cordis waterfall 语义跑一遍 `system-prompt/assemble`。 */
async function runAssemble(ctx: FakeCtx): Promise<Assembly> {
  const base: Assembly = { sections: [], variables: {} }
  let index = -1
  const next = async (): Promise<Assembly> => {
    index++
    const handler = ctx.assembleHandlers[index]
    if (handler === undefined) return base
    return handler(undefined, undefined, next)
  }
  return next()
}

/** 按 cordis waterfall 语义跑一遍 `agent/request`。 */
async function runRequest(ctx: FakeCtx, base: LlmConfig): Promise<LlmConfig> {
  let index = -1
  const next = async (): Promise<LlmConfig> => {
    index++
    const handler = ctx.requestHandlers[index]
    if (handler === undefined) return base
    return handler(undefined, next)
  }
  return next()
}

const VISION = (a: Assembly): number =>
  a.sections.filter(s => s.text === VISION_CAPABILITY).length

describe('installTaskModelSelection —— 重装即替换（不重复 append 视觉段）', () => {
  it('① 装一次：视觉段出现一次、变量是本层模型', async () => {
    const ctx = makeFakeCtx()
    installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'p1', model: 'm1' }, assembled: undefined })
    const a = await runAssemble(ctx)
    expect(VISION(a)).toBe(1)
    expect(a.variables).toMatchObject({ provider: 'p1', model: 'm1' })
  })

  it('★ 同一 ctx 装两次（实机缺陷形态）：视觉段仍只出现一次', async () => {
    const ctx = makeFakeCtx()
    installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'corum-dev', model: 'dev-model' }, assembled: undefined })
    // 用户切 preset → fallback 分支再装一层（历史缺陷点：agent-service 的 fallback 分支）
    installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'conductor-lead', model: 'kimi-k3-1' }, assembled: undefined })

    expect(ctx.assembleHandlers).toHaveLength(1)
    const a = await runAssemble(ctx)
    expect(VISION(a)).toBe(1)
  })

  it('★ 重装后生效的是**最后**装的那一个模型（替换语义）', async () => {
    const ctx = makeFakeCtx()
    installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'corum-dev', model: 'dev-model' }, assembled: undefined })
    installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'conductor-lead', model: 'kimi-k3-1' }, assembled: undefined })

    const a = await runAssemble(ctx)
    expect(a.variables).toMatchObject({ provider: 'conductor-lead', model: 'kimi-k3-1' })
    const cfg = await runRequest(ctx, { provider: 'deployment-default', model: 'whatever' })
    expect(cfg).toMatchObject({ provider: 'conductor-lead', model: 'kimi-k3-1' })
    expect(ctx.requestHandlers).toHaveLength(1)
  })

  it('装三次也一样（幂等，不是「装两次特例」）', async () => {
    const ctx = makeFakeCtx()
    for (const m of ['a', 'b', 'c']) {
      installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'p', model: m }, assembled: undefined })
    }
    expect(ctx.assembleHandlers).toHaveLength(1)
    expect(ctx.requestHandlers).toHaveLength(1)
    const a = await runAssemble(ctx)
    expect(VISION(a)).toBe(1)
    expect(a.variables).toMatchObject({ model: 'c' })
  })

  it('不同 ctx 各自独立（幂等表按 ctx 记账，不互相撤销）', async () => {
    const a = makeFakeCtx()
    const b = makeFakeCtx()
    installTaskModelSelection(a as unknown as Context, { current: { provider: 'p', model: 'ma' }, assembled: undefined })
    installTaskModelSelection(b as unknown as Context, { current: { provider: 'p', model: 'mb' }, assembled: undefined })
    expect(a.assembleHandlers).toHaveLength(1)
    expect(b.assembleHandlers).toHaveLength(1)
    expect((await runAssemble(a)).variables).toMatchObject({ model: 'ma' })
    expect((await runAssemble(b)).variables).toMatchObject({ model: 'mb' })
  })

  it('返回值仍是可用的 disposer：调用后不再注入', async () => {
    const ctx = makeFakeCtx()
    const dispose = installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'p', model: 'm' }, assembled: undefined })
    expect(ctx.assembleHandlers).toHaveLength(1)
    dispose()
    expect(ctx.assembleHandlers).toHaveLength(0)
    expect(ctx.requestHandlers).toHaveLength(0)
    expect(VISION(await runAssemble(ctx))).toBe(0)
  })

  it('模型不支持视觉 ⇒ 不注入该段（能力判定仍生效）', async () => {
    const ctx = makeFakeCtx()
    ctx.llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
    installTaskModelSelection(ctx as unknown as Context, { current: { provider: 'p', model: 'text-only' }, assembled: undefined })
    const a = await runAssemble(ctx)
    expect(VISION(a)).toBe(0)
    // 变量仍要写上（模型绑定与视觉能力是两件事）
    expect(a.variables).toMatchObject({ provider: 'p', model: 'text-only' })
  })
})
