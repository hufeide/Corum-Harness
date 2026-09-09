import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { corumGitWriteRoots, corumResetGitRootsCache } from '../src/git-write-roots.ts'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), 'corum-sandbox-local-')))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** 建一个临时仓库 + 一条 worktree，返回两者的规范路径。 */
function repoWithWorktree(name: string): { repo: string; worktree: string; gitdir: string; common: string } {
  const repo = join(scratch, name)
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  git(repo, ['config', 'user.email', 'test@corum.local'])
  git(repo, ['config', 'user.name', 'corum-test'])
  git(repo, ['commit', '--allow-empty', '-m', 'init'])
  const worktree = join(repo, '.corum-worktrees', 'wt-spec01')
  git(repo, ['worktree', 'add', worktree, '-b', 'wt/wt-spec01'])
  corumResetGitRootsCache()
  return {
    repo: realpathSync.native(repo),
    worktree: realpathSync.native(worktree),
    gitdir: realpathSync.native(join(repo, '.git', 'worktrees', 'wt-spec01')),
    common: realpathSync.native(join(repo, '.git')),
  }
}

describe('corumGitWriteRoots — fork（corum）git 元数据可写根', () => {
  it('非 git 目录：返回空（能力自动关闭，不抛错）', () => {
    const plain = join(scratch, 'plain')
    mkdirSync(plain, { recursive: true })
    corumResetGitRootsCache()
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: plain })).toEqual([])
  })

  it('read-only：不追加任何根（一个字节都不该写）', () => {
    const { worktree } = repoWithWorktree('repo-readonly')
    expect(corumGitWriteRoots({ mode: 'read-only', workspaceRoot: worktree })).toEqual([])
  })

  it('worktree：返回 worktree gitdir + 公共 common dir（git add/commit 真正要写的两个目录）', () => {
    const { worktree, gitdir, common } = repoWithWorktree('repo-wt')
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })).toEqual([gitdir, common])
  })

  it('主仓（非 worktree）：返回仓内 .git 一次（与官方 workspaceRoot 根并存，不重复）', () => {
    const { repo } = repoWithWorktree('repo-main')
    expect(corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: repo })).toEqual([join(repo, '.git')])
  })

  it('探测结果进程内缓存（同一 workspace 反复 confine 不重复 fork git）', () => {
    const { worktree, gitdir } = repoWithWorktree('repo-cache')
    const first = corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })
    const second = corumGitWriteRoots({ mode: 'workspace-write', workspaceRoot: worktree })
    expect(second).toEqual(first)
    expect(second).toEqual([gitdir, expect.any(String)])
  })
})

describe('平台 profile 的 git 元数据授权（fork 增量落点）', () => {
  it('Seatbelt：SBPL 同时含 workspace 根与两个 git 目录的 subpath 授权', () => {
    const { worktree, gitdir, common } = repoWithWorktree('repo-seatbelt')
    const args = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: worktree })
    const profile = args[1]
    expect(profile).toContain(`(subpath "${worktree}")`)
    expect(profile).toContain(`(subpath "${gitdir}")`)
    expect(profile).toContain(`(subpath "${common}")`)
    // 写仍然被整体拒绝（(deny file-write*) 在授权之前），只是多两个白名单根。
    expect(profile).toContain('(deny file-write*)')
  })

  it('Seatbelt：read-only 不含任何 git 根（探针路径也不额外授权）', () => {
    const { worktree, gitdir } = repoWithWorktree('repo-seatbelt-ro')
    const profile = seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: worktree })[1]
    expect(profile).not.toContain(`(subpath "${gitdir}")`)
  })

  it('bwrap / Landlock：git 根进入 bind / readWrite 面', () => {
    const { worktree, gitdir, common } = repoWithWorktree('repo-linux')
    const bwrap = bwrapProfileArgs({ mode: 'workspace-write', workspaceRoot: worktree })
    expect(bwrap.join(' ')).toContain(`--bind ${gitdir} ${gitdir}`)
    expect(bwrap.join(' ')).toContain(`--bind ${common} ${common}`)
    const landlock = landlockProfileArgs({ mode: 'workspace-write', workspaceRoot: worktree })
    expect(landlock).toContain(gitdir)
    expect(landlock).toContain(common)
  })
})
