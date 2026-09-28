/**
 * P1：脚本模式模型路由剥离（2026-09-27，用户裁定方案 A「剥离 + 告知」）。
 *
 * 运行时依据（不是检出）：引擎的 `SUPPORTED_AGENT_OPTIONS` 含 `provider`/`model`
 * （`@deepseek-ai/dsh-base@0.1.3-alpha.1` 的 `dsh-workflow-worker-thread/lib/worker.cjs`），
 * 而 `resolveChildAgentOptions` 的 `...requested` 在最后 ⇒ 不剥离就覆盖父路由。
 * 设计稿：`docs/PLAN-2026-09-27-script-mode-model-routing.md`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { corumRoutingIgnoredNoticeText, corumStripRoutingOptions } from '../src/routing-guard.ts'

const asOptions = (value: Record<string, unknown>): AgentOptions => value as unknown as AgentOptions

describe('corumStripRoutingOptions — 机制拥有路由', () => {
  it('未传选项：原样返回（不产生通知）', () => {
    expect(corumStripRoutingOptions(undefined)).toEqual({ options: undefined, ignored: undefined })
  })

  it('只有非路由选项：原样透传（同一引用），不产生通知', () => {
    const requested = asOptions({ label: 'a', phase: 'p', schema: { type: 'object' } })
    const result = corumStripRoutingOptions(requested)
    expect(result.options).toBe(requested)
    expect(result.ignored).toBeUndefined()
  })

  it('★ 传了 provider/model：被剥离，其余选项保留', () => {
    const result = corumStripRoutingOptions(asOptions({ provider: 'x', model: 'm', label: 'a' }))
    expect(result.ignored).toEqual({ provider: 'x', model: 'm' })
    expect(result.options).toEqual({ label: 'a' })
    expect(result.options).not.toHaveProperty('provider')
    expect(result.options).not.toHaveProperty('model')
  })

  it('★ 只传 model 且无其它选项：options 为 undefined（而不是空对象）', () => {
    const result = corumStripRoutingOptions(asOptions({ model: 'm' }))
    expect(result.ignored).toEqual({ model: 'm' })
    expect(result.options).toBeUndefined()
  })

  it('通知文本同时给出「你试了什么」与「实际跑了哪条」', () => {
    const text = corumRoutingIgnoredNoticeText({ model: 'm' }, { provider: 'p', model: 'real' })
    expect(text).toContain('were ignored')
    expect(text).toContain('model=m')
    expect(text).toContain('provider=p, model=real')
    expect(text).toContain('Do not pass')
  })
})

describe('driver 接线（防回潮）', () => {
  const DRIVER = readFileSync(join(import.meta.dirname, '../src/driver/index.ts'), 'utf8')

  it('★ create 调用必须用剥离后的选项（不得直接透传 request.agentOptions）', () => {
    expect(DRIVER).toContain('corumStripRoutingOptions(request.agentOptions)')
    expect(DRIVER).toContain('resolveChildAgentOptions(parent, routing.options, childDepth)')
    expect(DRIVER).not.toContain('resolveChildAgentOptions(parent, request.agentOptions, childDepth)')
  })

  it('剥离发生时注入机制通知（含 form: notice）', () => {
    expect(DRIVER).toContain("kind: 'mechanism-notice'")
    expect(DRIVER).toContain("form: 'notice'")
    expect(DRIVER).toContain('corumRoutingIgnoredNoticeText(')
  })
})
