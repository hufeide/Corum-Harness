/**
 * fork（corum）2026-09-26：**子 Agent 提权判定**的回归门禁（安全关键）。
 *
 * 本文件钉住的是**用户 2026-09-14 三段原话**与 2026-09-26 的拍板口径：
 *   `X ≤ P` ⇒ 机制自动批准；`X > P` ⇒ 上呈用户；隔离子 Agent 另有天花板。
 *
 * 为什么必须有这组测试：提权是**扩权**操作，判定写错的方向只有一个是安全的
 * （朝「关闭」倒）。而它的输入里有 `P`（用户可改的状态）与 `confined`（隔离不变式），
 * 两者的优先级一旦写反，就会复活 2026-09-22 实测过的「隔离被整档旁路」漏洞
 * （`corum-task-ef3f751e`：worker 删 19 个 worktree + 对主树 merge）。
 */
import { describe, expect, it } from 'vitest'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  CORUM_ESCALATION_OPTIONS,
  corumEscalationSummary,
  corumResolveEscalationDecision,
  decideEscalation,
  hardCeilingFor,
  WIDEST_MODE,
  grantCovers,
  isEscalationTarget,
  sandboxModeRank,
} from '../src/escalation-policy.ts'

describe('① 用户 9-14 的三种情形（P/C）—— 逐条对照原话', () => {
  it('情形 ① P == C：子请求必然 X > P ⇒ **上呈用户**（「主 Agent 不得自行批准」）', () => {
    // P == C == workspace-write ⇒ 唯一合法提权是 danger-full-access（官方强制严格更宽）
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'workspace-write', hardCeiling: WIDEST_MODE })
    expect(v).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('情形 ② P > C：X ≤ P ⇒ **机制直接同意**（「够则直接同意，不必打扰用户」）', () => {
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'danger-full-access', hardCeiling: WIDEST_MODE })
    expect(v).toEqual({ kind: 'auto-approve' })
  })

  it('情形 ② 的「不足」分支：P > C 但请求仍 > P —— 本情形下不可达（记录原因）', () => {
    // P > C 且 X 严格宽于 C。若 P == danger-full-access 则无更宽档位可请求；
    // 故「P > C 但 X > P」在档位全序下不存在。这里用只读父 + 隔离子（C=workspace-write）
    // 覆盖「父比子窄」的相邻形态，见情形 ③。
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'read-only', hardCeiling: WIDEST_MODE })
    expect(v).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('情形 ③ P < C：请求必然 X > C > P ⇒ **必须上呈**（不得用更低权限裁量）', () => {
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'read-only', hardCeiling: WIDEST_MODE })
    expect(v.kind).toBe('ask-user')
    expect(v).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('★ 上限恒为 P：绝不授予超过主 Agent 自身所持的权限（穷举全序）', () => {
    const modes: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']
    for (const parentMode of modes) {
      for (const requested of modes) {
        const v = decideEscalation({ requested, parentMode, hardCeiling: WIDEST_MODE })
        if (v.kind === 'auto-approve') {
          // 自动批准必须满足 requested ≤ parentMode —— 这是「不得给自己扩权」的形式化。
          expect(sandboxModeRank(requested)).toBeLessThanOrEqual(sandboxModeRank(parentMode))
        }
      }
    }
  })

  it('★ 用户收紧主 Agent 权限 ⇒ 自动批准面收窄（用户 9-14 记的加分副作用）', () => {
    const wide = decideEscalation({ requested: 'danger-full-access', parentMode: 'danger-full-access', hardCeiling: WIDEST_MODE })
    const tight = decideEscalation({ requested: 'danger-full-access', parentMode: 'workspace-write', hardCeiling: WIDEST_MODE })
    expect(wide.kind).toBe('auto-approve')
    expect(tight.kind).toBe('ask-user')
  })
})

describe('② 硬天花板：**只读研究**（用户 2026-09-26 裁定：隔离不封档位）', () => {
  it('★★ 用户裁定：隔离**不是**档位天花板——隔离子允许提权（写边界由 guard 独立守）', () => {
    // 用户原话：「隔离只是工作区隔离……但若子 Agent 需要访问或者执行一些指令，需要权限还是合理的。」
    // 即「工作区写边界」（guard，按路径）与「沙箱档位」（权限面）是两个轴，提权只动后者。
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'danger-full-access', hardCeiling: WIDEST_MODE })
    expect(v).toEqual({ kind: 'auto-approve' })
  })

  it('★ 隔离子 + 父较窄：仍按父上限上呈（不是被隔离拦下）', () => {
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'workspace-write', hardCeiling: WIDEST_MODE })
    expect(v).toEqual({ kind: 'ask-user', reason: 'exceeds-parent-mode' })
  })

  it('★ 只读研究子 Agent：**任何**提权都被拒（它不隔离、cwd 就是父工作区）', () => {
    // 与隔离不同：只读研究本来就不隔离，放开写＝直接写主树 ⇒「只读研究不落盘」会被绕过。
    for (const requested of ['workspace-write', 'danger-full-access'] as const) {
      const v = decideEscalation({ requested, parentMode: 'danger-full-access', hardCeiling: 'read-only' })
      expect(v, `只读研究请求 ${requested} 必须被拒`).toEqual({ kind: 'refuse', reason: 'exceeds-hard-ceiling' })
    }
  })

  it('★ 越界是**直接拒绝**，不是「上呈用户」——不该存在的提问不要问', () => {
    const v = decideEscalation({ requested: 'workspace-write', parentMode: 'danger-full-access', hardCeiling: 'read-only' })
    expect(v.kind).toBe('refuse')
    expect(v.kind === 'refuse' && v.reason).toBe('exceeds-hard-ceiling')
  })

  it('硬天花板优先于父上限（两条都命中时，必须因天花板拦下）', () => {
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'danger-full-access', hardCeiling: 'read-only' })
    expect(v.kind).toBe('refuse')
  })

  it('普通子 Agent 无硬约束（不误伤）', () => {
    const v = decideEscalation({ requested: 'danger-full-access', parentMode: 'danger-full-access', hardCeiling: WIDEST_MODE })
    expect(v).toEqual({ kind: 'auto-approve' })
  })
})

describe('②b hardCeilingFor：只有只读研究有硬约束（唯一事实源）', () => {
  it('普通子 Agent：无硬约束', () => {
    expect(hardCeilingFor({})).toBe('danger-full-access')
  })

  it('★ 只读研究：夹在 read-only（它不隔离、cwd 是父工作区）', () => {
    expect(hardCeilingFor({ pinReadOnly: true })).toBe('read-only')
  })
})

describe('③ 提权目标词汇表校验（防 fail-open）', () => {
  it('只接受封闭词汇表里的提权目标（read-only 不是提权目标）', () => {
    expect(isEscalationTarget('workspace-write')).toBe(true)
    expect(isEscalationTarget('danger-full-access')).toBe(true)
    expect(isEscalationTarget('read-only')).toBe(false)
  })

  it('★ 非字符串/垃圾值一律不接受（工具参数是不可信输入）', () => {
    for (const bad of [undefined, null, '', 'FULL', 'danger_full_access', 42, {}, [], true]) {
      expect(isEscalationTarget(bad), `应拒绝 ${JSON.stringify(bad)}`).toBe(false)
    }
  })
})

describe('④ 三档放行 + 解析（未知一律朝关闭倒）', () => {
  it('档位清单是 host 下发的三档，**不含**预留的「自动」档', () => {
    expect(CORUM_ESCALATION_OPTIONS.map(o => o.kind)).toEqual(['allowed-once', 'always-allow', 'rejected'])
  })

  it('★ 未知/缺失的决定一律 dismissed（绝不静默放行）', () => {
    expect(corumResolveEscalationDecision(undefined)).toEqual({ kind: 'dismissed' })
    expect(corumResolveEscalationDecision('')).toEqual({ kind: 'dismissed' })
    expect(corumResolveEscalationDecision('auto')).toEqual({ kind: 'dismissed' })
    expect(corumResolveEscalationDecision('ALLOWED-ONCE')).toEqual({ kind: 'dismissed' })
    expect(corumResolveEscalationDecision('{"kind":"allowed-once"}')).toEqual({ kind: 'dismissed' })
  })

  it('★ 官方结果词汇表是封闭的：不得把「总是允许」当成新 outcome 回传', () => {
    // 官方 OUTCOMES 只有 allowed-once/rejected/cancelled/unavailable，未知值被归一为
    // unavailable（fail-closed）。故 always-allow 只能是**机制侧记一条授权**，
    // 然后回传既有 allowed-once —— 本用例钉住「协议词汇就是那三档」。
    expect(CORUM_ESCALATION_OPTIONS.some(o => o.kind === 'always-allow')).toBe(true)
    // 而 client 能回传的 kind 也就是这三个（解析器只认它们）。
    expect(corumResolveEscalationDecision('always-allow')).toEqual({ kind: 'always-allow' })
    expect(corumResolveEscalationDecision('cancelled')).toEqual({ kind: 'dismissed' })
  })
})

describe('⑤ 会话内授权覆盖（always-allow 的语义）', () => {
  it('★ 授权不自动升级：批准 workspace-write 后，请求 danger-full-access 仍要问', () => {
    expect(grantCovers('workspace-write', 'workspace-write')).toBe(true)
    expect(grantCovers('workspace-write', 'danger-full-access')).toBe(false)
  })

  it('更宽的授权覆盖更窄的请求', () => {
    expect(grantCovers('danger-full-access', 'workspace-write')).toBe(true)
    expect(grantCovers('danger-full-access', 'danger-full-access')).toBe(true)
  })

  it('摘要含标签与目标档位', () => {
    expect(corumEscalationSummary('清理工作树', 'danger-full-access')).toBe('清理工作树 请求提权到 danger-full-access')
  })
})
