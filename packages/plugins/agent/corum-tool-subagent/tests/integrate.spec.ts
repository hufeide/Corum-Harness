/**
 * fork（corum）集成真值门禁单测（docs/TODO.md「orchestrate autoIntegrate 合并回
 * 主树不可靠」修复，2026-09-09）。
 *
 * 事故链条（本 spec 逐环设防）：
 *   集成者自称「已 merge + verify 通过」→ 机制无条件写台账 integrated 并
 *   `worktree remove --force` + `branch -D` → 子任务 commit 变 unreachable、
 *   文件从主树消失。修复后：
 *   1. corumBranchIntegrated — 分支工作是否真进入 HEAD（祖先或 patch 等价）；
 *   2. corumIntegrationTruth — 机制真值判定（未合并 / 写了没提交）；
 *   3. corumCleanupWorktree — 安全清理（未合并分支不删、脏 worktree 保留现场）；
 *   4. corumCleanupLedgerEntries — 仅完整清理才标 discarded（状态如实）；
 *   5. corumIntegrationFailure — 失败报告含「自述 vs 实况」对照 + 现场已保留。
 * 全部用真实临时 git 仓库驱动（无 mock），与 execute 层同一 git 命令面。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  corumBranchIntegrated,
  corumBranchMerged,
  corumBranchTip,
  corumCleanupLedgerEntries,
  corumCleanupWorktree,
  corumGit,
  corumGitHead,
  corumMergedBranches,
  corumAutoIntegrate,
  corumReconcileIntegrated,
  corumReapRestoredEntries,
  corumReapOrphanWorktrees,
  corumListIsolatedWorktrees,
  corumIntegrationFailure,
  corumIntegrationTruth,
  corumIntegratorPersona,
  corumPartialIntegrationNotice,
  corumWorktreeHasUncommitted,
  type CorumWorktreeEntry,
} from '../src/index.ts'

const scratchDirs: string[] = []

/** 建一个真实 git 仓库 + 一个隔离 worktree/分支（复刻 spawnOne 的创建命令）。 */
function makeRepoWithWorktree(slug = 'wt-int001'): {
  repo: string
  worktree: string
  branch: string
  entry: CorumWorktreeEntry
} {
  const scratch = mkdtempSync(join(tmpdir(), 'corum-integrate-'))
  scratchDirs.push(scratch)
  const repo = join(scratch, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  const branch = `wt/${slug}`
  const worktree = join(repo, '.corum-worktrees', slug)
  corumGit(repo, ['worktree', 'add', '-q', worktree, '-b', branch])
  return {
    repo,
    worktree,
    branch,
    entry: { slug, branch, path: worktree, status: 'settled' },
  }
}

/** 在 worktree 里写文件并提交（子 Agent 的正常产出形态）。 */
function commitInWorktree(worktree: string, file: string, content = 'child payload'): string {
  writeFileSync(join(worktree, file), content)
  execFileSync('git', ['-C', worktree, 'add', '-A'], { stdio: 'pipe' })
  execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', `add ${file}`], { stdio: 'pipe' })
  return execFileSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/** 分支是否还存在（清理安全阀的判定面）。 */
function branchExists(repo: string, branch: string): boolean {
  return execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== ''
}

beforeEach(() => { /* scratch 每例独立创建 */ })

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('corumBranchIntegrated — 分支工作是否真进入 HEAD', () => {
  it('子任务已提交但未合并 → false（未并入 HEAD）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    expect(corumBranchMerged(repo, branch)).toBe(false)
    expect(corumBranchIntegrated(repo, branch)).toBe(false)
  })

  it('真实 merge --no-ff 后 → true（祖先关系）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    expect(corumBranchIntegrated(repo, branch)).toBe(true)
  })

  it('cherry-pick 等价落地（分支非祖先）→ true（patch 等价兜底）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree()
    const sha = commitInWorktree(worktree, 'ORCH-INT-2.txt')
    // 用不同 committer 身份落地，避免 SHA 与子任务 commit 相同（同身份 + 同秒会
    // 产生同一对象，祖先判定会误判为已合并，测不到 cherry 等价分支）。
    corumGit(repo, ['-c', 'user.name=integrator', '-c', 'user.email=int@corum.local', 'cherry-pick', sha])
    expect(corumBranchMerged(repo, branch)).toBe(false) // 非祖先
    expect(corumBranchIntegrated(repo, branch)).toBe(true) // 但工作已落地
  })

  it('分支无新提交 → true（空 cherry 输出，不误判）', () => {
    const { repo, branch } = makeRepoWithWorktree()
    expect(corumBranchIntegrated(repo, branch)).toBe(true)
  })
})

describe('corumIntegrationTruth — 机制真值门禁', () => {
  // fork（corum）2026-09-12 语义修正：`uncommitted` 不再参与 `integrated`。
  // 实测事故：兄弟 worktree 的一个 scratch 残留文件让**已落地**的集成被判失败
  // （corum-task-d51272e3：主树 HEAD 704f855e → 254df321 已合并，却收到
  // 「integrate did not persist into the main tree」），主 Agent 的后续
  // 「验证 + 提交 + 落位」三阶段整条没起来。现在：
  //   · 「分支是否已并入 HEAD」= 集成失败的唯一闸门（真未落地仍抛错 + 保留现场）；
  //   · 未提交改动 = 该条目**保持 pending、保留现场**，由调用方通知主 Agent 处理。
  it('写了没提交（分支无新提交 + worktree 脏）→ integrated=true（分支口径），但如实报 uncommitted', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree()
    writeFileSync(join(worktree, 'ORCH-INT-1.txt'), 'written but never committed')
    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.integrated).toBe(true)
    expect(truth.unmerged).toEqual([])
    expect(truth.uncommitted.join(' ')).toContain(entry.slug)
  })

  it('部分集成会给出可读说明（未持久化条目 + 下一步）', () => {
    const { repo, worktree, entry, branch } = makeRepoWithWorktree()
    writeFileSync(join(worktree, 'ORCH-INT-1.txt'), 'written but never committed')
    const truth = corumIntegrationTruth(repo, [entry])
    const notice = corumPartialIntegrationNotice(truth, 'deadbeefdeadbeef')
    expect(notice).toContain('PARTIALLY persisted')
    expect(notice).toContain(entry.slug)
    expect(notice).toContain('kept pending')
    expect(branch).toBe(entry.branch)
  })

  it('已提交未合并 → integrated=false 且报 unmerged', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const truth = corumIntegrationTruth(repo, [entry])
    expect(truth.integrated).toBe(false)
    expect(truth.unmerged).toEqual([branch])
  })

  it('真实合并 + worktree 干净 → integrated=true，HEAD 前进', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const before = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    const truth = corumIntegrationTruth(repo, [entry], '')
    expect(truth.integrated).toBe(true)
    expect(truth.head).not.toBe(before)
    expect(existsSync(join(repo, 'ORCH-INT-1.txt'))).toBe(true)
  })

  it('dirtyDelta 只报集成后新增的未提交路径（基线过滤）', () => {
    const { repo, entry } = makeRepoWithWorktree()
    writeFileSync(join(repo, 'unrelated.txt'), 'pre-existing')
    const before = execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
    writeFileSync(join(repo, 'new-from-integrate.txt'), 'stray')
    const truth = corumIntegrationTruth(repo, [entry], before)
    expect(truth.dirtyDelta.join(' ')).toContain('new-from-integrate.txt')
    expect(truth.dirtyDelta.join(' ')).not.toContain('unrelated.txt')
  })
})

describe('corumCleanupWorktree — 清理安全阀（事故核心防线）', () => {
  it('非 force + 未合并分支 → 保留分支，回收干净目录，返回未完整清理', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const cleaned = corumCleanupWorktree(repo, entry, { force: false })
    expect(cleaned).toBe(false)
    expect(branchExists(repo, branch)).toBe(true) // 工作唯一留存保住了
    expect(existsSync(worktree)).toBe(false) // 目录已回收
    // 分支上的 commit 仍可从仓库读取（数据未丢）
    expect(execFileSync('git', ['-C', repo, 'log', '--oneline', branch], { encoding: 'utf8' }))
      .toContain('add ORCH-INT-1.txt')
  })

  it('非 force + 脏 worktree → 连目录一起保留（现场完整）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    writeFileSync(join(worktree, 'ORCH-INT-1.txt'), 'uncommitted')
    const cleaned = corumCleanupWorktree(repo, entry, { force: false })
    expect(cleaned).toBe(false)
    expect(existsSync(join(worktree, 'ORCH-INT-1.txt'))).toBe(true)
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('非 force + 已合并干净 → 完整清理（目录 + 分支）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    corumGit(repo, ['merge', '--no-ff', '-m', 'merge wt', branch])
    const cleaned = corumCleanupWorktree(repo, entry, { force: false })
    expect(cleaned).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('force → 无条件强删（仅集成成功后调用）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const cleaned = corumCleanupWorktree(repo, entry, { force: true })
    expect(cleaned).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })
})

describe('corumCleanupLedgerEntries — 台账状态如实', () => {
  it('未合并 → 条目保持 settled（不标 discarded，落盘可见）', () => {
    const { repo, entry } = makeRepoWithWorktree()
    commitInWorktree(entry.path, 'ORCH-INT-1.txt')
    corumCleanupLedgerEntries(repo, [entry], ['settled'], { force: false })
    expect(entry.status).toBe('settled')
  })

  it('force 完整清理 → 标 discarded', () => {
    const { repo, entry } = makeRepoWithWorktree()
    corumCleanupLedgerEntries(repo, [entry], ['settled'], { force: true })
    expect(entry.status).toBe('discarded')
  })

  it('不在目标 status 集合的条目不被动', () => {
    const { repo, entry } = makeRepoWithWorktree()
    corumCleanupLedgerEntries(repo, [entry], ['active'], { force: true })
    expect(entry.status).toBe('settled')
    expect(existsSync(entry.path)).toBe(true)
  })
})

describe('corumIntegrationFailure — 失败报告（自述 vs 实况）', () => {
  it('含未合并分支、HEAD 前后、现场保留声明、集成者自述', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    const truth = corumIntegrationTruth(repo, [entry])
    const message = corumIntegrationFailure(truth, 'deadbeefdeadbeef', [entry], 'I merged everything and all checks passed.')
    expect(message).toContain(branch)
    expect(message).toContain('did not persist into the main tree')
    expect(message).toContain('PRESERVED')
    expect(message).toContain('NOT trusted as evidence')
    expect(message).toContain('I merged everything and all checks passed.')
  })
})

describe('corumIntegratorPersona — 破坏性 git 命令禁令', () => {
  it('禁用 reset --hard / checkout . / clean -fd / stash，并声明机制会独立复核', () => {
    const persona = corumIntegratorPersona([], [])
    expect(persona).toContain('git reset --hard')
    expect(persona).toContain('git clean -fd')
    expect(persona).toContain('independently verifies')
  })
})

describe('corumWorktreeHasUncommitted — worktree 脏判定', () => {
  it('干净 worktree → false；写入未提交 → true；目录不存在 → false', () => {
    const { worktree } = makeRepoWithWorktree()
    expect(corumWorktreeHasUncommitted(worktree)).toBe(false)
    writeFileSync(join(worktree, 'dirty.txt'), 'x')
    expect(corumWorktreeHasUncommitted(worktree)).toBe(true)
    expect(corumWorktreeHasUncommitted(join(worktree, 'nope'))).toBe(false)
  })
})

describe('corumAutoIntegrate — 声明即执行（2026-09-12 用户定调：去掉 autoIntegrate 字段）', () => {
  it('传了 merge（带 verify）→ 机制收尾', () => {
    expect(corumAutoIntegrate({ verify: 'pnpm build && ./scripts/verify-fork-drift.sh' })).toBe(true)
  })
  it('传了 merge（即使只有空对象）→ 机制收尾', () => {
    expect(corumAutoIntegrate({})).toBe(true)
  })
  it('不传 merge → 分支留给调用方，收尾走显式 subagent { integrate: true }', () => {
    expect(corumAutoIntegrate(undefined)).toBe(false)
  })
})

describe('corumReapRestoredEntries — 启动清扫（重启杀掉的僵尸子 Agent 不再永远占着 worktree）', () => {
  it('空分支 + 干净 worktree → 现场回收，条目剔除', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-reap1')
    // 空分支（worktree 建好后一个提交都没做）——重启杀掉子 Agent 的典型形态
    const kept = corumReapRestoredEntries(repo, [{ ...entry, status: 'active' }])
    expect(kept).toEqual([])
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('未提交改动 → 保留目录，条目保留（唯一副本不能丢）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree('wt-reap2')
    writeFileSync(join(worktree, 'wip.txt'), '写了一半的工作')
    const kept = corumReapRestoredEntries(repo, [{ ...entry, status: 'active' }])
    expect(kept.length).toBe(1)
    expect(existsSync(join(worktree, 'wip.txt'))).toBe(true)
  })

  it('分支有未并入 HEAD 的提交 → 保留分支与条目（那是唯一留存；目录按既有安全语义可清）', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree('wt-reap3')
    commitInWorktree(worktree, 'ORCH-REAP-3.txt')
    const kept = corumReapRestoredEntries(repo, [{ ...entry, status: 'settled' }])
    expect(kept.length).toBe(1)
    // 安全清理的既有语义：**分支**（提交的唯一留存）必须保留，目录本身可清
    // （与 cleanupOnDispose 同款——提交进了分支，工作没有丢）。
    expect(branchExists(repo, branch)).toBe(true)
    expect(existsSync(worktree)).toBe(false)
  })
})

describe('corumReconcileIntegrated — 台账认账「外包出去的合并」（2026-09-12 用户实测）', () => {
  it('分支已被合并进 HEAD（机制没参与）→ 条目翻成 integrated', () => {
    const { repo, worktree, branch, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-1.txt')
    // 主 Agent 派子 Agent 直接用 git 合并（机制不知道）
    corumGit(repo, ['-c', 'user.name=child', '-c', 'user.email=child@corum.local', 'merge', '--no-ff', '-m', 'merge(wt)', branch])
    const before = corumIntegrationTruth(repo, [entry])
    expect(before.unmerged).toEqual([]) // git 真相：已落地
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([entry.slug])
    expect(reconciled.entries[0]?.status).toBe('integrated')
  })

  it('分支未合并 → 不动（保持 settled）', () => {
    const { repo, worktree, entry } = makeRepoWithWorktree()
    commitInWorktree(worktree, 'ORCH-INT-2.txt')
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
    expect(reconciled.entries[0]?.status).toBe('settled')
  })

  it('纯空分支（tip === HEAD）→ 不翻：`--merged` 会把「什么都没干」的分支也列进来', () => {
    const { repo, branch, entry } = makeRepoWithWorktree()
    // 只建分支不提交：git branch --merged HEAD 照样列出它（fixture 的形态）
    expect(corumBranchTip(repo, branch)).toBe(corumGitHead(repo))
    expect(corumMergedBranches(repo).has(branch)).toBe(true)
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
    expect(reconciled.entries[0]?.status).toBe('settled')
  })

  it('分支不存在 → corumBranchTip undefined 且不翻（对账退化为不动）', () => {
    const { repo, entry } = makeRepoWithWorktree()
    expect(corumBranchTip(repo, 'wt/wt-nope')).toBeUndefined()
    const reconciled = corumReconcileIntegrated(repo, [{ ...entry, status: 'settled' }])
    expect(reconciled.flipped).toEqual([])
  })
})

describe('corumReapOrphanWorktrees — 台账之外的孤儿 worktree 清扫（2026-09-12 实测 10 个纯空目录）', () => {
  it('干净 + 分支对 HEAD 零新增 → 目录与分支一起回收', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-orphan1')
    expect(corumReapOrphanWorktrees(repo)).toBe(1)
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
  })

  it('分支带着独立提交 → 整个留（那是唯一留存）', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-orphan2')
    commitInWorktree(worktree, 'ORPHAN-2.txt')
    expect(corumReapOrphanWorktrees(repo)).toBe(0)
    expect(branchExists(repo, branch)).toBe(true)
    expect(existsSync(worktree)).toBe(true)
  })

  it('有未提交改动 → 留目录（重跑也不动）', () => {
    const { repo, worktree } = makeRepoWithWorktree('wt-orphan3')
    writeFileSync(join(worktree, 'wip.txt'), 'x')
    expect(corumReapOrphanWorktrees(repo)).toBe(0)
    expect(existsSync(join(worktree, 'wip.txt'))).toBe(true)
  })

  it('在册（keep 集合内）→ 不碰，即便干净无提交', () => {
    const { repo, worktree, branch } = makeRepoWithWorktree('wt-orphan4')
    expect(corumReapOrphanWorktrees(repo, new Set([worktree]))).toBe(0)
    expect(existsSync(worktree)).toBe(true)
    expect(branchExists(repo, branch)).toBe(true)
  })

  it('只扫本仓 .corum-worktrees 根下的 worktree（别人的不碰）', () => {
    const { repo } = makeRepoWithWorktree('wt-orphan5')
    const outside = join(repo, 'elsewhere', 'wt-manual')
    corumGit(repo, ['worktree', 'add', '-q', outside, '-b', 'manual/branch'])
    // 路径形态按 realpath 归一（macOS tmpdir 的 /var ↔ /private/var），只断言「是本仓
    // .corum-worktrees 下那一个」——序号与后缀足够，不锁 tmpdir 前缀。
    const listed = corumListIsolatedWorktrees(repo)
    expect(listed.length).toBe(1)
    expect(listed[0].path.endsWith(join('.corum-worktrees', 'wt-orphan5'))).toBe(true)
    expect(corumReapOrphanWorktrees(repo)).toBe(1)
    expect(existsSync(outside)).toBe(true)
  })
})
