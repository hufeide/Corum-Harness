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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import {
  corumDetectIntegrateChecks,
  corumEntryDead,
  corumIntegratorPersona,
  corumEffectiveToolFilter,
  corumGit,
  corumIsGitRepo,
  corumIsWriteTask,
  corumMarkSettled,
  corumNarrowDenyFilter,
  corumPendingIntegration,
  corumMutationToolsForPlatform,
  corumResearchToolFilter,
  corumShouldIsolate,
  corumWriteToolsForPlatform,
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


/** 建临时 git 仓库并预建分支——台账「活条目」判定需要分支真实存在（worktree 目录可不存在）。 */
function repoWithBranch(name: string, branch: string): string {
  const repo = join(scratch, name)
  rmSync(repo, { recursive: true, force: true })
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
  corumGit(repo, ['branch', branch])
  return repo
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
  it('write-tasks 按写任务判定（默认；未给并发信号时保持旧语义）', () => {
    expect(corumShouldIsolate('write-tasks', true, false)).toBe(true)
    expect(corumShouldIsolate('write-tasks', false, false)).toBe(false)
  })
  it('off 不隔离；readonlyResearch 恒不隔离', () => {
    expect(corumShouldIsolate('off', true, false)).toBe(false)
    expect(corumShouldIsolate('always', true, true)).toBe(false)
  })
  it('并发感知（2026-09-09 用户实机反馈）：无并发不隔离、有并发才隔离', () => {
    // 单发前台写任务：没有并发 → 不建 worktree（用户报的正是这条）。
    expect(corumShouldIsolate('write-tasks', true, false, false)).toBe(false)
    // 有并发（fan-out ≥2 / 后台 / 已有在跑写子 Agent）→ 隔离。
    expect(corumShouldIsolate('write-tasks', true, false, true)).toBe(true)
    // 只读任务即使并发也不隔离。
    expect(corumShouldIsolate('write-tasks', false, false, true)).toBe(false)
    expect(corumShouldIsolate('write-tasks', false, true, true)).toBe(false)
  })
  it('always 压过并发判定（显式强制隔离）', () => {
    expect(corumShouldIsolate('always', true, false, false)).toBe(true)
  })
})

describe('CorumOrchestration — 在跑写子 Agent 计数（并发感知隔离信号④）', () => {
  it('begin/end 成对计数，归零即删表', () => {
    const orchestration = new CorumOrchestration(new Context())
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(0)
    orchestration.beginWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(1)
    orchestration.beginWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(2)
    orchestration.endWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(1)
    orchestration.endWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(0)
  })
  it('多余 end 不会出现负计数；会话之间互不串扰', () => {
    const orchestration = new CorumOrchestration(new Context())
    orchestration.endWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s1')).toBe(0)
    orchestration.beginWriteChild('s1')
    expect(orchestration.runningWriteChildrenOf('s2')).toBe(0)
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

describe('corumMarkSettled — fork（corum）并行精确匹配（2026-09-09 settle 修复）', () => {
  it('按绑定的 runId 精确翻转，只动命中条目', () => {
    const entries = [entry({ slug: 'wt-a', runId: 'run-1' }), entry({ slug: 'wt-b', runId: 'run-2' })]
    expect(corumMarkSettled(entries, { runId: 'run-2', childId: 'child-2' })).toBe(true)
    expect(entries[0].status).toBe('active')
    expect(entries[1].status).toBe('settled')
  })

  it('按 childId 命中（continuable 绑定的就是 childId）', () => {
    const entries = [entry({ slug: 'wt-a', runId: 'child-7' })]
    expect(corumMarkSettled(entries, { runId: 'run-7', childId: 'child-7' })).toBe(true)
    expect(entries[0].status).toBe('settled')
  })

  it('并行两条都未绑定时不误翻转（唯一 active 回退在 ≥2 并行时本就不成立）', () => {
    const entries = [entry({ slug: 'wt-a' }), entry({ slug: 'wt-b' })]
    expect(corumMarkSettled(entries, { runId: 'run-x', childId: 'child-x' })).toBe(false)
    expect(entries.every(item => item.status === 'active')).toBe(true)
  })
})

describe('CorumOrchestration — bindRunId + settleFromEnd（settle 修复）', () => {
  it('绑定 runId 后 settleFromEnd 精确翻转（父 Agent 经 carrier 传入）', () => {
    const repo = repoWithBranch('settle-repo-1', 'wt/wt-s1')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-settle-1'
    orchestration.addActiveEntry(sessionId, repo, {
      slug: 'wt-s1', branch: 'wt/wt-s1', path: join(repo, '.corum-worktrees', 'wt-s1'),
    })
    orchestration.bindRunId(sessionId, 'wt-s1', 'run-42')
    // 旧实现：监听端把父 Agent 当第二参数收，恒 undefined → parentAgent.session.id
    // 抛错被 emitter 吞掉，settle 从未生效（docs/TODO.md）。
    const parent = { session: { id: sessionId } } as never
    expect(orchestration.settleFromEnd({ runId: 'run-42', id: 'child-42' } as never, parent)).toBe(true)
    expect(orchestration.entriesOf(sessionId)[0].status).toBe('settled')
  })

  it('bindRunId 幂等（已绑定的条目不被覆盖）', () => {
    const repo = repoWithBranch('settle-repo-2', 'wt/wt-s2')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-settle-idem'
    orchestration.addActiveEntry(sessionId, repo, {
      slug: 'wt-s2', branch: 'wt/wt-s2', path: join(repo, '.corum-worktrees', 'wt-s2'),
    })
    orchestration.bindRunId(sessionId, 'wt-s2', 'run-first')
    orchestration.bindRunId(sessionId, 'wt-s2', 'run-second')
    expect(orchestration.entriesOf(sessionId)[0].runId).toBe('run-first')
  })

  it('carrier 缺失时经 agents 服务反查父会话（子会话 header.parentSession 兜底）', () => {
    const ctx = new Context()
    ctx.provide('agents', {
      get: (id: unknown) => id === 'child-9'
        ? { session: { header: { parentSession: 'spec-settle-2' } } }
        : undefined,
    })
    const repo = repoWithBranch('settle-repo-3', 'wt/wt-s3')
    const orchestration = new CorumOrchestration(ctx)
    orchestration.addActiveEntry('spec-settle-2', repo, {
      slug: 'wt-s3', branch: 'wt/wt-s3', path: join(repo, '.corum-worktrees', 'wt-s3'),
    })
    orchestration.bindRunId('spec-settle-2', 'wt-s3', 'run-9')
    expect(orchestration.settleFromEnd({ runId: 'run-9', id: 'child-9' } as never)).toBe(true)
    expect(orchestration.entriesOf('spec-settle-2')[0].status).toBe('settled')
  })

  it('解析不出父会话时静默返回 false（旧实现在此处抛错）', () => {
    const orchestration = new CorumOrchestration(new Context())
    expect(() => orchestration.settleFromEnd({ runId: 'r', id: 'c' } as never)).not.toThrow()
    expect(orchestration.settleFromEnd({ runId: 'r', id: 'c' } as never)).toBe(false)
  })
})

describe('corumEntryDead / entriesOf 死条目剔除（2026-09-09）', () => {
  it('worktree 目录与分支都不存在 → 死条目', () => {
    expect(corumEntryDead(scratch, { path: join(scratch, 'nope'), branch: 'wt/nope' })).toBe(true)
  })

  it('分支仍在（worktree 已回收）→ 活条目（仍可集成，不剔除）', () => {
    const repo = join(scratch, 'dead-repo')
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@corum.local'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'corum-test'], { stdio: 'pipe' })
    execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'], { stdio: 'pipe' })
    corumGit(repo, ['branch', 'wt/alive'])
    expect(corumEntryDead(repo, { path: join(repo, 'gone'), branch: 'wt/alive' })).toBe(false)
    expect(corumEntryDead(repo, { path: join(repo, 'gone'), branch: 'wt/gone' })).toBe(true)
  })

  it('entriesOf 剔除死条目（旧强删遗留不再占用 maxParallelChildren 额度）', () => {
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-dead-1'
    orchestration.addActiveEntry(sessionId, scratch, {
      slug: 'wt-dead', branch: 'wt/wt-dead', path: join(scratch, 'gone'),
    })
    expect(orchestration._testLedger().get(sessionId)?.length).toBe(1)
    expect(orchestration.entriesOf(sessionId)).toEqual([])
    expect(orchestration._testLedger().get(sessionId)?.length).toBe(0)
  })
})

describe('git 判据是运行时探测，不是产品开关', () => {
  it('产品代码里已不存在 `autoInitGit` 开关（2026-09-11 用户定调：打开工作区固定「探测，没有就初始化」）', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const reposRoot = new URL('../../../../..', import.meta.url).pathname // 仓库根（tests → 包 → agent → plugins → packages → 根）
    const walk = (dir: string): string[] => fs.existsSync(dir)
      ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          return ['node_modules', 'lib', 'dist', 'build', '.git'].includes(entry.name) ? [] : walk(full)
        }
        // 排除测试自身（它的搜索词就是 `autoInitGit` 字面量）。
        return /\.[cm]?tsx?$/.test(entry.name) && !/\.spec\.[cm]?tsx?$/.test(entry.name) ? [full] : []
      })
      : []
    const sources = [
      ...walk(path.join(reposRoot, 'packages/plugins')),
      ...walk(path.join(reposRoot, 'packages/desktop/src')),
    ]
    expect(sources.length).toBeGreaterThan(50)
    // 只看**代码**：注释里保留「为什么移除该开关」的历史说明是有价值的，
    // 不能因为注释提到这个词就让断言失败，所以先剥注释再扫。
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const offenders = sources.filter(file => stripComments(fs.readFileSync(file, 'utf8')).includes('autoInitGit'))
    expect(offenders.map(file => path.relative(reposRoot, file))).toEqual([])
  })

  it('机制侧判据是 corumIsGitRepo(cwd)（git rev-parse 探测当前工作区）', async () => {
    const fs = await import('node:fs')
    const toolSrc = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(toolSrc).toContain('corumIsGitRepo(parentCwdForRepo)')
    const providerSrc = fs.readFileSync(new URL('../../corum-subagent/src/isolated/index.ts', import.meta.url), 'utf8')
    expect(providerSrc).toContain('corumIsGitRepo(parentCwd)')
  })
})

describe('非 git 降级：强制隔离被跳过时告知子 Agent（2026-09-10 核查）', () => {
  it('工具层：跳过隔离时 prompt 追加说明；机制段不再声称 forced isolation fails loud', async () => {
    const src = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'))
    expect(src).toContain('corumIsolationSkipped')
    expect(src).toContain('this workspace is not a git repository, so isolation was skipped for this delegation')
    // 措辞与实现一致：降级而非报错。
    expect(src).toContain('even a forced `isolation: "always"` is skipped rather than failing')
    expect(src).not.toContain('on an orchestrate task fails loud')
  })
})

describe('corumIsGitRepo — 非 git 工作区降级 + 手动 git init 后可恢复（2026-09-10 核查）', () => {
  it('非 git 目录判 false；`git init` 后同进程内再判为 true（负结果不再缓存）', () => {
    // 注意：scratch 本身在本文件的另一个用例里被 `git init` 过（line ~142），
    // 所以非 git 场景必须用 scratch 之外的临时目录（git 会向上层查找仓库）。
    const dir = mkdtempSync(join(tmpdir(), 'corum-late-git-'))
    // 用户关掉「新工作区自动 git init」→ 首次派遣时判非 git，机制自动降级。
    expect(corumIsGitRepo(dir)).toBe(false)
    // 用户随后手动 git init：同进程内必须立刻恢复（此前负结果被永久缓存）。
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' })
    expect(corumIsGitRepo(dir)).toBe(true)
  })
})

describe('isolation notice — fork（corum）prompt 前缀', () => {
  it('通知文本单一事实源在编排包，工具层与 isolated provider 都引用它', async () => {
    // 机制验证：实机 CDP（fork-delta §11.5）——probe4 无此前缀撞沙箱、probe5 有则直写成功。
    // 2026-09-10：文本下沉到 @corum/corum-orchestration（工具层 + provider 共用），
    // 这里断言「文本语义 + 两个消费点都走 helper」，防重构时丢失或分叉。
    const fs = await import('node:fs')
    const orchestrationSrc = fs.readFileSync(new URL('../../corum-orchestration/src/orchestration.ts', import.meta.url), 'utf8')
    expect(orchestrationSrc).toContain('[corum isolation]')
    expect(orchestrationSrc).toContain('RELATIVE path only')
    // 2026-09-09 措辞更正：沙箱只拒写（读仍允许），旧文本的 read-denied 是错的。
    expect(orchestrationSrc).toContain('write-denied by the sandbox')
    expect(orchestrationSrc).toContain('reads are still allowed')
    expect(orchestrationSrc).toContain('export function corumIsolationNotice')
    const toolSrc = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(toolSrc).toContain('corumIsolationNotice(child)')
    expect(toolSrc).toContain('corumDirectWriteNotice()')
    const providerSrc = fs.readFileSync(new URL('../../corum-subagent/src/isolated/index.ts', import.meta.url), 'utf8')
    // 2026-09-10：provider 直接引用编排包的 helper（不再自持副本）。
    expect(providerSrc).toContain('corumIsolationNotice(child)')
    expect(providerSrc).toContain('corumDirectWriteNotice()')
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

describe('corumResearchToolFilter — fork（corum）research 只读硬约束', () => {
  it('readonlyResearch=false 返回 undefined（不补 deny）', () => {
    expect(corumResearchToolFilter(undefined, false)).toBeUndefined()
    expect(corumResearchToolFilter({ deny: ['bash'] }, false)).toBeUndefined()
  })

  // fork（corum）2026-09-12 用户定调：research **开放 shell**（调研必须能跑命令），
  // 只读性改由子会话沙箱（readonlySandbox → read-only）保证——工具面只 deny 变异工具。
  it('research=true + 无 toolFilter → deny 变异工具，但**保留 shell**', () => {
    const filter = corumResearchToolFilter(undefined, true)
    for (const tool of corumMutationToolsForPlatform()) {
      expect(filter?.deny).toContain(tool)
    }
    expect(filter?.deny).not.toContain('bash')
    expect(filter?.deny).not.toContain('pwsh')
  })

  it('research=true + 部分 deny → 补全缺失的变异工具（不动 shell）', () => {
    const filter = corumResearchToolFilter({ deny: ['write'] }, true)
    for (const tool of corumMutationToolsForPlatform()) {
      expect(filter?.deny).toContain(tool)
    }
    expect(filter?.deny).not.toContain('bash')
  })

  it('research=true + 已全 deny → 返回 undefined（幂等，不重复）', () => {
    const allDeny = { deny: [...corumMutationToolsForPlatform()] }
    expect(corumResearchToolFilter(allDeny, true)).toBeUndefined()
  })

  it('allow 保持 config 原值（只读任务不扩权）', () => {
    const filter = corumResearchToolFilter({ allow: ['grep', 'glob'], deny: ['bash'] }, true)
    expect(filter?.allow).toEqual(['grep', 'glob'])
  })
})

describe('corumNarrowDenyFilter — fork（corum）deny 收敛到已注册工具（2026-09-10 官方 preset 全崩修复）', () => {
  const known = new Set(['read', 'write', 'edit', 'bash'])

  it('未知名从 deny 中剔除，已注册名保留（str_replace_editor 不在官方 preset）', () => {
    // 实机根因：官方 standard/ptc/cordis 挂 write/edit 不挂 str_replace_editor，
    // 机制追加的 deny 含未知名 → tools.restrict() fail-loud → 子 Agent 创建失败。
    expect(corumNarrowDenyFilter({ deny: ['str_replace_editor', 'write', 'edit', 'bash'] }, known))
      .toEqual({ deny: ['write', 'edit', 'bash'] })
  })

  it('deny 全部命中时原样返回（引用不变，避免无谓复制）', () => {
    const filter = { deny: ['write', 'bash'] }
    expect(corumNarrowDenyFilter(filter, known)).toBe(filter)
  })

  it('deny 全被剔除且无 allow → undefined（等于不限制）', () => {
    expect(corumNarrowDenyFilter({ deny: ['str_replace_editor'] }, known)).toBeUndefined()
  })

  it('deny 全被剔除但有 allow → 只留 allow（不把只读实例变成无限制）', () => {
    expect(corumNarrowDenyFilter({ allow: ['grep'], deny: ['str_replace_editor'] }, known))
      .toEqual({ allow: ['grep'], deny: [] })
  })

  it('allow 名单不收敛（写错的 allow 必须继续 fail-loud）', () => {
    expect(corumNarrowDenyFilter({ allow: ['no_such_tool'] }, known)).toEqual({ allow: ['no_such_tool'] })
  })

  it('无 deny / undefined 原样返回', () => {
    expect(corumNarrowDenyFilter(undefined, known)).toBeUndefined()
    const allowOnly = { allow: ['read'] }
    expect(corumNarrowDenyFilter(allowOnly, known)).toBe(allowOnly)
  })
})

describe('CorumOrchestration.discardEntry — fork（corum）spawn 失败回滚（2026-09-10 泄漏修复）', () => {
  it('强清理 worktree + 分支并移除台账条目（active 泄漏会占额度并恒判并发）', () => {
    const repo = repoWithBranch('discard-repo-1', 'wt/wt-d1')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-discard-1'
    const wtPath = join(repo, '.corum-worktrees', 'wt-d1')
    execFileSync('git', ['-C', repo, 'worktree', 'add', wtPath, 'wt/wt-d1'], { stdio: 'pipe' })
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-d1', branch: 'wt/wt-d1', path: wtPath })

    orchestration.discardEntry(sessionId, 'wt-d1')

    expect(orchestration.entriesOf(sessionId)).toEqual([])
    expect(orchestration._testLedger().get(sessionId)).toEqual([])
    expect(existsSync(wtPath)).toBe(false)
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'wt/wt-d1'], { encoding: 'utf8' })
    expect(branches.trim()).toBe('')
  })

  it('已绑定 runId 的条目不回滚（那条 run 真实存在，settle 路径负责它）', () => {
    const repo = repoWithBranch('discard-repo-2', 'wt/wt-d2')
    const orchestration = new CorumOrchestration(new Context())
    const sessionId = 'spec-discard-2'
    const wtPath = join(repo, '.corum-worktrees', 'wt-d2')
    execFileSync('git', ['-C', repo, 'worktree', 'add', wtPath, 'wt/wt-d2'], { stdio: 'pipe' })
    orchestration.addActiveEntry(sessionId, repo, { slug: 'wt-d2', branch: 'wt/wt-d2', path: wtPath })
    orchestration.bindRunId(sessionId, 'wt-d2', 'run-live')

    orchestration.discardEntry(sessionId, 'wt-d2')

    expect(orchestration.entriesOf(sessionId).map(item => item.slug)).toEqual(['wt-d2'])
    expect(existsSync(wtPath)).toBe(true)
  })

  it('未知 slug 静默 no-op（无隔离的 spawn 失败路径）', () => {
    const orchestration = new CorumOrchestration(new Context())
    expect(() => orchestration.discardEntry('spec-discard-3', 'wt-none')).not.toThrow()
  })
})
