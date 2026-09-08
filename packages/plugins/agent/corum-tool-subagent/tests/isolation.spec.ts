/**
 * fork（corum）隔离层单测：
 *   1. corumIsWriteTask — 写工具判定（readonlyResearch 恒只读、有效 deny 全覆盖才只读）；
 *   2. corumGit worktree 创建/清理 — mkdtempSync 临时 git 仓库里的 add/remove/branch -D；
 *   3. maxParallelChildren 口径 — 台账 Map 直接操作，settled 不占额度；
 *   4. corumPendingIntegration — integrate 准入（空拒绝 / settled 放行）；
 *   5. corumMarkSettled — subagent/end settle 联动（runId 精确 / childId 回退）。
 * 覆盖边界：execute 层的 cordis ctx/runtimeCtx 过重，本 spec 只测抽出的纯函数与
 * git 命令面；execute 编排由 CDP 实机验证（PLAN §5 第 10 步）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import {
  corumDetectIntegrateChecks,
  corumIntegratorPersona,
  corumEffectiveToolFilter,
  corumGit,
  corumIsWriteTask,
  corumMarkSettled,
  corumPendingIntegration,
  corumShouldIsolate,
  CorumOrchestration,
  type CorumWorktreeEntry,
} from '../src/index.ts'

const scratch = mkdtempSync(join(tmpdir(), 'corum-tool-subagent-'))
afterAll(() => { rmSync(scratch, { recursive: true, force: true }) })

function entry(overrides: Partial<CorumWorktreeEntry> = {}): CorumWorktreeEntry {
  return {
    slug: 'wt-test01',
    branch: 'wt/wt-test01',
    path: join(scratch, 'wt-test01'),
    status: 'active',
    ...overrides,
  }
}

describe('corumIsWriteTask — fork（corum）写工具判定', () => {
  it('无 toolFilter 时是写任务（denyDirectFs 默认附加 str_replace_editor 但其余写工具仍在）', () => {
    expect(corumIsWriteTask(undefined, false)).toBe(true)
  })

  it('readonlyResearch 恒只读', () => {
    expect(corumIsWriteTask(undefined, true)).toBe(false)
    expect(corumIsWriteTask({ deny: ['bash'] }, true)).toBe(false)
  })

  it('有效 deny 覆盖全部 5 个写工具时判定为只读（不触发 write-tasks 隔离）', () => {
    const denyAll = { deny: ['write', 'edit', 'bash', 'pwsh'] } // str_replace_editor 由 denyDirectFs 附加
    expect(corumIsWriteTask(denyAll, false)).toBe(false)
    const explicitAll = { deny: ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh'] }
    expect(corumIsWriteTask(explicitAll, false, false)).toBe(false)
  })

  it('只 deny 部分写工具仍是写任务', () => {
    expect(corumIsWriteTask({ deny: ['bash'] }, false)).toBe(true)
  })

  it('denyDirectFs=false 时不附加 str_replace_editor', () => {
    const filter = corumEffectiveToolFilter(undefined, false)
    expect(filter.deny).toEqual([])
    expect(corumEffectiveToolFilter({ deny: ['bash'] }, true).deny).toEqual(['bash', 'str_replace_editor'])
  })
})

describe('corumShouldIsolate — fork（corum）隔离触发', () => {
  it('always 恒隔离（只读任务也隔离）', () => {
    expect(corumShouldIsolate('always', false, false)).toBe(true)
  })
  it('write-tasks 按写任务判定（默认）', () => {
    expect(corumShouldIsolate('write-tasks', true, false)).toBe(true)
    expect(corumShouldIsolate('write-tasks', false, false)).toBe(false)
  })
  it('off 不隔离；readonlyResearch 恒不隔离', () => {
    expect(corumShouldIsolate('off', true, false)).toBe(false)
    expect(corumShouldIsolate('always', true, true)).toBe(false)
  })
})

describe('corumGit — fork（corum）worktree 创建/清理', () => {
  const repo = join(scratch, 'repo')
  const wtRoot = join(scratch, 'worktrees')

  it('git init + 初始 commit 后可 worktree add，remove + branch -D 后干净', () => {
    execFileSync('git', ['init', '-b', 'main'], { cwd: scratch, stdio: 'pipe' })
    rmSync(repo, { recursive: true, force: true })
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })

    const slug = 'wt-spec01'
    const wtPath = join(wtRoot, slug)
    const branch = `wt/${slug}`
    corumGit(repo, ['worktree', 'add', wtPath, '-b', branch])
    expect(existsSync(wtPath)).toBe(true)

    // 清理：worktree remove --force + branch -D（与 execute 的 autoCleanup 同路径）。
    corumGit(repo, ['worktree', 'remove', '--force', wtPath])
    corumGit(repo, ['branch', '-D', branch])
    expect(existsSync(wtPath)).toBe(false)
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf8' })
    expect(branches.trim()).toBe('')
  })

  it('worktree add 失败时抛错（execute 层据此回滚）', () => {
    expect(() => corumGit(repo, ['worktree', 'add', join(wtRoot, 'wt-spec02'), '-b', 'no/such/ref/..bad']))
      .toThrow()
  })
})

describe('maxParallelChildren — fork（corum）并行上限口径', () => {
  it('只计 active；settled/integrated/discarded 不占额度', () => {
    const sessionId = 'spec-session-limit'
    // fork（corum）：台账已下沉 CorumOrchestration service（红线 1），单测经
    // _testLedger() 直接操作 service 台账字段（与 execute 层同口径）。
    const orchestration = new CorumOrchestration(new Context())
    const ledger = orchestration._testLedger()
    ledger.set(sessionId, [
      entry({ slug: 'wt-a', status: 'active' }),
      entry({ slug: 'wt-b', status: 'settled' }),
      entry({ slug: 'wt-c', status: 'integrated' }),
      entry({ slug: 'wt-d', status: 'discarded' }),
    ])
    const entries = ledger.get(sessionId)!
    const activeCount = entries.filter(item => item.status === 'active').length
    // 与 execute 同判定：active >= maxParallelChildren(4) 才拒绝。
    expect(activeCount).toBe(1)
    expect(activeCount >= 4).toBe(false)
    ledger.delete(sessionId)
  })
})

describe('corumPendingIntegration — fork（corum）integrate 准入', () => {
  it('无 active/settled 条目时为空（execute 层据此拒绝）', () => {
    expect(corumPendingIntegration([])).toEqual([])
    expect(corumPendingIntegration([entry({ status: 'integrated' }), entry({ status: 'discarded', slug: 'wt-x' })]))
      .toEqual([])
  })

  it('settled 条目放行（修复第一阶段只认 active 的缺陷）', () => {
    const pending = corumPendingIntegration([
      entry({ slug: 'wt-a', status: 'settled' }),
      entry({ slug: 'wt-b', status: 'active' }),
      entry({ slug: 'wt-c', status: 'integrated' }),
    ])
    expect(pending.map(item => item.slug)).toEqual(['wt-a', 'wt-b'])
  })
})

describe('corumMarkSettled — fork（corum）subagent/end settle 联动', () => {
  it('runId 精确匹配 active 条目翻转为 settled', () => {
    const entries = [entry({ runId: 'run-1' })]
    expect(corumMarkSettled(entries, { runId: 'run-1', childId: 'child-1' })).toBe(true)
    expect(entries[0].status).toBe('settled')
  })

  it('runId 未命中时 childId 回退匹配唯一 active（continuable 登记的是 childId）', () => {
    const entries = [entry({ runId: undefined })]
    expect(corumMarkSettled(entries, { runId: 'run-unknown', childId: 'child-9' })).toBe(true)
    expect(entries[0].status).toBe('settled')
    expect(entries[0].runId).toBe('run-unknown')
  })

  it('多条无 runId 的 active 时 childId 回退拒绝猜测', () => {
    const entries = [entry({ slug: 'wt-a' }), entry({ slug: 'wt-b' })]
    expect(corumMarkSettled(entries, { childId: 'child-x' })).toBe(false)
    expect(entries.every(item => item.status === 'active')).toBe(true)
  })

  it('已非 active 的条目不再翻转', () => {
    const entries = [entry({ runId: 'run-2', status: 'settled' })]
    expect(corumMarkSettled(entries, { runId: 'run-2', childId: 'child-2' })).toBe(false)
  })
})

describe('isolation notice — fork（corum）prompt 前缀', () => {
  it('隔离召唤的 prompt 前缀包含分支名与相对路径纪律', async () => {
    // 机制验证：实机 CDP（fork-delta §11.5）——probe4 无此前缀撞沙箱、probe5 有则直写成功。
    // 这里对常量文本做静态断言，防重构时丢失关键语义。
    const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'))
    expect(src).toContain('[corum isolation]')
    expect(src).toContain('RELATIVE path only')
    expect(src).toContain('read-denied by the sandbox')
  })
})

describe('corumDetectIntegrateChecks — fork（corum）探测式默认 checks（P0-1）', () => {
  it('pnpm workspace → pnpm -r typecheck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-pnpm-'))
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    expect(corumDetectIntegrateChecks(dir)).toEqual(['pnpm -r typecheck'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('package.json scripts.typecheck → npm run typecheck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-tsc-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
    expect(corumDetectIntegrateChecks(dir)).toEqual(['npm run typecheck'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('package.json 仅 scripts.test → npm test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-test-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }))
    expect(corumDetectIntegrateChecks(dir)).toEqual(['npm test'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('均无 → git diff --check（保守兜底）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corum-checks-none-'))
    expect(corumDetectIntegrateChecks(dir)).toEqual(['git diff --check'])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('corumIntegratorPersona — fork（corum）声明式验证（2026-09-08 定调）', () => {
  const entries = [
    { slug: 'wt-aaaaaa', branch: 'wt/wt-aaaaaa', path: '/repo/.corum-worktrees/wt-aaaaaa', status: 'settled' as const },
  ]

  it('主 Agent 声明 verify → 原样注入 + 保留失败不提交约束', () => {
    const persona = corumIntegratorPersona(entries, ['git diff --check'], 'parent', 'cd studio && npm test')
    expect(persona).toContain('declared by the delegating agent')
    expect(persona).toContain('cd studio && npm test')
    expect(persona).toContain('do NOT commit')
    // 声明存在时 checks 段仍在（最低限度约束）
    expect(persona).toContain('git diff --check')
  })

  it('未声明 → 标注最低限度格式校验语义', () => {
    const persona = corumIntegratorPersona(entries, [], 'parent')
    expect(persona).toContain('did not declare')
    expect(persona).toContain('minimum bar')
    expect(persona).toContain('git diff --check')
  })

  it('merger 汇报语义：主 Agent 最终验收（final acceptance call）', () => {
    const persona = corumIntegratorPersona(entries, [], 'parent')
    expect(persona).toContain('final acceptance call')
    const mergerPersona = corumIntegratorPersona(entries, [], 'merger')
    expect(mergerPersona).toContain('verification results')
  })
})
