/**
 * corum fork #17 的**唯一增量**单测：委派在飞时不得自动开新轮。
 *
 * 为什么不复用官方 1125 行 spec：它依赖官方 `dsh-agent-loop-testkit` 的装配，而 corum 锁定的
 * **已发布**官方包与 dsh checkout 的源码存在错位（实测 `ctx.agentLoop` 应用后仍 pending、
 * 无报错），在 corum 树里跑不起来。替代保证：① 本文件的纯逻辑单测；② 全包与官方原文的差异
 * 由 `scripts/verify-fork-drift.sh` 的已知增量清单机械校验；③ 实机验收（隔离实例里
 * goal + 后台委派 ⇒ 不再空转开轮，`subagent/end` 后继续）。
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { PendingDelegations, isSelfOrDescendant } from '../src/index.ts'

/** 造一个只带 `session.header.parentSession` 的最小 Agent 假体。 */
function fakeAgent(id: string, parentSession?: string): Agent {
  return {
    id,
    session: { header: parentSession === undefined ? {} : { parentSession } },
  } as unknown as Agent
}

describe('isSelfOrDescendant', () => {
  const root = fakeAgent('root')
  const child = fakeAgent('child', 'root')
  const grandchild = fakeAgent('grandchild', 'child')
  const stranger = fakeAgent('stranger')
  const registry = new Map([root, child, grandchild, stranger].map(a => [a.id, a]))
  const resolve = (id: string): Agent | undefined => registry.get(id)

  it('自己算命中', () => {
    expect(isSelfOrDescendant(root, root, resolve)).toBe(true)
  })

  it('直接子与孙都算命中（沿 parentSession 上溯）', () => {
    expect(isSelfOrDescendant(child, root, resolve)).toBe(true)
    expect(isSelfOrDescendant(grandchild, root, resolve)).toBe(true)
  })

  it('无关 Agent 不命中', () => {
    expect(isSelfOrDescendant(stranger, root, resolve)).toBe(false)
  })

  it('祖先不可解析时安全返回 false（不无限上溯）', () => {
    expect(isSelfOrDescendant(fakeAgent('orphan', 'missing'), root, resolve)).toBe(false)
  })
})

describe('PendingDelegations（fork #17 的闸门数据）', () => {
  const root = fakeAgent('root')
  const child = fakeAgent('child', 'root')
  const resolve = (id: string): Agent | undefined => (id === 'root' ? root : id === 'child' ? child : undefined)

  it('空表 ⇒ 没有在飞委派（不改变官方行为）', () => {
    const pending = new PendingDelegations()
    expect(pending.size).toBe(0)
    expect(pending.pendingUnder(root, resolve)).toBe(false)
  })

  it('★ 子女在飞 ⇒ 父与祖先都算"有在飞委派"（正是本次要挡住的空转）', () => {
    const pending = new PendingDelegations()
    pending.start('run-1', root)
    expect(pending.pendingUnder(root, resolve)).toBe(true)
    // 孙辈在跑时，根也算忙（沿 session.header.parentSession 上溯）
    const deeper = new PendingDelegations()
    deeper.start('run-2', child)
    expect(deeper.pendingUnder(root, resolve)).toBe(true)
    expect(deeper.pendingUnder(child, resolve)).toBe(true)
  })

  it('★ end 之后放行（结果回来就能继续推进）', () => {
    const pending = new PendingDelegations()
    pending.start('run-1', root)
    pending.end('run-1')
    expect(pending.size).toBe(0)
    expect(pending.pendingUnder(root, resolve)).toBe(false)
  })

  it('未知 runId 的 end 是空操作（配对由官方 invariant 保证，这里只是防御）', () => {
    const pending = new PendingDelegations()
    pending.end('never-started')
    expect(pending.size).toBe(0)
  })

  it('无关子树在飞不影响本 Agent', () => {
    const pending = new PendingDelegations()
    pending.start('run-x', fakeAgent('other-root'))
    expect(pending.pendingUnder(root, resolve)).toBe(false)
  })
})
