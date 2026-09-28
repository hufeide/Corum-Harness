/**
 * P2（F5 机制侧）：非隔离写通知必须**按原因**给出正确前提与权限（2026-09-27）。
 *
 * 背景（对抗审查员 A 的 F5）：`isolation: "main"` 的子会话仍是 `worker` kind ⇒ 会拿到
 * 「你在隔离 worktree、没有依赖、不要构建」的角色契约（三条前提全假），而旧通知又**一刀切**
 * 禁止一切 git 操作，与父侧「main 树可以构建/安装/推送」直接对撞。修法：通知按原因参数化。
 */
import { describe, expect, it } from 'vitest'
import { corumDirectWriteNotice } from '../src/orchestration.ts'

describe('corumDirectWriteNotice — 按原因给出前提与权限', () => {
  it('caller-requested-main：说明是调用方显式要主树，且**允许**版本控制', () => {
    const text = corumDirectWriteNotice('caller-requested-main')
    expect(text).toContain('explicitly asked for the main tree')
    expect(text).toContain('Version control IS available to you here')
    expect(text).toContain('`git push`')
    expect(text).not.toContain('do NOT run `git add`')
  })

  it('skipped-non-git：说明不是 git 仓库，且版本控制交给调用方', () => {
    const text = corumDirectWriteNotice('skipped-non-git')
    expect(text).toContain('not a git repository')
    expect(text).toContain('Leave version control to the delegating agent')
    expect(text).toContain('do NOT run `git add` / `commit`')
  })

  it('sequential-iteration：说明是顺序迭代模式，且版本控制交给调用方', () => {
    const text = corumDirectWriteNotice('sequential-iteration')
    expect(text).toContain('sequential-iteration mode')
    expect(text).toContain('Leave version control to the delegating agent')
  })

  it('★ 三条都解除「隔离前提」（构建/安装是工作的一部分）', () => {
    for (const reason of ['caller-requested-main', 'skipped-non-git', 'sequential-iteration'] as const) {
      const text = corumDirectWriteNotice(reason)
      expect(text, reason).toContain('do NOT apply to you')
      expect(text, reason).toContain('a build or an install the brief asks for IS part of your work')
    }
  })

  it('默认值 = skipped-non-git（保守：不动版本控制）', () => {
    expect(corumDirectWriteNotice()).toBe(corumDirectWriteNotice('skipped-non-git'))
  })
})
