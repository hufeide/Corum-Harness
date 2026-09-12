import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { narrowChildToolFilter, resolveChildAgentOptions } from '../src/child-agent.ts'

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
