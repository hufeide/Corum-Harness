/**
 * fork（corum）2026-09-26：**子 Agent 提权应答器**的取值与判定（安全关键）。
 *
 * 本文件钉住两件容易写错的事：
 * ① **读回请求必须结构化且严格** —— 从子会话自己的 `tool/call` 事件按 `callId` 取
 *    `arguments.sandbox_permissions`，且必须落在官方封闭词汇表内。事件存在 ≠ 是提权
 *    （被中止的调用同样会写 `tool/call`），所以判据是**参数内容**，不是事件存在。
 * ② **一切不确定都朝关闭倒** —— 读不出请求、读不到 `P`、解析失败，都不得变成放行。
 */
import { describe, expect, it } from 'vitest'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  adjudicateEscalation,
  escalationAskCopy,
  readEscalationRequest,
} from '../src/escalation-answerer.ts'

/** 造一条 `tool/call` 事件。 */
function toolCall(callId: string, args: unknown): { type: string, data: unknown } {
  return { type: 'tool/call', data: { callId, name: 'bash', arguments: JSON.stringify(args) } }
}

describe('readEscalationRequest —— 从子会话日志结构化读回提权请求', () => {
  it('按 callId 命中并取回 sandbox_permissions 与 justification', () => {
    const events = [
      toolCall('call-1', { command: 'ls' }),
      toolCall('call-2', { command: 'rm -rf x', sandbox_permissions: 'danger-full-access', justification: '需要删掉遗留工作树' }),
    ]
    expect(readEscalationRequest(events, 'call-2')).toEqual({
      mode: 'danger-full-access',
      justification: '需要删掉遗留工作树',
    })
  })

  it('justification 缺省时不伪造', () => {
    const events = [toolCall('c', { sandbox_permissions: 'workspace-write' })]
    expect(readEscalationRequest(events, 'c')).toEqual({ mode: 'workspace-write' })
  })

  it('★ 命中同 callId 但**没有** sandbox_permissions ⇒ 不是提权（undefined）', () => {
    const events = [toolCall('c', { command: 'ls' })]
    expect(readEscalationRequest(events, 'c')).toBeUndefined()
  })

  it('★ 事件存在不等于提权：被中止/跳过的 tool/call 不得被当成提权', () => {
    // appendSkippedToolCall 也会写 tool/call，但其 arguments 里没有提权目标。
    const events = [{ type: 'tool/call', data: { callId: 'skipped', name: 'bash', arguments: '{}' } }]
    expect(readEscalationRequest(events, 'skipped')).toBeUndefined()
  })

  it('★ 非法提权目标一律不接受（fail-closed）', () => {
    for (const bad of ['read-only', 'FULL', 'danger_full_access', '', 42, null, {}]) {
      const events = [toolCall('c', { sandbox_permissions: bad })]
      expect(readEscalationRequest(events, 'c'), `应拒绝 ${JSON.stringify(bad)}`).toBeUndefined()
    }
  })

  it('★ 参数不是合法 JSON ⇒ undefined（不抛、不放行）', () => {
    const events = [{ type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{not json' } }]
    expect(readEscalationRequest(events, 'c')).toBeUndefined()
  })

  it('callId 缺失 ⇒ undefined（不去猜哪条是本次调用）', () => {
    const events = [toolCall('c', { sandbox_permissions: 'workspace-write' })]
    expect(readEscalationRequest(events, undefined)).toBeUndefined()
    expect(readEscalationRequest(events, '')).toBeUndefined()
  })

  it('找不到匹配 callId ⇒ undefined', () => {
    const events = [toolCall('other', { sandbox_permissions: 'workspace-write' })]
    expect(readEscalationRequest(events, 'c')).toBeUndefined()
  })

  it('非 tool/call 事件被跳过', () => {
    const events = [
      { type: 'assistant/message', data: { sandbox_permissions: 'workspace-write' } },
      toolCall('c', { sandbox_permissions: 'workspace-write' }),
    ]
    expect(readEscalationRequest(events, 'c')).toEqual({ mode: 'workspace-write' })
  })
})

/** 造一个最小 parent（只需 `ctx.get('sandboxPolicy')` 与 `session`）。 */
function makeParent(parentMode: SandboxMode | undefined): { parent: never, warns: string[] } {
  const warns: string[] = []
  const parent = {
    session: { id: 'parent-session' },
    ctx: {
      get: (name: string) => {
        if (name === 'sandboxPolicy' && parentMode !== undefined) {
          return { resolve: () => ({ mode: parentMode }) }
        }
        return undefined
      },
      logger: { warn: (m: string) => { warns.push(m) } },
    },
  }
  return { parent: parent as never, warns }
}

describe('adjudicateEscalation —— 判定（P 来自父 Agent 当前生效档位）', () => {
  const events = [toolCall('c', { sandbox_permissions: 'danger-full-access', justification: 'why' })]

  it('X ≤ P ⇒ auto-approve（机制自批，不打扰用户）', () => {
    const { parent } = makeParent('danger-full-access')
    const r = adjudicateEscalation({ parent, hardCeiling: 'danger-full-access', logger: { warn: () => {} } }, events, 'c')
    expect(r?.verdict).toEqual({ kind: 'auto-approve' })
  })

  it('X > P ⇒ ask-user', () => {
    const { parent } = makeParent('workspace-write')
    const r = adjudicateEscalation({ parent, hardCeiling: 'danger-full-access', logger: { warn: () => {} } }, events, 'c')
    expect(r?.verdict).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('★ 硬天花板优先：父很宽也拒（隔离/只读不得被提权绕过）', () => {
    const { parent } = makeParent('danger-full-access')
    const r = adjudicateEscalation({ parent, hardCeiling: 'workspace-write', logger: { warn: () => {} } }, events, 'c')
    expect(r?.verdict).toEqual({ kind: 'refuse', reason: 'exceeds-hard-ceiling' })
  })

  it('★ 读不到 P（无 sandboxPolicy）⇒ ask-user，绝不放行', () => {
    const { parent } = makeParent(undefined)
    const r = adjudicateEscalation({ parent, hardCeiling: 'danger-full-access', logger: { warn: () => {} } }, events, 'c')
    expect(r?.verdict).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('★ resolve 抛错 ⇒ ask-user + 告警，绝不放行', () => {
    const warns: string[] = []
    const parent = {
      session: { id: 'p' },
      ctx: { get: () => ({ resolve: () => { throw new Error('boom') } }) },
    }
    const r = adjudicateEscalation(
      { parent: parent as never, hardCeiling: 'danger-full-access', logger: { warn: m => warns.push(m) } },
      events,
      'c',
    )
    expect(r?.verdict).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
    expect(warns).toHaveLength(1)
  })

  it('不是提权 ⇒ undefined（调用方据此保住旧的「子会话 ask 一律被拒」语义）', () => {
    const { parent } = makeParent('danger-full-access')
    const r = adjudicateEscalation(
      { parent, hardCeiling: 'danger-full-access', logger: { warn: () => {} } },
      [toolCall('c', { command: 'ls' })],
      'c',
    )
    expect(r).toBeUndefined()
  })
})

describe('escalationAskCopy —— 上呈用户时的文案（host 是唯一事实源）', () => {
  it('含档位与理由，且中英各一份', () => {
    const copy = escalationAskCopy('danger-full-access', '需要清理遗留工作树')
    expect(copy.reason).toContain('danger-full-access')
    expect(copy.reason).toContain('需要清理遗留工作树')
    expect(copy.displayReason.en).toContain('danger-full-access')
    expect(copy.displayReason.zh).toContain('danger-full-access')
  })

  it('没给理由时不伪造（写成 no reason given）', () => {
    expect(escalationAskCopy('workspace-write', undefined).reason).toContain('no reason given')
    expect(escalationAskCopy('workspace-write', '').reason).toContain('no reason given')
  })
})
