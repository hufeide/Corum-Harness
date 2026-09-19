import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { childPersonaOf, narrowChildToolFilter, resolveChildAgentOptions } from '../src/child-agent.ts'

function parentAgent(): Agent {
  const id = SessionId('parent')
  return {
    id,
    options: {
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 512,
    },
    session: Session.create(id),
  } as Agent
}

describe('child Agent options', () => {
  it('inherits the parent effort while the exact route is unchanged', () => {
    expect(resolveChildAgentOptions(parentAgent(), undefined, 1)).toEqual({
      provider: 'parent-provider',
      model: 'parent-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('clears an inherited effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), { model: 'child-model' }, 1)).toEqual({
      provider: 'parent-provider',
      model: 'child-model',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('keeps an explicit child effort when the child route changes', () => {
    expect(resolveChildAgentOptions(parentAgent(), {
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: ReasoningEffortId('max'),
    }, 1)).toEqual({
      provider: 'child-provider',
      model: 'child-model',
      reasoningEffort: 'max',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })

  it('inherits the latest logged request selection over creation-time values', () => {
    const parent = parentAgent()
    parent.session.append('request/header', {
      header: {
        config: {
          provider: 'current-provider',
          model: 'current-model',
          reasoningEffort: ReasoningEffortId('low'),
        },
      },
      reason: 'initial',
    })

    expect(resolveChildAgentOptions(parent, undefined, 1)).toEqual({
      provider: 'current-provider',
      model: 'current-model',
      reasoningEffort: 'low',
      maxTokens: 512,
      subagentDepth: 1,
    })
  })
})

describe('narrowChildToolFilter（2026-09-12 事故回归）', () => {
  /** 用可见工具名集合造一个最小 ctx 桩：只用到 ctx.tools.schemas(scopeOf(ctx))。 */
  const ctxStub = (names: readonly string[]): never => ({
    tools: { schemas: () => names.map(name => ({ name })) },
  }) as never

  it('丢弃未装载的名字（str_replace_editor 退场后不得再炸整次派遣）', () => {
    const out = narrowChildToolFilter(
      ctxStub(['read', 'write', 'edit', 'bash']),
      { deny: ['str_replace_editor', 'write', 'edit', 'bash'] },
    )
    expect(out).toEqual({ deny: ['write', 'edit', 'bash'] })
  })

  it('MCP 服务名展开成该服务实际可见的工具名（只读实例必须 deny 掉 pencil 的写能力）', () => {
    const out = narrowChildToolFilter(
      ctxStub(['read', 'mcp__pencil-mcp__execute', 'mcp__pencil-mcp__get_app_state']),
      { deny: ['pencil-mcp'] },
    )
    expect(out).toEqual({ deny: ['mcp__pencil-mcp__execute', 'mcp__pencil-mcp__get_app_state'] })
  })

  it('不可见的 MCP 服务名被丢弃（该 profile 没授权它）', () => {
    expect(narrowChildToolFilter(ctxStub(['read']), { deny: ['pencil-mcp'] })).toBeUndefined()
  })

  it('allow 同样按可见面收敛，全空时返回 undefined（不空 restrict）', () => {
    expect(narrowChildToolFilter(ctxStub(['read']), { allow: ['read', 'nope'] })).toEqual({ allow: ['read'] })
    expect(narrowChildToolFilter(ctxStub(['read']), { allow: ['nope'] })).toBeUndefined()
  })
})

/**
 * fork（corum）2026-09-20：**子 Agent 角色人格选取**（用户定调：所有子 Agent 都不继承
 * 主 Agent 人格；worker = 忠实执行者，researcher = 全面调查员）。
 *
 * 这是本轮修复的核心：旧实现以「父是不是指挥模式」为门，而该判定读**纯内存表**
 * `conductorModes`（宿主重启后为空）⇒ 影子段整段失效，子 Agent 带着继承来的父人格干活
 * （实测 8/8 worker 零执行者契约，其中 2 个还带着"编排者"人格 + "你没有写工具"的自述，
 * 与它手上的 write/edit/bash 直接矛盾）。新实现按**种类**无条件选取，不依赖任何运行时可失状态。
 */
describe('childPersonaOf — 子 Agent 角色人格选取', () => {
  const parent = parentAgent()
  // childPersonaOf 目前不使用 childCtx（保留形参以备按 ctx 裁剪），传 undefined 即可。
  const ctx = undefined as never

  it('worker ⇒ 执行者契约（不继承父人格）', () => {
    const text = childPersonaOf(ctx, parent, { kind: 'worker' }, undefined)
    expect(text).toContain('executor, not a planner')
    expect(text).toContain('Do NOT build')
  })

  it('researcher ⇒ 调查员契约（与 worker 相反的那一份）', () => {
    const text = childPersonaOf(ctx, parent, { kind: 'researcher' }, undefined)
    expect(text).toContain('thorough investigator')
    expect(text).not.toContain('Do NOT build')
  })

  it('三类子 Agent 拿到的契约互不相同（防被写成同一段）', () => {
    const worker = childPersonaOf(ctx, parent, { kind: 'worker' }, undefined)
    const researcher = childPersonaOf(ctx, parent, { kind: 'researcher' }, undefined)
    expect(worker).not.toBe(researcher)
  })

  it('kind 未声明且父非指挥模式 ⇒ undefined（不替换人格，维持既有继承行为）', () => {
    expect(childPersonaOf(ctx, parent, {}, undefined)).toBeUndefined()
    const notConductor = { isConductor: () => false, workStyleFor: () => undefined }
    expect(childPersonaOf(ctx, parent, {}, notConductor)).toBeUndefined()
  })

  it('kind 未声明但父是指挥模式 ⇒ 退化为执行者契约（兼容 2026-09-11 语义）', () => {
    const conductor = { isConductor: () => true, workStyleFor: () => undefined }
    expect(childPersonaOf(ctx, parent, {}, conductor)).toContain('executor, not a planner')
  })

  it('工作风格人格被保留（用户 2026-09-11：子 Agent 继承「怎么干活」，不继承「你是谁」）', () => {
    const conductor = { isConductor: () => true, workStyleFor: () => 'WORK-STYLE-SENTINEL' }
    const text = childPersonaOf(ctx, parent, { kind: 'worker' }, conductor)
    expect(text).toContain('WORK-STYLE-SENTINEL')
    // 风格段必须在角色契约**之后**（顺序固定：角色 → 风格 → 注入）。
    expect(text!.indexOf('executor, not a planner')).toBeLessThan(text!.indexOf('WORK-STYLE-SENTINEL'))
  })

  it('personaHint 追加在最后（叠加层不可覆盖机制层）', () => {
    const text = childPersonaOf(ctx, parent, { kind: 'worker', personaHint: 'HINT-SENTINEL' }, undefined)
    expect(text).toContain('HINT-SENTINEL')
    expect(text!.indexOf('executor, not a planner')).toBeLessThan(text!.indexOf('HINT-SENTINEL'))
  })

  it('空白 personaHint 不注入（不产生空段）', () => {
    const text = childPersonaOf(ctx, parent, { kind: 'worker', personaHint: '   ' }, undefined)
    expect(text).toBe(childPersonaOf(ctx, parent, { kind: 'worker' }, undefined))
  })
})
