/**
 * fork（corum）2026-09-26：三档里的第 2 档「**总是允许**」—— 会话级提权授权。
 *
 * 本文件钉住三件事：
 * ① 授权是**按父会话**的（用户原话：「该会话内后续所有相关请求」）；
 * ② 官方 outcome 词汇表封闭 ⇒ 第 2 档**本次仍回 `allowed-once`**，机制侧只是**多记一条**
 *    （所以这里只测「记/查」这一半，另一半是应答器回 `allowed-once`）；
 * ③ ★ **授权绝不豁免硬天花板**：`refuse` 不因授权而改变 —— 顺序写反即放行只读研究，
 *    这是本模块最要紧的不变式。
 */
import { describe, expect, it } from 'vitest'
import { applySessionGrant, decideEscalation, WIDEST_MODE } from '../src/escalation-policy.ts'
import { EscalationGrants } from '../src/escalation-grants.ts'

describe('EscalationGrants —— 会话级授权的纯状态', () => {
  it('默认未授权（fail-closed）', () => {
    expect(new EscalationGrants().isGranted('s1')).toBe(false)
  })

  it('grant 之后该会话已授权', () => {
    const g = new EscalationGrants()
    g.grant('s1')
    expect(g.isGranted('s1')).toBe(true)
  })

  it('★ 按会话隔离：授权一个会话不波及其它会话', () => {
    // 用户口径是「该会话内」——泄漏到别的会话就等于全局永久放行。
    const g = new EscalationGrants()
    g.grant('s1')
    expect(g.isGranted('s1')).toBe(true)
    expect(g.isGranted('s2')).toBe(false)
  })

  it('★ 空键不得产生授权（防「空串当作已授权」的 fail-open）', () => {
    const g = new EscalationGrants()
    g.grant(undefined)
    g.grant('')
    expect(g.isGranted(undefined)).toBe(false)
    expect(g.isGranted('')).toBe(false)
    expect(g.size).toBe(0)
  })

  it('查询 undefined/空串恒为 false', () => {
    const g = new EscalationGrants()
    g.grant('s1')
    expect(g.isGranted(undefined)).toBe(false)
    expect(g.isGranted('')).toBe(false)
  })

  it('重复 grant 幂等（不会重复计数）', () => {
    const g = new EscalationGrants()
    g.grant('s1')
    g.grant('s1')
    expect(g.size).toBe(1)
  })
})

describe('applySessionGrant —— 授权只升级 ask-user，绝不改变 refuse', () => {
  it('ask-user + 已授权 ⇒ auto-approve（这就是第 2 档「免问」）', () => {
    const v = applySessionGrant({ kind: 'ask-user', reason: 'exceeds-parent-mode' }, true)
    expect(v).toEqual({ kind: 'auto-approve' })
  })

  it('ask-user + 未授权 ⇒ 原样上呈', () => {
    const v = applySessionGrant({ kind: 'ask-user', reason: 'exceeds-parent-mode' }, false)
    expect(v).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('★★ refuse + 已授权 ⇒ **仍然 refuse**（硬天花板不被授权豁免）', () => {
    // 顺序写反（先授权后天花板）= 只读研究子 Agent 被一条会话授权放行去写主树。
    // 这条断言就是那个 bug 的哨兵。
    const v = applySessionGrant({ kind: 'refuse', reason: 'exceeds-hard-ceiling' }, true)
    expect(v).toEqual({ kind: 'refuse', reason: 'exceeds-hard-ceiling' })
  })

  it('auto-approve 幂等（授权不改变已放行的结论）', () => {
    expect(applySessionGrant({ kind: 'auto-approve' }, true)).toEqual({ kind: 'auto-approve' })
    expect(applySessionGrant({ kind: 'auto-approve' }, false)).toEqual({ kind: 'auto-approve' })
  })
})

describe('★ 端到端顺序：只读研究即便被授权也拿不到更宽档位', () => {
  it('hardCeiling=read-only 时，任何授权都不放行', () => {
    // 直接按应答器的真实链路走一遍：decideEscalation(先) → applySessionGrant(后)。
    for (const requested of ['workspace-write', 'danger-full-access'] as const) {
      const decided = decideEscalation({ requested, parentMode: 'danger-full-access', hardCeiling: 'read-only' })
      expect(decided.kind).toBe('refuse')
      expect(applySessionGrant(decided, true).kind, `只读研究请求 ${requested} 不得因授权放行`).toBe('refuse')
    }
  })

  it('普通子 Agent（无硬约束）被授权后确实免问', () => {
    const decided = decideEscalation({ requested: 'danger-full-access', parentMode: 'workspace-write', hardCeiling: WIDEST_MODE })
    expect(decided.kind).toBe('ask-user')
    expect(applySessionGrant(decided, true).kind).toBe('auto-approve')
  })
})
