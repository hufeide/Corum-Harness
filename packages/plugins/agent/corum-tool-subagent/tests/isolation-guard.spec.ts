/**
 * fork（corum）**隔离补漏**单测（2026-09-15，用户立规「必须提交」后）。
 *
 * 两条机制缺口各对应一组断言：
 *
 * **H1 · 基线不对（父树未提交 ⇒ 子看不到）**
 * 事故：子 Agent 的「Integrate BEFORE evidence branch」失败，根因是派发前父树改动未提交。
 * 链条：`git worktree add -b <branch>`（**不指定 base**）⇒ 从 HEAD 建分支；父树未提交改动
 * 不在任何提交里 ⇒ 子看不到。实证（监督侧）：父树改过的 theme.css 里新值
 * `1D112B9E` —— 父树命中 1、worktree 命中 0。
 * ⇒ 断言 `corumDirtyParentRefusal` 按**严格档**（用户 2026-09-15 裁定：含 untracked 也拦）
 * 拒绝，且 `createWorktreeChild` 在**建目录之前**就抛。
 *
 * **H2 · 收口必须提交（机制保证，不由 Agent 自己决定）**
 * 用户裁定：「无论如何每次工作结束 Agent 必须提交……要在机制上保证」，
 * 且「commit 失败后**交由模型处理并完成提交**」。
 * ⇒ 断言 `corumCommitWorktreeOnSettle` 把未提交的 worktree 提交掉（带可识别主题），
 * 干净/不存在时是安全的 no-op，失败时返回**结构化原因**（供上层投递给模型）。
 *
 * 全部用**真实临时 git 仓库**驱动（无 mock），与 execute 层同一 git 命令面。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORUM_AUTO_COMMIT_SUBJECT,
  CorumOrchestration,
  corumCommitWorktreeOnSettle,
  corumDirtyParentRefusal,
  corumGit,
  corumWorktreeHasUncommitted,
} from '../src/orchestration.ts'

const scratchDirs: string[] = []

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 真临时仓库（已 init + 一次提交，git 身份就位）。 */
function makeRepo(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'corum-guard-'))
  scratchDirs.push(scratch)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'init'], { stdio: 'pipe' })
  return repo
}

/** 真 worktree（= 隔离子将工作的目录）。 */
function makeWorktree(repo: string, slug = 'wt-guard01'): { worktree: string; branch: string } {
  const branch = `wt/${slug}`
  const worktree = join(repo, '.corum-worktrees', slug)
  corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
  return { worktree, branch }
}

describe('corumDirtyParentRefusal — 隔离前置校验（严格档：任何 porcelain 行都拦）', () => {
  it('干净的父树 → 放行（undefined）', () => {
    const repo = makeRepo()
    expect(corumDirtyParentRefusal(repo)).toBeUndefined()
  })

  it('已跟踪文件被修改 → 拒绝，且原因可读（含条数与处置指引）', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'seed.txt'), 'changed\n')
    const refusal = corumDirtyParentRefusal(repo)
    expect(refusal).toBeDefined()
    expect(refusal).toContain('isolation refused')
    expect(refusal).toContain('1 uncommitted change(s)')
    expect(refusal).toContain('seed.txt')
    // 必须说清「为什么」与「怎么办」——否则模型只会看到一句无用报错。
    expect(refusal).toContain('branches off HEAD')
    expect(refusal).toContain('Commit (or stash)')
  })

  it('**untracked 新源码** 同样拒绝（严格档的核心：子的树必须等于父的树）', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'brand-new.ts'), 'export const x = 1\n')
    const refusal = corumDirtyParentRefusal(repo)
    expect(refusal).toBeDefined()
    expect(refusal).toContain('brand-new.ts')
  })

  it('已暂存未提交（staged）也拒绝', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    execFileSync('git', ['-C', repo, 'add', '-A'], { stdio: 'pipe' })
    expect(corumDirtyParentRefusal(repo)).toBeDefined()
  })

  it('改动超过 5 条时给出「还有 N 条」而不是刷屏', () => {
    const repo = makeRepo()
    for (let i = 0; i < 8; i++) writeFileSync(join(repo, `f${i}.txt`), 'x\n')
    const refusal = corumDirtyParentRefusal(repo) ?? ''
    expect(refusal).toContain('8 uncommitted change(s)')
    expect(refusal).toContain('…and 3 more')
  })
})

describe('createWorktreeChild — 脏父树时在建目录之前就拒绝（H1 的机制化）', () => {
  it('脏父树 ⇒ 抛错，且**不留下半成品 worktree 目录**', () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'dirty.txt'), 'x\n')
    const orchestration = new CorumOrchestration(new Context())
    const root = join(repo, '.corum-worktrees')
    expect(() => orchestration.createWorktreeChild('session-1', repo)).toThrow(/isolation refused/)
    // 关键：拒绝发生在 mkdir/worktree add 之前 ⇒ 不留垃圾目录。
    expect(existsSync(root)).toBe(false)
  })

  it('干净父树 ⇒ 正常建出 worktree（守卫不误伤）', () => {
    const repo = makeRepo()
    const orchestration = new CorumOrchestration(new Context())
    const child = orchestration.createWorktreeChild('session-2', repo)
    expect(existsSync(child.path)).toBe(true)
    expect(child.branch.startsWith('wt/')).toBe(true)
  })
})

describe('corumCommitWorktreeOnSettle — 收口强制提交（机制保证，不由 Agent 决定）', () => {
  it('未提交的 worktree ⇒ 被机制提交掉，且提交主题可识别', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo)
    writeFileSync(join(worktree, 'child-work.txt'), 'payload\n')
    expect(corumWorktreeHasUncommitted(worktree)).toBe(true)

    const failure = corumCommitWorktreeOnSettle(worktree, 'wt-guard01')

    expect(failure).toBeUndefined()
    // 「未提交」这一态必须被消灭 —— 这正是用户要的「机制保证」。
    expect(corumWorktreeHasUncommitted(worktree)).toBe(false)
    const subject = execFileSync('git', ['-C', worktree, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()
    expect(subject).toBe(CORUM_AUTO_COMMIT_SUBJECT)
    // 内容是**被提交**而不是被丢弃。
    const files = execFileSync('git', ['-C', worktree, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' })
    expect(files).toContain('child-work.txt')
  })

  it('untracked 新文件也被纳入提交（否则子的新源码会丢）', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo, 'wt-guard02')
    writeFileSync(join(worktree, 'brand-new.ts'), 'export {}\n')
    expect(corumCommitWorktreeOnSettle(worktree, 'wt-guard02')).toBeUndefined()
    const tracked = execFileSync('git', ['-C', worktree, 'ls-files'], { encoding: 'utf8' })
    expect(tracked).toContain('brand-new.ts')
  })

  it('干净 worktree ⇒ 安全 no-op（不造空提交）', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo, 'wt-guard03')
    const before = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(corumCommitWorktreeOnSettle(worktree, 'wt-guard03')).toBeUndefined()
    const after = execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(after).toBe(before)
  })

  it('目录不存在 ⇒ 安全 no-op（已回收的条目不应报错）', () => {
    const repo = makeRepo()
    expect(corumCommitWorktreeOnSettle(join(repo, 'nope'), 'wt-gone')).toBeUndefined()
  })

  it('提交失败 ⇒ 返回**结构化原因**（供上层投递给模型，而不是静默丢）', () => {
    const repo = makeRepo()
    const { worktree } = makeWorktree(repo, 'wt-guard04')
    writeFileSync(join(worktree, 'x.txt'), 'x\n')
    // 制造必然失败：把 index 锁住（git commit 会拒绝）。
    writeFileSync(join(repo, '.git', 'worktrees', 'wt-guard04', 'index.lock'), '')
    const failure = corumCommitWorktreeOnSettle(worktree, 'wt-guard04')
    expect(failure).toBeDefined()
    expect(failure?.slug).toBe('wt-guard04')
    expect(failure?.path).toBe(worktree)
    expect(failure?.reason.length).toBeGreaterThan(0)
    // 现场必须保住：失败不等于丢工作。
    expect(corumWorktreeHasUncommitted(worktree)).toBe(true)
  })
})
