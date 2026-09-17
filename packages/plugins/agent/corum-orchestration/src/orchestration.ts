/**
 * fork（corum）：子 Agent 编排器——隔离台账状态 + worktree 编排的单一事实源
 * （docs/plan/PLAN-subagent-orchestration.md §5）。
 *
 * 从 fork #10 `index.ts` 的 execute 层下沉：
 * - **台账状态**：`corumWorktreeLedger`（模块级 Map，红线 1 禁止形态）→
 *   `CorumOrchestration` service 实例字段（cordis 根上下文 provide，跨 bundle
 *   单例）。同时是 §11.9 台账持久化的前置（service 可持有持久化句柄）。
 * - **纯函数**：写任务判定/隔离触发/准入/结算/persona 拼装/git 命令/worktree
 *   清理——全部移入本模块，`index.ts` 从中 re-export 保持对外 API 兼容（单测
 *   import 路径不变）。
 *
 * 消费方：fork #10 工具（当前，经 service 调用保持行为等价）→ Phase 2 的
 * `orchestrate` 工具（任务清单语义）。
 *
 * 2026-09 重构 1：本文件从 @corum/corum-tool-subagent 整体迁入独立包
 * @corum/corum-orchestration（挂载方式：新包自己挂 cordis 行 provide，见本包
 * index.ts）。
 *
 * @module @corum/corum-orchestration/orchestration
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
// fork（corum）：git 机制归一到 git-core 核心插件（用户 2026-09-16 策略「所有 git 管理
// 收进一个独立插件」）——收口强制提交的底层原语 settleCommit 由 git-core 提供，
// 本包不再自实现 `git add/commit`（消除与 corumCommitWorktreeOnSettle 的重复实现）。
import { settleCommit as gitCoreSettleCommit } from '@corum/corum-git-core/git-primitives'

/**
 * `subagent/end` 载荷的**局部窄化形**（只取本包用到的两个字段）。
 *
 * 为什么不用官方 `SubagentRunEndInfo`：`import type ... from '@deepseek-ai/dsh-subagent'`
 * 会把**发布版**的 d.ts 拉进编译图，而发布版与本仓 fork（`@corum/corum-subagent`）各自
 * `declare module '@deepseek-ai/cordis' { subagents: SubagentRuntime }`——两份同名属性
 * 来自不同来源的同名类型 → 任何 consumer 只要 import 本包就报 TS2717，编译不过
 * （2026-09-11 实测：corum-subagent 加一行 import 就被这个卡住）。
 * 与文件内既有做法一致（红线 3：跨包类型用局部能力接口收窄，不耦合官方实现包）。
 */
interface CorumSubagentEndInfo {
  /** 与配对 start 事件共享的 run 身份。 */
  readonly runId: unknown
  /** 子 Agent 的会话 id。 */
  readonly id: unknown
}


// ── 台账类型与事件 ─────────────────────────────────────────────────────────

/** fork（corum）：会话级隔离台账条目（settled 不占 maxParallelChildren 额度）。 */
export interface CorumWorktreeEntry {
  readonly slug: string
  readonly branch: string
  readonly path: string
  status: 'active' | 'settled' | 'integrated' | 'discarded'
  /** settle 关联键——subagent/start|end 事件的 runId（session 级去重）。 */
  runId?: string
  /** fork（corum）：子会话 id（与 runId 同值；浮层行点击 → 进入子会话）。 */
  childSessionId?: string
  /**
   * fork（corum）：现场（worktree 目录 + 分支）是否已被回收。
   *
   * 只在**完整清理成功**后置 true（`corumCleanupWorktree` 返回 true）。
   * 用途：把「工作已进主树、现场已回收」与「未集成就被丢弃」在 UI 上分开——
   * 前者是 `integrated + reclaimed`（显示「已集成 · 现场已回收」），后者才是 `discarded`
   * （「已丢弃」）。2026-09-12 用户实测：机制集成成功+清理后条目落成 discarded，
   * 折叠行写成「已集成 0 · 已丢弃 1」，看着像把成功的工作扔了。
   */
  reclaimed?: boolean
  /**
   * fork（corum）：分支创建点（`git worktree add -b` 那一刻的 HEAD）。
   *
   * 对账判据的一部分：`tip === base` 说明这条分支**一个提交都没做**——空分支在
   * `git branch --merged HEAD` 里与「真合并过的分支」同形（main 往前走一步就认不出），
   * 不设防就会把「什么都没干、甚至是还在跑」的条目签收成 `integrated`。
   */
  base?: string
}

/** 台账快照的一帧：某父会话的 worktree 条目全量投影（renderer 直接渲染）。 */
export interface CorumWorktreeLedgerFrame {
  readonly sessionId: string
  readonly entries: readonly CorumWorktreeEntry[]
  /** 待集成 = active+settled。 */
  readonly pending: number
}

// fork（corum）：台账快照事件（renderer「并行工作区」chip 订阅源）。
// cordis Events 合并声明自包含（与 corum-api-remotes 转发 allowlist 配套）。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'corum/worktree-ledger': (frame: CorumWorktreeLedgerFrame) => void
  }
}

// ── 台账持久化（Phase 4：§11.9 遗留决策项①落盘）───────────────────────────

/** 持久化的一条会话台账：worktree 条目 + 父 cwd（重启恢复孤儿 worktree 识别）。 */
export interface CorumLedgerRecord {
  /** 父会话 cwd（dispose/restart 清理时定位 git 主干）。 */
  readonly cwd: string
  /** 待集成条目（active/settled；integrated/discarded 已清理，不落盘）。 */
  readonly entries: readonly CorumWorktreeEntry[]
}

/** 台账 record zod schema（落盘边界校验）。 */
const corumLedgerRecordSchema = z.object({
  cwd: z.string(),
  entries: z.array(z.object({
    slug: z.string(),
    branch: z.string(),
    path: z.string(),
    status: z.enum(['active', 'settled', 'integrated', 'discarded']),
    runId: z.string().optional(),
    childSessionId: z.string().optional(),
    base: z.string().optional(),
    reclaimed: z.boolean().optional(),
  })),
}) as unknown as z.ZodType<CorumLedgerRecord>

/** fork（corum）：编排台账 domain（单表 ledger，key=sessionId）。 */
export const corumOrchestrationDomainSpec = defineDomain({
  name: 'corum_orchestration',
  version: 1,
  layout: 'per-record',
  tables: {
    ledger: domainTable<string, CorumLedgerRecord>(corumLedgerRecordSchema),
  },
})

// ── 纯函数（无状态；单测直接测，语义与 fork #10 逐字一致）──────────────────

/** fork（corum）：写工具清单——按工具面判定写任务（§2 逐字核实）。 */
const CORUM_MUTATION_TOOLS = ['str_replace_editor', 'write', 'edit']
const CORUM_SHELL_TOOLS = ['bash', 'pwsh']
const CORUM_WRITE_TOOLS = [...CORUM_MUTATION_TOOLS, ...CORUM_SHELL_TOOLS]

/**
 * fork（corum）：平台实际存在的写工具（deny 名单只能包含已注册工具——
 * tools.restrict 对未知名 fail loud。pwsh 仅在 win32 装载）。与 corum-agent
 * compile.ts 的 corumWriteToolsForPlatform 逐字对账（dev-conventions §4a 第 2 条
 * 两处对账）。orchestrate 任务级 research 的只读硬约束用它预 deny 写工具。
 */
/**
 * 本平台的「写/执行」工具名清单（**可能含未装载的名字**，如 `str_replace_editor`
 * 在 corum preset 里已退场）。
 *
 * 纪律（2026-09-12 事故后补）：本清单只表达**意图**，落到 `tools.restrict()` 之前
 * **必须**先按目标 scope 真实可见的工具名收敛（`corumNarrowDenyFilter` /
 * `corum-subagent` 的 `narrowChildToolFilter`）——`tools.restrict()` 对未知名
 * fail-loud，直接拿本清单去 restrict 会让整次派遣抛错（实测：`subagent_research`
 * 100% 失败，表现为「指挥者发两份重复的子 Agent」）。
 */
export function corumWriteToolsForPlatform(): readonly string[] {
  return process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(tool => tool !== 'pwsh')
}

/**
 * fork（corum）：只读研究子 Agent 要 deny 的**变异**工具（2026-09-12 用户定调）。
 *
 * 为什么与 {@link corumWriteToolsForPlatform} 分开：用户要求「research 需要开放 shell
 * 来执行命令完成调研」——调研常常必须跑命令（`git log`、读 PID 文件、跑 verify 脚本的
 * status）。此前 research 与写子 Agent 共用同一份 deny 名单（含 bash），于是研究子
 * Agent 连 `git status` 都跑不了，只能靠磁盘证据推断（实机报告原文：「本会话无
 * bash/write 工具」）。现在 research **允许 shell、只 deny 变异工具**，只读性由
 * **子会话沙箱钉成 `read-only`** 保证（见 corum-subagent 的 `readonlySandbox`）——
 * 工具面与文件效果两层分工：工具面禁写文件，沙箱层禁写文件系统。
 * @returns 本平台上的变异工具名（research 的 deny 名单）。
 */
export function corumMutationToolsForPlatform(): readonly string[] {
  return process.platform === 'win32' ? CORUM_MUTATION_TOOLS : CORUM_MUTATION_TOOLS
}

/** fork（corum）：git 命令同步执行（父会话 header.cwd 下）。 */
export function corumGit(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/**
 * fork（corum）：目录是否 git 仓库（含 worktree/子目录——`git rev-parse --git-dir`
 * 在仓库任意子目录都成功；git 未安装/目录不可读/非仓库均返回 false）。
 *
 * 用途（2026-09-09 用户需求）：非 git 工作区自动降级——子 Agent 编排的隔离
 * （worktree）/ 声明式 verify / integrate 全部依赖 git 仓库，非 git 目录下
 * `git worktree add` 直接报 `fatal: not a git repository`（实测 ai-lab 工作区）。
 * spawnOne 在隔离判定前用本函数侦测父 cwd，非 git 时强制不隔离（git 依赖能力
 * 自动关闭，不再报错）。带 Map 缓存（同一会话反复 spawn 不重复 fork git）。
 */
const corumGitRepoCache = new Set<string>()
export function corumIsGitRepo(cwd: string): boolean {
  // 2026-09-10：只缓存**肯定结果**。此前负结果也缓存——用户关掉「新工作区自动
  // git init」后手动 `git init`，同一进程内会一直判非 git（隔离/git 能力永不启用）。
  // 非 git 的探测成本很低（一次 git rev-parse 失败），且失败路径只在派遣时走一次。
  if (corumGitRepoCache.has(cwd)) return true
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'pipe' })
    corumGitRepoCache.add(cwd)
    return true
  } catch {
    return false
  }
}

// ── git 实况探测（机制真值门禁的判定面）─────────────────────────────────────

/**
 * fork（corum）：脏主树/未提交场景的**集成 diff 口**（2026-09-14 用户同意 B 条）。
 *
 * 解决什么：主树可能有与本轮无关的未提交在制品，集成者按纪律**不许**动它
 * （`corumIntegratorPersona` 明禁 reset/checkout/clean/stash），而 `git merge`
 * 在一棵脏树上既可能被拒、又可能拒绝得不明不白。这条口把「分支带来的改动」直接
 * 落到主树 HEAD 上，完全不碰主树工作区：**临时 index 上试三方**（不改工作区、
 * 不建 git 状态），成功才真提交。
 *
 * 三步：
 *   ① `GIT_INDEX_FILE=<tmp> git read-tree HEAD` + `git diff <base>..<branch> |
 *      git apply --cached --3way` —— 在**临时 index** 上试三方；冲突以非零退出，
 *      工作区与主 index 一个字节都没动（2026-09-14 实测：冲突时工作区文件的
 *      `git status` 仍是干净的）。
 *   ② 试合成功 → 由临时 index 写树、`commit-tree` 提交，`update-ref` 推进 HEAD。
 *      **不 checkout**：主树工作区的在制品原样保留。
 *   ③ 主树当前 HEAD 必须仍是本地记录的分支，且工作区无改动，否则拒绝（绝不在
 *      未知状态上推 ref）。
 *
 * 仍然受「机制真值门禁」约束：本函数**只负责让分支的工作进 HEAD**，集成是否算
 * 成功一律由 {@link corumIntegrationTruth} 按 git 实况判定，不放宽任何门禁——
 * 落不了就是失败，现场保留，报告里给 git 实况。
 *
 * base 缺失时退化为分支与 HEAD 的分叉点。纯 git、无 cordis 依赖，可单测。
 * @param cwd - 主树工作目录。
 * @param entry - 待集成的隔离条目（读 `branch`；`base` 可选，作为 diff 起点）。
 * @param message - 落地提交的信息（缺省时用分支名）。
 * @returns 落盘结果——`applied` 为真表示分支的工作已在 HEAD 上。
 */
export function corumPortBranchDiff(
  cwd: string,
  entry: Pick<CorumWorktreeEntry, 'branch' | 'base'>,
  message?: string,
): { applied: boolean; base: string; patchBytes: number; head: string; error?: string } {
  const fail = (error: string, base = '', patchBytes = 0): { applied: boolean; base: string; patchBytes: number; head: string; error: string } =>
    ({ applied: false, base, patchBytes, head: corumGitHead(cwd), error })
  const base = entry.base !== undefined && entry.base !== ''
    ? entry.base
    : corumMergeBase(cwd, entry.branch)
  if (base === '') return fail(`cannot resolve a diff base for branch ${entry.branch}`)
  let patch = ''
  let touched: string[] = []
  try {
    // 只取该分支自己的改动；`--binary` 让二进制产物也能过。
    patch = execFileSync('git', ['diff', '--binary', `${base}..${entry.branch}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    touched = execFileSync('git', ['diff', '--name-only', `${base}..${entry.branch}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map(line => line.trim()).filter(line => line !== '')
  } catch (error: unknown) {
    return fail(corumGitErrorText(error), base)
  }
  if (patch.trim() === '') {
    // 分支相对 base 没有文本改动（例如只改了被忽略的产物）——不是错误。
    return fail('branch adds no diff against its base', base)
  }
  // 落盘只动 HEAD（工作区一个字节都不碰），所以主树**有**未提交在制品本身不是
  // 阻塞——那正是这条口存在的场景。唯一的真冲突是「分支要改的文件在主树里也有
  // 未提交改动」：那时推进 HEAD 会留下一个说不清谁覆盖谁的现场。此时拒绝并点名。
  const dirtyPaths = new Set(
    corumGitStatusPorcelain(cwd).split('\n').map(line => line.trim()).filter(line => line !== '')
      .map(line => line.replace(/^..\s+/, '').replace(/^.*\s->\s/, '').replace(/^"|"$/g, '')),
  )
  const clash = touched.filter(file => dirtyPaths.has(file))
  if (clash.length > 0) {
    return fail(
      `main tree has uncommitted changes to file(s) this branch also changes: ${clash.slice(0, 5).join(', ')} — commit or stash them first, then port`,
      base,
      patch.length,
    )
  }
  const indexPath = path.join(mkdtempSync(path.join(tmpdir(), 'corum-port-index-')), 'index')
  try {
    const withIndex = <T,>(args: string[], input?: string): string =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        input,
        env: { ...process.env, GIT_INDEX_FILE: indexPath },
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    withIndex(['read-tree', 'HEAD'])
    withIndex(['apply', '--cached', '--3way', '--whitespace=nowarn', '-'], patch)
    const tree = withIndex(['write-tree']).trim()
    const parent = corumGitHead(cwd)
    if (parent === '') return fail('cannot resolve the main tree HEAD', base, patch.length)
    const summary = message !== undefined && message.trim() !== ''
      ? message.trim()
      : `port ${entry.branch}: ${touched.length} file(s)`
    const commit = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', summary], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    // HEAD 在试合期间不能被别人推进（同一进程内的集成是串行的，这里只是防御）。
    if (corumGitHead(cwd) !== parent) return fail('main tree HEAD moved while porting', base, patch.length)
    corumGit(cwd, ['update-ref', 'HEAD', commit, parent])
    // 只推 HEAD 不碰工作区，于是工作区现在「落后于 HEAD」：把**只有本次落盘新增的
    // 路径**同步到工作区，否则主树看起来缺文件（集成者的 verify 会跑在缺文件的树上）。
    // 只对「本来就在工作区、且是这次落盘产生的差异」动手，绝不做全树 checkout——
    // 主树的无关在制品必须一字不动。
    corumSyncPortedPathsToWorktree(cwd, parent, commit)
    return { applied: true, base, patchBytes: patch.length, head: commit }
  } catch (error: unknown) {
    return fail(corumGitErrorText(error), base, patch.length)
  } finally {
    rmSync(path.dirname(indexPath), { recursive: true, force: true })
  }
}

/**
 * fork（corum）：把刚落盘提交带来的**文件集合变化**同步进工作区（`corumPortBranchDiff` 的内部收尾）。
 *
 * 为什么需要：口子只推 HEAD，工作区因此会停在旧内容上（新文件在 HEAD 里、不在磁盘；
 * 上游改过的文件在工作区里是旧版本）。集成者随后的 verify 跑在这棵树上就会测错东西。
 *
 * 边界（不做全树 checkout 的原因）：只对「前一个 HEAD 与刚落盘 HEAD 的差异」做 checkout
 * ——那恰好是本次落盘新增/修改的路径；主树里与它们无关的在制品不受影响。若某路径在
 * 工作区里也有未提交改动，本函数按路径 checkout 会覆盖它，所以调用方已在上游用
 * `touched ∩ dirty` 把这种情况挡掉（见 `clash`）。
 * @param cwd - 主树工作目录。
 * @param before - 落盘前的主树 HEAD。
 * @param head - 刚落盘的提交。
 */
function corumSyncPortedPathsToWorktree(cwd: string, before: string, head: string): void {
  let paths: string[] = []
  try {
    paths = execFileSync('git', ['diff', '--name-only', before, head], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).split('\n').map(line => line.trim()).filter(line => line !== '')
  } catch {
    return
  }
  for (const file of paths) {
    try {
      corumGit(cwd, ['checkout', head, '--', file])
    } catch {
      // 单文件同步失败不改变「工作已进 HEAD」这个事实：真值门禁按 HEAD 判定。
    }
  }
}

/** fork（corum）：分支与 HEAD 的分叉点（无共同祖先/git 失败返回空串）。 */
export function corumMergeBase(cwd: string, branch: string): string {
  try {
    return execFileSync('git', ['merge-base', 'HEAD', branch], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return ''
  }
}

/** fork（corum）：把 execFileSync 的失败收成一行可读文本（stderr 优先，缺则 message）。 */
function corumGitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: Buffer | string } | undefined)?.stderr
  const text = stderr === undefined ? '' : String(stderr).trim()
  if (text !== '') return text.split('\n').slice(0, 4).join(' | ')
  return error instanceof Error ? error.message : String(error)
}

/** fork（corum）：主树 HEAD（集成前后推进/祖先判定用；git 不可用返回空串）。 */
export function corumGitHead(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    return ''
  }
}

/** fork（corum）：主树未提交改动（porcelain 原文；git 不可用返回空串）。 */
export function corumGitStatusPorcelain(cwd: string): string {
  try {
    return execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', stdio: 'pipe' })
  } catch {
    return ''
  }
}

/**
 * fork（corum）：分支是否已并入 HEAD（`git merge-base --is-ancestor` 退出码 0）。
 * 用于**清理安全阀**——未并入 HEAD 的分支是那批工作的唯一留存，绝不 `branch -D`。
 */
export function corumBranchMerged(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * fork（corum）：分支的工作是否已进入 HEAD——祖先关系 **或** patch 等价
 * （`git cherry HEAD <branch>` 无 `+` 行，覆盖集成者用 cherry-pick 等价落地的情况）。
 * 无新提交的分支返回 true（空 cherry 输出）；分支不存在/git 不可用返回 false。
 */
export function corumBranchIntegrated(cwd: string, branch: string): boolean {
  if (corumBranchMerged(cwd, branch)) return true
  try {
    const out = execFileSync('git', ['cherry', 'HEAD', branch], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return out.split('\n').every(line => !line.startsWith('+'))
  } catch {
    return false
  }
}

/** fork（corum）：worktree 是否有未提交改动（目录已不存在 → false）。 */
export function corumWorktreeHasUncommitted(worktreePath: string): boolean {
  if (!existsSync(worktreePath)) return false
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim() !== ''
  } catch {
    return false
  }
}

/**
 * fork（corum）：**隔离前置校验 —— 父树必须干净**（2026-09-15 机制补漏，用户裁定「严格」）。
 *
 * 由来（真实事故，用户 2026-09-15 亲述）：子 Agent 的「Integrate BEFORE evidence branch」失败，
 * 根因是**派发前父树的改动未提交**。机制链条：
 * `git worktree add <path> -b <branch>`（**不指定 base**）⇒ git 默认**从 HEAD 建分支**；
 * 而父工作树的未提交改动**只存在于工作树、不在任何提交里** ⇒ **隔离子看不到它们**。
 * 实证（2026-09-15）：在父树改过的 `theme.css` 里 grep 新增值 `1D112B9E`——
 * **父树命中 1、worktree 命中 0**；隔离子实际工作在旧 HEAD，代码基不含父树那批改动。
 * ⇒ 子会在**过时的树**上开发/验证，**并可能报告成功**（静默失真，比显式失败更危险）。
 *
 * **判据取「严格」档**（用户 2026-09-15 裁定）：`porcelain` **任何**一行都拦，**含 untracked `??`**。
 * 理由：**子的树必须等于父的树**——untracked 的**新源码**同样致命（若父树有新文件未提交，
 * 子会缺这个文件而构建失败或行为不同）。
 *
 * @param parentCwd - 父工作树目录。
 * @returns 拒绝原因（可直接抛给调用方的多行文本）；干净或 git 不可用时返回 `undefined`。
 */
export function corumDirtyParentRefusal(parentCwd: string): string | undefined {
  const porcelain = corumGitStatusPorcelain(parentCwd)
  if (porcelain === '') return undefined
  const lines = porcelain.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return undefined
  const shown = lines.slice(0, 5).map((line) => `  ${line}`).join('\n')
  const more = lines.length > 5 ? `\n  …and ${lines.length - 5} more` : ''
  return [
    `isolation refused: the parent working tree has ${lines.length} uncommitted change(s) in ${parentCwd}`,
    shown + more,
    'An isolated child branches off HEAD, so it CANNOT see uncommitted work: it would develop and',
    'verify against a stale tree and may report success while the parent state differs.',
    'Commit (or stash) the parent changes first, then retry the delegation.',
  ].join('\n')
}

/** fork（corum）：收口强制提交的结果（失败原因**结构化**，供上层投递给模型）。 */
export interface CorumSettleCommitFailure {
  readonly slug: string
  readonly path: string
  /** 可读的失败原因（git stderr 摘要或异常文本）。 */
  readonly reason: string
}

/** 机制自动提交的提交信息（可识别，**不冒充** Agent 的提交）。 */
export const CORUM_AUTO_COMMIT_SUBJECT = 'wip(isolated): auto-commit on settle'

/**
 * fork（corum）：**收口强制提交** —— 把 worktree 里未提交的改动就地提交（2026-09-15 机制补漏）。
 *
 * 用户 2026-09-15 裁定：「一旦做成基于 git worktree 的隔离分支形式，**无论如何每次工作结束
 * Agent 必须提交**，这一点要在**机制上保证**，而**不是 Agent 自己决定是否要提交**」。
 * ⇒ 因此这里**由机制执行**：收口前把「未提交」这一态消灭掉，而不是发个提醒等 Agent 自觉。
 *
 * 提交发生在**隔离分支**上（我们自己的分支，不是用户的主干历史）⇒ 安全且必要：
 * 那些提交是该分支工作的**唯一副本**（既有代码注释原话：nobody sees them otherwise）。
 * 顺带修好一个既有问题：`reconcileAndReclaim` 与 `corumCleanupWorktree` 在 worktree 脏时
 * **跳过回收/保留现场**，于是留下孤儿目录；自动提交后这一态不再出现。
 *
 * @param worktreePath - 目标 worktree 目录。
 * @param slug - 台账条目的 slug（进提交信息，便于追责与检索）。
 * @returns `undefined` = 成功或无需提交（干净/目录不存在/非 git）；否则为**结构化失败原因**。
 */
export function corumCommitWorktreeOnSettle(
  worktreePath: string,
  slug: string,
): CorumSettleCommitFailure | undefined {
  // fork（corum）：实现委托给 git-core 核心插件的 settleCommit 原语（用户 2026-09-16 策略
  // 「所有 git 管理收进一个独立插件」）——本包不再自跑 git add/commit，只把 worktree 语境
  // （slug 溯源 + 提交信息）适配到原语；返回值保持 { slug, path, reason } 兼容既有调用方。
  const failure = gitCoreSettleCommit(
    worktreePath,
    CORUM_AUTO_COMMIT_SUBJECT +
      `\n\nIsolated worktree ${slug} still had uncommitted changes at settle; the mechanism committed them` +
      ' so that no isolated work can be lost (user rule 2026-09-15: a work round must end committed).',
  )
  if (failure === undefined) return undefined
  return { slug, path: worktreePath, reason: failure.reason }
}

/**
 * fork（corum）：一次性读出「已并入 HEAD 的分支名」集合（单条 git 命令）。
 * @param cwd - 主树工作目录。
 * @returns 分支短名集合；git 不可用/失败时返回空集合（对账退化为「什么都不翻」）。
 */
export function corumMergedBranches(cwd: string): Set<string> {
  try {
    const out = execFileSync('git', ['branch', '--merged', 'HEAD', '--format=%(refname:short)'], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    return new Set(out.split('\n').map(line => line.trim()).filter(line => line !== ''))
  } catch {
    return new Set()
  }
}

/** fork（corum）：realpath（macOS 的 /var → /private/var 符号链接会让前缀/相等比较失配）。 */
function corumRealPath(p: string): string {
  try { return realpathSync(p) } catch { return p }
}

/** fork（corum）：分支是否带着 HEAD 之外的提交（true = 有独立工作，不能删）。 */
export function corumBranchAddsCommits(cwd: string, branch: string): boolean {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `HEAD..${branch}`], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return Number.parseInt(out.trim(), 10) > 0
  } catch {
    // 分支不存在/git 失败：当作「有独立工作」保守处理，绝不动它。
    return true
  }
}

/**
 * fork（corum）：列出**本仓自己的**隔离 worktree（`<cwd>/.corum-worktrees/*`）。
 *
 * 只认这个根下的路径——别人的 worktree（用户手动建的、别的工具的）一律不进清扫面。
 * @param cwd - 主树工作目录。
 * @returns `{ path, branch }` 列表（git 失败返回空数组）。
 */
export function corumListIsolatedWorktrees(cwd: string): { path: string; branch: string }[] {
  const root = `${corumRealPath(path.resolve(cwd, '.corum-worktrees'))}${path.sep}`
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8', stdio: 'pipe' })
    const items: { path: string; branch: string }[] = []
    let current: string | undefined
    for (const raw of out.split('\n')) {
      const line = raw.trimEnd()
      if (line.startsWith('worktree ')) { current = line.slice('worktree '.length).trim(); continue }
      if (line.startsWith('branch ') && current !== undefined) {
        const branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
        items.push({ path: current, branch })
        current = undefined
      }
    }
    return items.filter(item => corumRealPath(item.path).startsWith(root))
  } catch {
    return []
  }
}

/**
 * fork（corum）：**孤儿 worktree 清扫**——台账已经不记得、也没有留存价值的隔离工作区。
 *
 * 为什么需要（2026-09-12 实测）：台账记录在「没有待集成条目」时会被删掉，而子 Agent
 * 被进程退出杀掉时永远不会 settle → worktree 与分支留在磁盘上**没有任何记录引用它们**，
 * 之后的对账/懒剔除都碰不到（本仓实测 10 个这样的纯空目录，加上台账内的共 17 个）。
 *
 * 只在启动调用（唯一能确定没有子 Agent 在跑的时刻）。三重保守闸门，任一不满足就跳过：
 * ① 有未提交改动 → 留目录；② 分支带着 HEAD 之外的提交 → 整个留（那是唯一留存）；
 * ③ 台账里还活着的条目 → 不碰。只有「干净 + 分支对 HEAD 零新增」才会目录和分支一起删。
 *
 * @param cwd - 主树工作目录。
 * @param keep - 台账在册的 worktree 路径（活着的一律不动）。
 * @returns 实际回收的数量。
 */
export function corumReapOrphanWorktrees(cwd: string, keep: ReadonlySet<string> = new Set()): number {
  // keep 集合与 git 报的路径都可能带/不带符号链接解析（macOS tmpdir /var ↔ /private/var）
  // → 两边统一成 realpath 再比。
  const keepReal = new Set([...keep].map(corumRealPath))
  let reaped = 0
  for (const item of corumListIsolatedWorktrees(cwd)) {
    if (keepReal.has(corumRealPath(item.path))) continue
    if (corumWorktreeHasUncommitted(item.path)) continue
    if (corumBranchAddsCommits(cwd, item.branch)) continue
    if (corumCleanupWorktree(cwd, item, { force: false })) reaped += 1
  }
  return reaped
}

/**
 * fork（corum）：**启动清扫**——恢复台账时把「已经没有留存价值」的条目连现场一起回收。
 *
 * 为什么只能在启动做：这是唯一能确定「没有任何子 Agent 还在跑」的时刻。子 Agent 被
 * 进程退出杀掉时永远不会 settle，条目就以 `active` 留在台账里——既不回收（安全清理
 * 只对 settle 过的条目生效，避免拔掉活子 Agent 的工作目录），也不消失（next `entriesOf`
 * 判它「分支还在 = 活条目」），于是 `.corum-worktrees` 永久堆积（2026-09-12 实测 20+ 个，
 * 其中 13 个零提交零改动的纯空目录）。
 *
 * 判据 = 既有的**安全清理**返回值：`corumCleanupWorktree(force:false)` 只在
 * 「分支不并入 HEAD 就留分支、worktree 有未提交改动就留目录」都通过、现场真的被清干净时
 * 才返回 true。清干净 ⇒ 磁盘上什么都没了 ⇒ 条目没有留存价值，从台账剔除（否则它会在
 * 下一次 `entriesOf` 被判成「死条目」再剔一次，日志与状态都会多绕一圈）。
 *
 * @param cwd - 主树工作目录。
 * @param entries - 恢复出来的台账条目。
 * @returns 保留的条目（现场未清干净的一律保留，状态如实）。
 */
export function corumReapRestoredEntries(cwd: string, entries: readonly CorumWorktreeEntry[]): CorumWorktreeEntry[] {
  return entries.filter(entry => {
    if (!corumCleanupWorktree(cwd, entry, { force: false })) return true
    // 清干净了：已集成的记录保持 integrated 并标 reclaimed（见 corumCleanupLedgerEntries
    // 的分档说明），未被集成的僵尸条目才落 discarded。
    if (entry.status === 'integrated') entry.reclaimed = true
    else { entry.status = 'discarded'; entry.reclaimed = true }
    return false
  })
}

/**
 * fork（corum）：分支 tip（sha；分支不存在/git 不可用 → undefined）。
 *
 * 用途只有一个：把「分支 tip 就是 HEAD」的**空分支**挡在对账之外。空分支（worktree
 * 建好后子 Agent 一个提交都没做）在 `git branch --merged HEAD` 里与「真合并过的分支」
 * 长得一模一样——只看 `--merged` 会把什么都没干的分支翻成 `integrated`
 * （单测 `settleFromEnd 精确翻转` 就是这么红的：fixture 的 `git branch wt/wt-s1` 是纯空分支）。
 *
 * @param cwd - 主树工作目录。
 * @param branch - 分支短名（`wt/wt-xxxxxx`）。
 * @returns tip sha；`undefined` = 分支不存在或 git 调用失败。
 */
export function corumBranchTip(cwd: string, branch: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd,
      stdio: 'pipe',
      encoding: 'utf8',
    })
    const tip = out.trim()
    return tip === '' ? undefined : tip
  } catch {
    return undefined
  }
}

/**
 * fork（corum）：**台账与 git 实况对账**——把「分支其实已经并入 HEAD」的待集成条目翻成
 * `integrated`（2026-09-12 用户实测后补）。
 *
 * 为什么必须有：集成不只有机制那条路。主 Agent 完全可以（而且实测就是）**派一个子 Agent
 * 用 git 把分支合并掉**——机制对此一无所知：台账里 4 条仍是 `settled`，卡片照旧显示
 * 「集成者 · 未启动 · 4 个分支待集成」，而 git 里 4 个分支**早就都在 main 上**。后果是
 * 连环的：卡片说谎、pending 通知对着已合并的分支报「未合并」、worktree 永不回收
 * （BUG-26「条目越堆越多」的根就在这）。
 *
 * 判据只用 git 真相（`git branch --merged HEAD`），不看任何自述；翻状态不改动 git 现场。
 * **空分支不翻**：`tip === HEAD` 说明这条分支从没往前走（纯空分支，或 fast-forward 到
 * 与 HEAD 重合），翻成 integrated 等于替一条什么都没干的分支签收——这类条目该走的是
 * 回收，不是认账（代价：真被 ff 合并的分支会退化成旧的「留待手动集成」，安全侧失败）。
 *
 * @param cwd - 主树工作目录。
 * @param entries - 该会话的台账条目。
 * @returns 对账后的条目 + 本次翻成 integrated 的 slug 列表（供持久化/发帧判断）。
 */
export function corumReconcileIntegrated(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
): { entries: CorumWorktreeEntry[]; flipped: string[] } {
  const hasPending = entries.some(entry => entry.status === 'active' || entry.status === 'settled')
  if (!hasPending) return { entries: [...entries], flipped: [] }
  const merged = corumMergedBranches(cwd)
  if (merged.size === 0) return { entries: [...entries], flipped: [] }
  const head = corumGitHead(cwd)
  const flipped: string[] = []
  const next = entries.map(entry => {
    if (entry.status !== 'active' && entry.status !== 'settled') return entry
    if (!merged.has(entry.branch)) return entry
    const tip = corumBranchTip(cwd, entry.branch)
    if (tip === undefined || tip === head) return entry
    // 空分支（创建后从未提交）不认账：`tip === base` 说明这条分支与它的创建点分毫不差，
    // 合并它等于什么都没并。缺 `base`（2026-09-12 之前的存量条目）时无从判断，
    // 只靠上面的 `tip !== head` 兜底。
    if (entry.base !== undefined && tip === entry.base) return entry
    flipped.push(entry.slug)
    return { ...entry, status: 'integrated' as const }
  })
  return { entries: next, flipped }
}

/**
 * fork（corum）：台账条目是否已**彻底失效**——worktree 目录与分支都不存在。
 *
 * 这类条目既不能集成（无分支可并）也不能再跑，却会在 `maxParallelChildren` 里永久
 * 占用额度。来源是 2026-09-09 之前的强删清理（`worktree remove --force` + `branch -D`
 * 之后条目仍留在台账/落盘记录里，见 docs/TODO.md 的 4 条 `active` 实证）。任一留存
 * （目录在 / 分支在）都算活条目——分支还在就仍可集成。
 */
export function corumEntryDead(cwd: string, entry: Pick<CorumWorktreeEntry, 'path' | 'branch'>): boolean {
  if (existsSync(entry.path)) return false
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${entry.branch}`], { cwd, stdio: 'pipe' })
    return false
  } catch {
    return true
  }
}

/**
 * fork（corum）：research 任务的 toolFilter——当任务声明只读（research=true）且
 * 实例 config 未显式 deny 全部写工具时，补 deny 全部写工具（与 subagent_research
 * 只读实例同款口径）。allow 保持 config 原值（只读任务不扩权）。
 */
export function corumResearchToolFilter(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  readonlyResearch: boolean,
): { allow?: string[]; deny?: string[] } | undefined {
  if (!readonlyResearch) return undefined
  if (corumMutationToolsForPlatform().every(t => toolFilter?.deny?.includes(t) === true)) return undefined
  return {
    ...toolFilter?.allow !== undefined ? { allow: toolFilter.allow } : {},
    deny: [...new Set([...(toolFilter?.deny ?? []), ...corumMutationToolsForPlatform()])],
  }
}

/**
 * fork（corum）：某个 scope 当前**可见**的全局工具名集合——`tools.restrict()` 的合法
 * 名字面。
 *
 * `dsh-tools` 的 `restrict()` 按「该 scope 的 known names」校验（未知名 fail-loud），而
 * preset 常驻层注册的工具属于该 scope 的祖先层：只有 `scopeOf(ctx)` + `schemas(scope)`
 * 这一对才能看到它们。任何「机制按名字裁工具/追加 deny」的调用点都应先过这里
 * （`corumNarrowDenyFilter` 的 `known` 参数即本函数返回值）。
 *
 * 注意：返回的是**可见**名（已应用链上既有 restriction）——它一定是 known 的子集，用作
 * deny 收敛只会多丢「本来就不存在/已被裁掉」的名字，不会漏掉真实存在的工具。
 * @param ctx - 目标 Agent 的 scoped 上下文（`agent.ctx` / agent scope 的创建窗口）。
 * @returns 该 scope 可见的工具名（省略 scope 时退化为全局视图，调用方应始终传 scoped ctx）。
 */
export function corumVisibleToolNames(ctx: Context): ReadonlySet<string> {
  return new Set(ctx.tools.schemas(scopeOf(ctx)).map(schema => schema.name))
}

/**
 * fork（corum）：把机制生成的 deny 名单收敛到「子 Agent 真正注册的工具名」。
 *
 * 背景（2026-09-10 实机，官方 preset 三模式全部派不出子 Agent）：corum 的写工具
 * 名单是**平台口径的硬编码**，其中 `str_replace_editor` 只有挂了
 * `str-replace-editor` 行的 preset（corum 自己的 profile、官方 minimal）才有；
 * 官方 standard/ptc/cordis 挂的是 `write`/`edit`。而 `tools.restrict()` 对未知名
 * fail-loud（dsh-tools），于是机制追加的 deny（denyDirectFs 的 str_replace_editor、
 * research 的写工具全家）让子 Agent 创建**直接抛错**：
 * `tools.restrict() names unknown global tool "str_replace_editor"`。
 *
 * 语义边界：只收敛 `deny`——deny 一个不存在的工具本就无从谈起（它不可能被调用），
 * 静默丢弃是正确结果；`allow` 原样保留，因为 allow 是「只留这些」的断言，写错必须
 * 继续 fail-loud（那是配置错误，不是平台差异）。preset 里**手写**的 config.toolFilter
 * 也不收敛（作者断言，同 allow 口径）。
 *
 * BUG-6（2026-09-11）：deny 中的裸 MCP 服务名（如 `pencil-mcp`）需要展开为
 * 带前缀的完整工具名列表（`mcp__<服务名>__*`）。MCP 工具在系统中的注册名是
 * `mcp__<服务名>__<工具名>` 格式（dsh-mcp-client），但 compile.ts 的
 * `mcpDenyNames` 只放了服务名本身。本函数在收敛时把裸服务名展开为该服务的
 * 全部已知工具名，保持 deny 语义（research 实例真的禁掉 MCP 工具）。
 *
 * @param filter - 机制生成的过滤器（config 原样透传的除外，见调用点）。
 * @param known - 目标 scope 可见的工具名（父 Agent scope 的可见名是其超集）。
 * @returns 收敛后的过滤器；deny 全被丢弃且无 allow 时返回 undefined（等于不限制）。
 */
export function corumNarrowDenyFilter(
  filter: { allow?: string[]; deny?: string[] } | undefined,
  known: ReadonlySet<string>,
): { allow?: string[]; deny?: string[] } | undefined {
  if (filter === undefined || filter.deny === undefined) return filter
  const deny: string[] = []
  // 是否发生过「丢弃 / 展开」——都没发生时原样返回**同一个引用**。
  // 这是既有约定（且已被单测锁定）：调用方会拿返回值做引用比较来判断「过滤器是否
  // 被改过」，无谓复制会让它误判。BUG-6 的展开逻辑早期版本丢了这条快路径，
  // 被 `isolation.spec.ts` 抓回来。
  let changed = false
  for (const name of filter.deny) {
    if (known.has(name)) {
      deny.push(name)
      continue
    }
    // BUG-6：裸 MCP 服务名展开为 `mcp__<服务名>__<工具名>` 前缀的全部已知工具。
    // 前缀格式 `mcp__<name>__`：已知工具名以此前缀开头的全部收入 deny。
    // 前缀无命中（服务未装载/名写错）时什么都不加 —— 等价于原「丢弃未知名」语义。
    const prefix = `mcp__${name}__`
    for (const tool of known) {
      if (tool.startsWith(prefix)) deny.push(tool)
    }
    changed = true
  }
  if (!changed) return filter
  if (deny.length === 0 && filter.allow === undefined) return undefined
  return { ...filter.allow !== undefined ? { allow: filter.allow } : {}, deny }
}

/**
 * fork（corum）：有效 toolFilter——config.toolFilter 与 denyDirectFs 的 deny 并集
 * （denyDirectFs=false 时不附加；config.toolFilter 缺省时并集只有附加项）。
 */
export function corumEffectiveToolFilter(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  denyDirectFs: boolean,
): { allow?: string[]; deny: string[] } {
  return {
    ...toolFilter?.allow !== undefined ? { allow: toolFilter.allow } : {},
    deny: [...toolFilter?.deny ?? [], ...denyDirectFs ? ['str_replace_editor'] : []],
  }
}

/**
 * fork（corum）：写工具判定——readonlyResearch 恒只读；否则看有效 toolFilter
 * 是否已把全部写工具 deny。
 */
export function corumIsWriteTask(
  toolFilter: { allow?: string[]; deny?: string[] } | undefined,
  readonlyResearch: boolean,
  denyDirectFs = true,
): boolean {
  if (readonlyResearch) return false
  const deny = corumEffectiveToolFilter(toolFilter, denyDirectFs).deny
  // 平台实际装载的写工具口径（pwsh 仅 win32——未装载的工具不会被 deny，
  // 也不应参与「全 deny 即只读」的判定，否则非 win32 恒判写任务）。
  const presentWriteTools = process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(tool => tool !== 'pwsh')
  return !presentWriteTools.every(tool => deny.includes(tool))
}

/**
 * fork（corum）：隔离触发判定（readonlyResearch 实例恒不隔离）。
 *
 * 2026-09-09 并发感知（用户实机反馈「只派遣一个 TASK 时还是走了隔离工作区」）：
 * 隔离的存在理由是**并发写冲突**——没有并发就没有冲突，而 worktree 有实打实的
 * 代价（子 Agent 要重装依赖、沙箱默认写不了主仓 .git 管理目录）。因此默认模式
 * `write-tasks` 只在「本次派遣可能与其他写子 Agent 并发」时隔离：
 * - `always`：显式强制，无条件隔离（只读任务除外）；
 * - `write-tasks`（默认）：写任务 **且** 可能并发才隔离；
 * - `off`：永不隔离。
 *
 * @param mode - 生效隔离模式（任务级覆盖 > 预设 > 全局 > 默认）。
 * @param isWriteTask - 有效工具面判定出的写任务（corumIsWriteTask）。
 * @param readonlyResearch - 只读研究实例/任务（恒不隔离）。
 * @param concurrent - 本次派遣是否可能与其他写子 Agent 并发。缺省 true =
 *   旧语义（只要写就隔离），供不掌握并发信号的调用点保持行为等价。
 */
export function corumShouldIsolate(
  mode: 'always' | 'write-tasks' | 'off',
  isWriteTask: boolean,
  readonlyResearch: boolean,
  concurrent = true,
): boolean {
  if (readonlyResearch) return false
  // 不变式③（invariant.background-parallel-isolated，用户 2026-09-16）：**后台/并发写任务
  // 恒隔离**——这是最高优先级，覆盖 mode='off' 与任务级 isolation:'off' 的绕过（否则后台
  // 并行写会落父树、丢隔离/集成能力）。「单发前台可不走隔离」是另一条：只有非并发
  // （单发前台）时 mode 才参与判定。
  if (concurrent && isWriteTask) return true
  if (mode === 'always') return true
  if (mode === 'off') return false
  return isWriteTask && concurrent
}

/** fork（corum）：清理选项——`force` 为无条件强删（仅集成成功后调用）。 */
export interface CorumCleanupOptions {
  /**
   * true = 无条件强删（`worktree remove --force` + `branch -D`）。
   * 仅当**工作已确认并入 HEAD**（集成成功）时才可传——否则会销毁未合并工作的
   * 唯一留存（docs/TODO.md 的 autoIntegrate 数据丢失事故）。
   * 缺省/false = 安全清理：worktree 有未提交改动则保留目录，分支未并入 HEAD 则保留分支。
   */
  readonly force?: boolean
}

/**
 * fork（corum）：最佳努力回滚/清理（清理失败不掩盖原始错误）。
 *
 * 2026-09-09 加固（机制真值门禁配套）：非 force 模式下——
 * - worktree 目录：有未提交改动 → **保留现场**（不删目录）；
 * - 分支：未并入 HEAD → **保留分支**（未合并提交是那批工作的唯一留存，
 *   `branch -D` 会让 commit 变成 unreachable，实测即数据丢失）。
 * @returns 是否已完整清理（worktree 目录已消失且分支已删除）。
 */
export function corumCleanupWorktree(
  cwd: string,
  entry: Pick<CorumWorktreeEntry, 'path' | 'branch'>,
  options: CorumCleanupOptions = {},
): boolean {
  const force = options.force === true
  const keepWorktree = !force && corumWorktreeHasUncommitted(entry.path)
  const keepBranch = !force && !corumBranchMerged(cwd, entry.branch)
  let worktreeRemoved = false
  if (!keepWorktree) {
    try {
      corumGit(cwd, ['worktree', 'remove', '--force', entry.path])
      worktreeRemoved = true
    } catch {
      // Best effort: 台账仍登记，dispose 清理会重试。
    }
  }
  let branchDeleted = false
  if (!keepBranch) {
    try {
      corumGit(cwd, ['branch', '-D', entry.branch])
      branchDeleted = true
    } catch {
      // Best effort: 分支可能未建或已删。
    }
  }
  return branchDeleted && (worktreeRemoved || !existsSync(entry.path))
}

/**
 * fork（corum）：删除指定状态的台账条目（worktree remove + branch -D + 标 discarded）。
 *
 * 2026-09-09 加固：仅在**完整清理**（目录已消失 + 分支已删）时才改状态——
 * 安全模式下被保留的未合并分支/脏 worktree 保持原 status 并落盘，台账状态如实
 * 反映现场（此前无条件标 discarded 导致「worktree 已清、台账仍 active」的漂移）。
 *
 * 2026-09-12 修正（分档，用户实测）：清理成功后**已集成的条目保持 `integrated`**
 * 并置 `reclaimed: true`（工作确已进主树，只是现场回收了）；只有「没集成就被清掉」
 * 的才落 `discarded`。此前一律落 discarded，UI 会把成功集成写成「已丢弃」。
 */
export function corumCleanupLedgerEntries(
  cwd: string,
  entries: CorumWorktreeEntry[],
  statuses: readonly CorumWorktreeEntry['status'][],
  options: CorumCleanupOptions = {},
): void {
  for (const entry of entries) {
    if (!statuses.includes(entry.status)) continue
    // 清理前先记住「工作是否已进主树」——它决定清理后落哪个状态。
    const landedInMain = entry.status === 'integrated'
    if (!corumCleanupWorktree(cwd, entry, options)) continue
    if (landedInMain) {
      // 已集成 + 现场回收：状态如实保持 integrated，只补 reclaimed 标记
      // （UI 显示「已集成 · 现场已回收」）。**不能写 discarded**——那在 UI 上是
      // 「已丢弃」，对一份已经进主树的工作是谎（2026-09-12 用户实测指出）。
      entry.reclaimed = true
    } else {
      // 没集成却被清掉（显式丢弃 / 现场已不存在的僵尸条目）→ discarded 才是实话。
      entry.status = 'discarded'
      entry.reclaimed = true
    }
  }
}

/**
 * fork（corum）：台账里**终态记录**（integrated/discarded）的保留上限。
 *
 * 终态条目是「并行工作区」这一栏的历史与分类来源（用户 2026-09-12 实测：
 * 隔离任务那一栏整段消失了）。现场（worktree 目录 + 分支）回收后记录仍要留下，
 * 否则该栏会随着清理一起消失；但也不能无限增长，故保留最近 N 条。
 */
const CORUM_LEDGER_TERMINAL_KEEP = 30

/** fork（corum）：条目是否已到终态（integrated / discarded）。 */
function isTerminalEntry(entry: Pick<CorumWorktreeEntry, 'status'>): boolean {
  return entry.status === 'integrated' || entry.status === 'discarded'
}

/** fork（corum）：integrate 准入——active 或 settled 的待集成条目。 */
export function corumPendingIntegration(entries: CorumWorktreeEntry[]): CorumWorktreeEntry[] {
  return entries.filter(entry => entry.status === 'active' || entry.status === 'settled')
}

/**
 * fork（corum）：subagent/end settle 联动——按 runId/childId 精确翻转 active→settled。
 *
 * 2026-09-09 修复：条目在 spawn 后经 `bindRunId` 绑定 id（前台 one-shot 绑 run.id、
 * continuable 绑 childId），故**先按 runId 再按 childId 精确匹配**——并行多个子 Agent
 * 时各自精确命中，不再依赖「唯一 active 回退」（该回退在 ≥2 并行时必然失败，是
 * docs/TODO.md「settle 联动未生效」的第二半）。回退分支保留给未绑定 id 的存量条目。
 */
export function corumMarkSettled(
  entries: CorumWorktreeEntry[],
  settle: { runId?: string; childId?: string },
): boolean {
  const match = (id: string | undefined): CorumWorktreeEntry | undefined =>
    id === undefined ? undefined : entries.find(entry => entry.status === 'active' && entry.runId === id)
  // childSessionId 与 runId 同值（见 CorumWorktreeEntry 注释），但**必须单独补写**：
  // 浮层「并行工作区」行的可点性只看 childSessionId。2026-09-12 真机实测：本仓台账里
  // 2 条已结算条目只有 runId、没有 childSessionId（走的是下面的回退分支），于是
  // 「工作区行点击进入子会话」在真实数据上**全是死行**（渲染成 div，没有 → 与 title）。
  const childIdOf = (entry: CorumWorktreeEntry): string | undefined =>
    entry.childSessionId ?? settle.childId ?? entry.runId
  const byId = match(settle.runId) ?? match(settle.childId)
  if (byId !== undefined) {
    byId.status = 'settled'
    const childId = childIdOf(byId)
    if (childId !== undefined) byId.childSessionId = childId
    return true
  }
  if (settle.childId === undefined) return false
  const candidates = entries.filter(entry => entry.status === 'active' && entry.runId === undefined)
  if (candidates.length === 1) {
    candidates[0].status = 'settled'
    candidates[0].runId = settle.runId ?? settle.childId
    candidates[0].childSessionId = settle.childId ?? settle.runId
    return true
  }
  return false
}

/**
 * fork（corum）：**机制真值门禁**的判定结果——集成是否真的持久化进主树历史。
 * 语义（2026-09-09 数据丢失事故修复，docs/TODO.md）：
 * - `unmerged`：分支的工作未进入 HEAD（集成者没合并/合并失败/只改了工作区没提交）；
 * - `uncommitted`：worktree 里残留未提交改动（子 Agent 写了没提交 = 未持久化）；
 * - `dirtyDelta`：主树新增的未提交改动（集成前后对比，仅供提示，不作失败判据）；
 * - `dirtyBeforeCount`：**集成前主树就有**的未提交改动条数（无关在制品；见
 *   `corumDirtyOwnershipLines` 的由来注释）——同样的「只作提示、不作判据」；
 * - `integrated`：`unmerged` 与 `uncommitted` 均空才算真集成。
 */
export interface CorumIntegrationTruth {
  readonly integrated: boolean
  readonly unmerged: readonly string[]
  readonly uncommitted: readonly string[]
  readonly dirtyDelta: readonly string[]
  readonly dirtyBeforeCount: number
  readonly head: string
}

/**
 * fork（corum）：按 git 实况判定集成是否成功——**不再信任集成者自述**
 * （`settleForegroundRun` 只保证子 Agent 正常结束，不代表它真的合并了）。
 *
 * 事故链条（2026-09-09）：集成者自称「已 merge + verify 通过」→ 机制无条件把台账
 * 写 `integrated` 并 `worktree remove --force` + `branch -D` → 子任务 commit 变成
 * unreachable、文件从主树消失（`git log --all` 只剩 init）。本函数是该链条的闸门。
 *
 * @param cwd - 主树（父会话）工作目录。
 * @param entries - 待集成的台账条目（active/settled）。
 * @param dirtyBefore - 集成前 `corumGitStatusPorcelain(cwd)` 原文（dirtyDelta 基线）。
 *
 * fork（corum）2026-09-12 修正（实机事故）：判定条件里的 `uncommitted` 曾**参与
 * `integrated`**，而 `entries` 是**该会话全部 active/settled 条目**——于是任何兄弟
 * worktree 的未提交残留（哪怕与本次 fan-in 无关，实测是一个 scratch 文件）都会让一次
 * 已经落地的集成被判失败：首轮派发的会话 corum-task-d51272e3 因此拿到
 * 「integrate did not persist into the main tree … worktrees with UNCOMMITTED changes:
 * wt-5700d6」，而主树 HEAD 明明已推进（704f855e → 254df321），主 Agent 后续的
 * 「重启验证实例 / 三层实机验证 / 落位台账」三阶段整条没起来。
 *
 * 现在的口径：**「分支是否已并入 HEAD」才是集成失败的唯一闸门**（那是「接到的活儿
 * 有没有落地」）；worktree 里的未提交改动属**未持久化**，由调用方按条目处理——
 * 该条目**保持 pending 并保留现场**（不标 integrated、不清理），并在结果里显式告知，
 * 而不是把整次 fan-in 判死。真未落地（分支不在 HEAD）依旧抛错 + 保留现场。
 */
/**
 * fork（corum）：`orchestrate` 要不要由机制收尾（纯函数，2026-09-12 两轮用户实测后定稿）。
 *
 * 演进：旧口径是「`merge.autoIntegrate` 缺省 = 只报告」，把合并交给模型记性。实测代价极大——
 * 12 个用过 orchestrate 的会话里 `autoIntegrate` 声明 true 仅 5 次、false 10 次、未声明 6 次，
 * **真正发生过集成的只有 3 个会话**，隔离分支（那份工作的唯一副本）静默搁浅；用户据此报
 * 「编排工作流的最后一个节点始终不会运行」。随后改成「声明 verify 即默认自动集成」，
 * 但用户点出关键：**这个字段对模型是个诱人的 footgun**——10 次提及里 10 次设成 false，
 * 而它几乎不会回来执行（见 BUG-29）。
 *
 * 定稿口径：**声明即执行**。传了 `merge`（哪怕只有 verify，甚至是空对象）= 要机制跑完流水线；
 * 不传 = 分支留着给调用方，收尾走**显式动作** `subagent { integrate: true }`——
 * 从「随手设 false 就忘」变成「必须真的调一次」，这正是两者可靠性的差别。
 *
 * @param merge - orchestrate 的 merge 声明（缺省 = 调用方自己收尾）。
 * @returns 是否由机制自动 merge + verify + commit。
 */
export function corumAutoIntegrate(merge: { verify?: string } | undefined): boolean {
  return merge !== undefined
}

/**
 * fork（corum）：集成成功的**补充口**——主树脏/未提交时的 diff 落盘。
 *
 * 用法（机制侧）：集成者跑完、`corumIntegrationTruth` 报「有分支没进 HEAD」时，
 * 对每条未合并条目调一次本函数再复判一次真值。这是**补救路径**，不是放宽门禁：
 * `applied === false` 时照样走失败分支（抛错 + 保留现场）。
 * @param cwd - 主树工作目录。
 * @param entries - 待集成条目（只处理 `applied` 需要的分支信息）。
 * @returns 每条分支的落盘结果（顺序与入参一致，便于报告对照）。
 */
export function corumPortPendingBranches(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
): { branch: string; applied: boolean; base: string; patchBytes: number; error?: string }[] {
  return entries.map(entry => ({ branch: entry.branch, ...corumPortBranchDiff(cwd, entry) }))
}

export function corumIntegrationTruth(
  cwd: string,
  entries: readonly CorumWorktreeEntry[],
  dirtyBefore = '',
): CorumIntegrationTruth {
  const unmerged: string[] = []
  const uncommitted: string[] = []
  for (const entry of entries) {
    if (!corumBranchIntegrated(cwd, entry.branch)) unmerged.push(entry.branch)
    else if (corumWorktreeHasUncommitted(entry.path)) uncommitted.push(`${entry.slug} (${entry.path})`)
  }
  const beforeLines = dirtyBefore.split('\n').filter(line => line.trim() !== '')
  const before = new Set(beforeLines)
  const dirtyDelta = corumGitStatusPorcelain(cwd)
    .split('\n')
    .filter(line => line.trim() !== '' && !before.has(line))
  return {
    integrated: unmerged.length === 0,
    unmerged,
    uncommitted,
    dirtyDelta,
    // 主树**集成前就有的**未提交改动（与本次 fan-in 无关的在制品）。判据本身只看
    // 「分支有没有进 HEAD」，与主树脏不脏无关；这个计数只有一个用途：让报告能说清
    // 「本轮只对自己产出的 diff 负责」，而不是把既存脏读成「集成没落地」。
    dirtyBeforeCount: beforeLines.length,
    head: corumGitHead(cwd),
  }
}

/**
 * fork（corum）：主树既存未提交改动的提示行（集成报告共用；无则返回空数组）。
 *
 * 由来（2026-09-12 实机）：集成者把主树里**与本次无关的未提交在制品**当成了任务
 * 子 Agent 的工作，据此判「集成没落地」→ 整轮报失败（用户看到「集成失败」）。
 * 判据已改成「分支是否并入 HEAD」，但报告仍要说清两块 diff 的归属，否则同一个
 * 困惑会以另一种形式回来（「主树这些改动是谁的？」）。
 * @param truth - 集成真值（读 `dirtyBeforeCount` / `dirtyDelta`）。
 * @returns 报告行数组（可能为空）。
 */
export function corumDirtyOwnershipLines(truth: CorumIntegrationTruth): string[] {
  const lines: string[] = []
  if (truth.dirtyBeforeCount > 0) {
    lines.push(
      `main tree ALREADY had ${truth.dirtyBeforeCount} uncommitted path(s) before this integrate — unrelated work-in-progress, neither produced nor claimed by this round. The verdict above is about the pending BRANCHES only.`,
    )
  }
  if (truth.dirtyDelta.length > 0) {
    lines.push(
      `main tree ALSO gained ${truth.dirtyDelta.length} uncommitted path(s) during this round (e.g. ${truth.dirtyDelta.slice(0, 3).join(', ')}) — the integrator's own writes if it edited outside its worktree; they are NOT part of any branch commit unless committed.`,
    )
  }
  return lines
}

/**
 * fork（corum）：**部分集成**的结果说明——所有待集成分支都已并入 HEAD，但有个别
 * worktree 还留着未提交改动（写了没提交）。这些条目**不标 integrated、保留现场**，
 * 由主 Agent 决定补提交还是丢弃；其余条目正常翻转并（按需）清理。
 *
 * @param truth - 集成真值（`integrated === true` 时调用）。
 * @param headBefore - 集成前的主树 HEAD（报告里给前后对照）。
 * @returns 给主 Agent 的说明文本（含未持久化条目与路径）。
 */
export function corumPartialIntegrationNotice(
  truth: CorumIntegrationTruth,
  headBefore: string,
): string {
  const lines: string[] = [
    'integrate PARTIALLY persisted: every pending branch is now in the main tree, but some worktrees still hold UNCOMMITTED changes (written, never committed).',
    `main tree HEAD: ${headBefore === '' ? '(unknown)' : headBefore.slice(0, 12)} -> ${truth.head === '' ? '(unknown)' : truth.head.slice(0, 12)}`,
    `NOT integrated (kept pending, worktree + branch preserved): ${truth.uncommitted.join(', ')}`,
  ]
  if (truth.dirtyDelta.length > 0) {
    lines.push(`main tree also has ${truth.dirtyDelta.length} uncommitted path(s) not present before integrate (e.g. ${truth.dirtyDelta.slice(0, 3).join(', ')})`)
  }
  lines.push(...corumDirtyOwnershipLines(truth))
  lines.push('Next: commit (or discard) those leftovers in their worktrees, then call integrate again for them — or discard them explicitly.')
  return lines.join('\n')
}

/**
 * fork（corum）：集成未达标的失败报告——把「集成者自述 vs git 实况」一并交给主
 * Agent，并明确现场已保留（worktree/分支未清理，可继续修或人工合并）。
 */
export function corumIntegrationFailure(
  truth: CorumIntegrationTruth,
  headBefore: string,
  entries: readonly CorumWorktreeEntry[],
  claim = '',
): string {
  const lines: string[] = [
    'integrate did not persist into the main tree — the mechanism checked git and the declared integration did not land.',
    `main tree HEAD: ${headBefore === '' ? '(unknown)' : headBefore.slice(0, 12)} -> ${truth.head === '' ? '(unknown)' : truth.head.slice(0, 12)}`,
  ]
  if (truth.unmerged.length > 0) {
    lines.push(`branches NOT integrated into HEAD (their commits are the only copy of that work): ${truth.unmerged.join(', ')}`)
  }
  if (truth.uncommitted.length > 0) {
    lines.push(`worktrees with UNCOMMITTED changes (written but never committed): ${truth.uncommitted.join(', ')}`)
  }
  // 先把两块 diff 的归属说清，再给 delta——否则「主树有改动」会被读成本轮的锅
  // （2026-09-12 我本人踩过：主树是在制品，机制却报了「集成没落地」）。
  lines.push(...corumDirtyOwnershipLines(truth))
  lines.push('Worktrees and branches are PRESERVED — nothing was cleaned up. Merge them yourself (or re-run integrate) after fixing the failure.')
  lines.push(`Pending entries: ${entries.map(entry => `${entry.slug}@${entry.branch} -> ${entry.path}`).join('; ')}`)
  const trimmedClaim = claim.trim()
  if (trimmedClaim !== '') {
    lines.push(`Integrator's own report (NOT trusted as evidence):\n${trimmedClaim.slice(0, 2000)}`)
  }
  return lines.join('\n')
}

/**
 * fork（corum）：探测式默认 integrateChecks——按父 cwd 仓库形态生成核查命令。
 * 显式 config（preset 的 integrateChecks）恒优先，本函数不参与。
 */
export function corumDetectIntegrateChecks(cwd: string): string[] {
  if (existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) return ['pnpm -r typecheck']
  try {
    const pkgPath = path.join(cwd, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      if (typeof pkg.scripts?.typecheck === 'string') return ['npm run typecheck']
      if (typeof pkg.scripts?.test === 'string') return ['npm test']
    }
  } catch {
    // package.json 不可读/坏 JSON → 落保守兜底。
  }
  return ['git diff --check']
}

/**
 * fork（corum）：integrate 召唤的集成者 persona（机制拼装，非 LLM 自由写）。
 * 声明式验证语义（2026-09-08 定调）：declared 原样注入并强制执行，功能性验收
 * 由主 Agent 基于原始目标最终裁决；探测式默认仅作未声明时的兜底。
 */
export function corumIntegratorPersona(
  entries: CorumWorktreeEntry[],
  checks: string[],
  merger: 'parent' | 'merger' = 'parent',
  declared?: string,
): string {
  const branches = entries.map(entry => `- ${entry.branch} (worktree: ${entry.path})`).join('\n')
  const checkLines = checks.length > 0
    ? checks.map(check => `- ${check}`).join('\n')
    : '- git diff --check'
  const declaredBlock = declared !== undefined && declared.trim() !== ''
    ? `\nHow to build, run, and verify this repository (declared by the delegating agent — follow it exactly):\n${declared.trim()}\n`
    : '\nThe delegating agent did not declare how to build or verify this repository: run the checks below and treat them as the minimum bar only.\n'
  return 'You are the integration manager. Merge the branches listed below into the main working tree IN ORDER. Branches:\n'
    + branches
    + declaredBlock
    + '\nChecks (run every one; commit only when all pass):\n'
    + checkLines
    + '\nIf any check or declared verification step fails, report and leave the tree dirty — do NOT commit.\n'
    + '\nNever run destructive git commands on the main tree (git reset --hard, git checkout ., git clean -fd, git stash): it may contain unrelated uncommitted work that is not yours to discard. If the tree is dirty in a way that blocks the merge, report it instead of wiping it.\n'
    + 'The mechanism independently verifies afterwards that every listed branch really landed in HEAD; a report that does not match git will be rejected.\n'
    + (merger === 'merger'
      ? 'You are a dedicated integration specialist: after completing the merge and verification, report a per-branch summary (merged/conflicts/verification results) as your final answer.'
      : 'Report the integration outcome (merge result, verification output, and anything that looks off) so the delegating agent can make the final acceptance call against the original goal.')
}

/**
 * fork（corum）：**隔离边界说明行**——给**父 Agent** 看的一行事实（用户 2026-09-13 定调「先做可见性」）。
 *
 * 由来：`subagent` 工具没有按次 isolation 开关，缺省策略（write-tasks）下**单发前台写任务
 * 直接在主工作区改**（无 worktree、无分支）。这件事此前只写在**给子 Agent 的提示词**里
 * （{@link corumDirectWriteNotice}），父 Agent 拿到结果时看不出边界——2026-09-12 的探针
 * 就是这么被骗的：用户要求「派一个前台隔离子 Agent」，机制按口径没隔离，而父侧从结果里
 * 读不出「其实没隔离」。
 *
 * 本函数只产出**一句事实**，不改任何机制语义（隔离判据仍在 `corumShouldIsolate`）。
 * 纯函数，可单测；渲染方按平台无关的英文写（本仓提示词/工具结果纪律）。
 *
 * @param boundary - 本次委派的隔离落点：`worktree`（隔离，带分支）/ `parent-tree`
 *   （缺省策略下在主工作区执行）/ `skipped-non-git`（非 git 工作区导致隔离被跳过）。
 * @param branch - `worktree` 时的分支名（缺省时只报「已隔离」）。
 * @returns 一行说明；`worktree` 且带分支时也返回（供调用方决定是否显示），
 *   调用方对 `worktree` 可选择性省略。
 */
export function corumIsolationBoundaryNotice(
  boundary: 'worktree' | 'parent-tree' | 'skipped-non-git',
  branch?: string,
): string {
  if (boundary === 'worktree') {
    return `[corum isolation] this delegation ran in an ISOLATED worktree${branch === undefined || branch === '' ? '' : ` (branch ${branch})`} — its edits are on that branch and only reach your tree through integrate.`
  }
  if (boundary === 'skipped-non-git') {
    return '[corum isolation] this delegation ran in the PARENT working tree (not isolated): the workspace is not a git repository, so isolation was skipped — its edits are ALREADY in your tree and nothing will merge them.'
  }
  return '[corum isolation] this delegation ran in the PARENT working tree (not isolated: a lone foreground write delegation works in place) — no worktree, no branch; its edits are ALREADY in your tree and nothing will merge them.'
}

// ── 编排器 service（台账状态下沉；红线 1 合规）──────────────────────────────

/**
 * fork（corum）：编排器 service——持有会话级隔离台账（实例字段，非模块级单例），
 * 提供台账登记/结算/清理/帧发射。继承 cordis `Service`（`super(ctx, name)` 自动
 * provide + 随 owning fiber 注销）。挂载到**根上下文**（跨会话/跨 bundle 单例，
 * 红线 1 合规）；消费方经 `ctx.root.get('corumOrchestration')` 读取。
 */
/** fork（corum）：隔离 worktree 子会话的创建选项（工具层与 isolated provider 共用）。 */
export interface CorumWorktreeChildOptions {
  /** worktree 根目录（相对父 cwd 或绝对路径，默认 `.corum-worktrees`）。 */
  worktreeRoot?: string
  /** 分支名前缀（默认 `wt/`）。 */
  branchPrefix?: string
  /** 并发上限（默认 4；达到即抛错，调用方提示模型等待或先集成）。 */
  maxParallelChildren?: number
}

/** fork（corum）：已创建的隔离子会话三件套。 */
export interface CorumWorktreeChild {
  readonly slug: string
  readonly branch: string
  readonly path: string
}

/**
 * fork（corum）：隔离子 Agent 的 prompt 前缀（单一事实源——工具层与 isolated
 * provider 必须给子 Agent 同一套纪律：相对路径、父树只读、在分支内提交）。
 * @param entry - 已创建的 worktree 条目（只取 branch）。
 * @returns 注入到子 Agent prompt 最前面的通知文本（含尾随空行）。
 */
export function corumIsolationNotice(entry: Pick<CorumWorktreeChild, 'branch'>): string {
  return `[corum isolation] You are working inside an isolated git worktree (branch ${entry.branch}). Your working directory IS the worktree root; address every file by RELATIVE path only. The parent working tree outside this worktree is write-denied by the sandbox (reads are still allowed for reference). Commit your changes on branch ${entry.branch} inside this worktree; do not attempt to write outside it.\n\n`
}

/**
 * fork（corum）：非隔离写委托的 prompt 前缀（主工作区直连时禁止 git 操作——父 Agent
 * 可能留有未提交的无关改动，子 Agent 一句 `git add -A` 会把它一起卷进提交）。
 * @returns 注入到子 Agent prompt 最前面的通知文本（含尾随空行）。
 */
export function corumDirectWriteNotice(): string {
  return '[corum orchestration] This delegation has no concurrent write task, so you work DIRECTLY in the delegating agent\'s working tree (no isolated worktree). Edit files in place and leave version control to the delegating agent: do NOT run git add / commit / checkout / stash / reset, and do not create branches.\n\n'
}

export class CorumOrchestration extends Service {
  /** 会话级隔离台账（key=父 session id）。service 实例字段，非模块级单例。 */
  private readonly ledger = new Map<string, CorumWorktreeEntry[]>()
  /** 台账 session → 父会话 cwd（dispose 清理时定位 git 主干）。 */
  private readonly ledgerCwds = new Map<string, string>()
  /**
   * 收口时**强制提交失败**的暂存（key=父 session id）。
   *
   * 为什么用实例字段而不是返回值：`settleFromEnd` 在 `subagent/end` 监听里被调用，
   * 而 emitter 的 **per-listener 容错会吞掉抛错** ⇒ 失败无法靠 throw 抵达模型。
   * 故 settle 暂存、调用方经 {@link drainSettleCommitFailures} 取走并以 notice 投递给模型。
   */
  private readonly commitFailures = new Map<string, CorumSettleCommitFailure[]>()
  /** Phase 4：持久化 domain 句柄（storageDomain 缺失时为 undefined，回落纯内存）。 */
  private readonly domainPromise: Promise<Domain<typeof corumOrchestrationDomainSpec>> | undefined

  constructor(ctx: Context) {
    super(ctx, 'corumOrchestration')
    // fork（corum）：Phase 4 台账持久化（§11.9 决策项①落盘）。storageDomain 是
    // 根上下文服务，缺失时（单测/未装配）回落纯内存，行为与下沉前一致。
    const storageDomain = ctx.get('storageDomain')
    if (storageDomain === undefined) {
      this.domainPromise = undefined
      return
    }
    this.domainPromise = storageDomain.open(corumOrchestrationDomainSpec)
    // 恢复 + 关闭句柄（随 owning fiber）。
    void this.domainPromise.then((domain) => {
      this.ctx.effect(() => () => { void domain.close() }, 'corumOrchestration.domainClose')
      // 启动恢复：重建台账（仅 active/settled 待集成条目——孤儿 worktree 识别）。
      for (const [sessionId, record] of domain.table('ledger').entries()) {
        // 存量修补：childSessionId 与 runId 同值（见 CorumWorktreeEntry 注释），但
        // 2026-09-12 之前的结算回退路径只写了 runId → 恢复后的条目在浮层里是**死行**
        // （「并行工作区」行的可点性只看 childSessionId）。这里就地补齐，不改动语义。
        this.ledger.set(sessionId, corumReapRestoredEntries(record.cwd, record.entries.map(e => e.childSessionId !== undefined || e.runId === undefined
          ? { ...e }
          : { ...e, childSessionId: e.runId })))
        this.ledgerCwds.set(sessionId, record.cwd)
        this.persist(sessionId)
      }
      // 台账之外的孤儿 worktree 也清一遍（台账记录会因「无待集成条目」被删掉，那些
      // worktree 就再没有任何记录引用；实测本仓 10 个纯空目录属于这一类）。
      for (const cwd of new Set(this.ledgerCwds.values())) {
        const keep = new Set<string>()
        for (const entries of this.ledger.values()) for (const entry of entries) keep.add(entry.path)
        const reaped = corumReapOrphanWorktrees(cwd, keep)
        if (reaped > 0) this.ctx.logger.info(`corumOrchestration: 启动清扫回收 ${reaped} 个孤儿 worktree（${cwd}）`)
      }
    }).catch((error: unknown) => {
      this.ctx.logger.error(`corumOrchestration: open domain failed: ${String(error)}`)
    })
  }

  /** Phase 4：台账变更后异步落盘（fire-and-forget；domain 未就绪/缺失时静默跳过）。 */
  private persist(sessionId: string): void {
    if (this.domainPromise === undefined) return
    void this.domainPromise.then(async (domain) => {
      const entries = this.ledger.get(sessionId)
      const cwd = this.ledgerCwds.get(sessionId)
      // 落盘待集成条目 + **最近 N 条终态记录**。
      //
      // 2026-09-12 修正（用户实测「隔离那一栏整段消失」）：旧实现只落 active/settled，
      // 现场一回收记录就没了 → 「并行工作区」栏（含 已集成/已丢弃 分类）随之消失，
      // 重启后也回不来。终态记录是那一栏的历史与分类来源，必须留下；
      // 用 CORUM_LEDGER_TERMINAL_KEEP 限制条数以免无限增长。
      const pending = entries?.filter(e => !isTerminalEntry(e)) ?? []
      const terminal = (entries?.filter(isTerminalEntry) ?? []).slice(-CORUM_LEDGER_TERMINAL_KEEP)
      const kept = [...pending, ...terminal]
      if (kept.length === 0 || cwd === undefined) {
        await domain.table('ledger').delete(sessionId)
        return
      }
      await domain.table('ledger').put(sessionId, { cwd, entries: kept.map(e => ({ ...e })) })
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`corumOrchestration: persist ledger failed: ${String(error)}`)
    })
  }

  /**
   * 认账「已并入 HEAD 的分支」并**顺带安全回收其现场**（不发帧、不落盘、**不剔除死条目**
   * ——死条目的清除时机仍是 `entriesOf` 的懒清除，有单测钉住）。
   *
   * 两个入口都必须走这里：`entriesOf`（工具层查询）与 `emitFrame`（UI 帧）。只在
   * `entriesOf` 里对账的话，帧由 `addActiveEntry`/`markSettled` 等事件直接发射，照旧把
   * 已被子 Agent 合并掉的分支显示成「待集成」（2026-09-12 用户实测的卡片说谎）。
   * 顺带挡住一个反向坑：新建 worktree 的分支 tip === HEAD，若不设防就会在
   * `addActiveEntry` 那一刻被 `--merged` 误判成已集成。
   *
   * 回收（用户实测的第二半：分支早就在 main 上，worktree 却永远留着）只针对**翻之前
   * 就已 settle** 的条目——active 的子 Agent 可能还在那个目录里干活，拔掉目录会让它
   * 后续每次工具调用都失败。且一律走**安全清理**（`force:false`）：worktree 有未提交
   * 改动就保留目录（那是唯一留存），分支未并入 HEAD 就保留分支。状态保持 `integrated`
   * （工作确已进 main），不标 `discarded`（那在 UI 上显示成「已丢弃」，是谎）。
   *
   * @param sessionId - 父会话 id（台账键）。
   * @param entries - 台账条目（可能已剔除死条目；**不得就地修改**）。
   * @returns 对账后的条目 + 是否发生翻转（未翻转时原样返回入参引用）。
   */
  private reconcileAndReclaim(
    sessionId: string,
    entries: readonly CorumWorktreeEntry[],
  ): { entries: readonly CorumWorktreeEntry[]; flipped: boolean } {
    const cwd = this.ledgerCwds.get(sessionId)
    if (cwd === undefined || entries.length === 0) return { entries, flipped: false }
    const wasSettled = new Set(entries.filter(e => e.status === 'settled').map(e => e.slug))
    const reconciled = corumReconcileIntegrated(cwd, entries)
    if (reconciled.flipped.length === 0) return { entries, flipped: false }
    for (const entry of reconciled.entries) {
      if (entry.status !== 'integrated' || !wasSettled.has(entry.slug)) continue
      // 完整回收成功才标 reclaimed（安全清理可能保留脏 worktree / 未并分支）。
      if (corumCleanupWorktree(cwd, entry, { force: false })) entry.reclaimed = true
    }
    return { entries: reconciled.entries, flipped: true }
  }

  /**
   * 读某会话台账条目（不存在返回空数组，不自动建）。
   *
   * 2026-09-09：顺带剔除**彻底失效**的条目（worktree 与分支都不存在）——旧强删清理
   * 遗留的 active 条目会永久占用 `maxParallelChildren` 额度（实证：本仓
   * `corum-task-7cebf463` 的 3 条死条目使后续 spawn 只剩 1 个名额）。剔除后落盘。
   * 2026-09-12：再叠加 git 实况对账（`corumReconcileIntegrated`）——分支可能已被
   * **主 Agent 派子 Agent 合并掉**，机制必须认账。
   */
  entriesOf(sessionId: string): CorumWorktreeEntry[] {
    const entries = this.ledger.get(sessionId) ?? []
    const cwd = this.ledgerCwds.get(sessionId)
    if (cwd === undefined || entries.length === 0) return entries
    // 死条目的剔除只针对**待集成**条目（active/settled 占并发额度、且已无法集成）；
    // 终态记录（integrated/discarded）即使现场已回收也留着——那是「并行工作区」栏的
    // 历史与分类（见 persist 的说明）。
    const alive = entries.filter(entry => isTerminalEntry(entry) || !corumEntryDead(cwd, entry))
    const reconciled = this.reconcileAndReclaim(sessionId, alive)
    if (alive.length === entries.length && !reconciled.flipped) return entries
    const next = [...reconciled.entries]
    this.ledger.set(sessionId, next)
    this.persist(sessionId)
    if (reconciled.flipped) this.emitFrame(sessionId)
    return next
  }

  /** 登记一条 active 条目并记录父 cwd（worktree 创建成功后调用）。 */
  addActiveEntry(sessionId: string, cwd: string, entry: Omit<CorumWorktreeEntry, 'status'>): void {
    const entries = this.ledger.get(sessionId) ?? []
    entries.push({ ...entry, status: 'active' })
    this.ledger.set(sessionId, entries)
    this.ledgerCwds.set(sessionId, cwd)
    this.persist(sessionId)
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：为一个委托创建隔离 worktree 子会话（工具层与 isolated provider 共用）。
   *
   * 步骤与失败语义（与工具层原实现逐条等价）：
   *   ① 并发上限：active 条目 ≥ maxParallelChildren 即抛错（调用方提示模型等待/先集成）；
   *   ② `git worktree add <path> -b <branch>`；失败时回滚半成品 worktree 再抛；
   *   ③ 登记 active 台账条目（run id 待 spawn 后 `bindRunId` 绑定）。
   * @param sessionId - 父会话 id（台账键）。
   * @param parentCwd - 父会话工作目录（worktree 根与 git 操作基准）。
   * @param options - worktree 根/分支前缀/并发上限。
   * @returns 新建的隔离子会话三件套（slug/branch/path）。
   */
  createWorktreeChild(
    sessionId: string,
    parentCwd: string,
    options: CorumWorktreeChildOptions = {},
  ): CorumWorktreeChild {
    const maxParallel = options.maxParallelChildren ?? 4
    const entries = this.entriesOf(sessionId)
    if (entries.filter(entry => entry.status === 'active').length >= maxParallel) {
      throw new Error('parallel child limit reached; wait for one to settle or integrate first')
    }
    const slug = `wt-${randomBytes(3).toString('hex')}`
    const root = path.resolve(parentCwd, options.worktreeRoot ?? '.corum-worktrees')
    const branch = `${options.branchPrefix ?? 'wt/'}${slug}`
    const worktreePath = path.join(root, slug)
    // 2026-09-15 机制补漏（用户裁定「严格」）：父树有**任何**未提交改动（含 untracked）即拒绝隔离 ——
    // 子从 HEAD 建分支、看不到未提交工作，会在过时的树上开发/验证并可能**静默**报成功。
    // 放在 `mkdirSync`/`worktree add` **之前**，连半成品目录都不产生。
    const refusal = corumDirtyParentRefusal(parentCwd)
    if (refusal !== undefined) throw new Error(refusal)
    mkdirSync(root, { recursive: true })
    try {
      corumGit(parentCwd, ['worktree', 'add', worktreePath, '-b', branch])
    } catch (error: unknown) {
      corumCleanupWorktree(parentCwd, { path: worktreePath, branch })
      throw error
    }
    // 记下分支创建点（= 当时的 HEAD）。对账时用「tip 有没有离开 base」区分
    // 「真的做了事的分支」与「一条提交都没有的空分支」——空分支一旦 main 往前走了，
    // 在 `git branch --merged HEAD` 里与真合并过的分支完全同形（2026-09-12 实测：
    // 两条刚建好的空分支在重启后就被误判成 integrated 并回收）。
    const base = corumBranchTip(parentCwd, branch)
    this.addActiveEntry(sessionId, parentCwd, { slug, branch, path: worktreePath, ...base === undefined ? {} : { base } })
    return { slug, branch, path: worktreePath }
  }

  /** 台账变更后发射快照帧（renderer chip 订阅源）。发帧前先对账 git 实况。 */
  emitFrame(sessionId: string): void {
    const current = this.ledger.get(sessionId) ?? []
    const reconciled = this.reconcileAndReclaim(sessionId, current)
    if (reconciled.flipped) {
      this.ledger.set(sessionId, [...reconciled.entries])
      this.persist(sessionId)
    }
    const entries = this.ledger.get(sessionId) ?? []
    const pending = entries.filter(e => e.status === 'active' || e.status === 'settled').length
    this.ctx.emit('corum/worktree-ledger', {
      sessionId,
      entries: entries.map(e => ({ ...e })),
      pending,
    } satisfies CorumWorktreeLedgerFrame)
  }

  /**
   * 父 scope dispose 时清理未集成的 worktree。
   *
   * 2026-09-09 加固：走**安全清理**（非 force）——未并入 HEAD 的分支保留（那是该批
   * 工作的唯一留存），worktree 有未提交改动则连目录一起保留；只有真正清干净的条目
   * 才标 `discarded`（状态如实，避免「worktree 已清、台账仍 active」的漂移）。
   */
  cleanupOnDispose(statuses: readonly CorumWorktreeEntry['status'][] = ['active', 'settled']): void {
    for (const [sessionId, entries] of this.ledger) {
      const cwd = this.ledgerCwds.get(sessionId)
      if (cwd === undefined) continue
      corumCleanupLedgerEntries(cwd, entries, statuses, { force: false })
      this.persist(sessionId)
    }
  }

  /**
   * fork（corum）：集成**成功**后的状态翻转 + 落盘 + 帧发射。
   * 仅当调用方已用 `corumIntegrationTruth` 确认集成真的落进 HEAD 后才可调用——
   * 未达标时必须抛错并保留现场（不写 integrated、不清理）。
   * @param cleanup - 是否顺带强清理已集成的 worktree/分支（config.isolation.autoCleanup）。
   */
  markIntegrated(sessionId: string, entries: CorumWorktreeEntry[], cleanup: boolean): void {
    const cwd = this.ledgerCwds.get(sessionId)
    for (const entry of entries) entry.status = 'integrated'
    if (cleanup && cwd !== undefined) {
      // 集成成功 = 每个分支都已并入 HEAD，此处强清理是安全的（唯一合法 force 点）。
      corumCleanupLedgerEntries(cwd, entries, ['integrated'], { force: true })
    }
    this.persist(sessionId)
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：把 spawn 得到的 run/child id 绑定到台账条目（精确 settle 的前置）。
   *
   * 2026-09-09 修复（docs/TODO.md「台账 settle 联动未生效」）：worktree 条目在
   * `subagents.start` 之前创建（request 需要 worktree 路径），此时 run id 未知；
   * start 返回后立刻绑定，`subagent/end` 到达时即可按 id 精确匹配——并行多个子 Agent
   * 时不再依赖「唯一 active 回退」（该回退在 ≥2 并行时必然失败）。
   */
  bindRunId(sessionId: string, slug: string, runId: string): void {
    const entry = this.ledger.get(sessionId)?.find(item => item.slug === slug)
    if (entry === undefined || entry.runId !== undefined) return
    entry.runId = runId
    entry.childSessionId = runId
    this.persist(sessionId)
    // 绑定后立即发射，让已打开的浮层行可点击（与 addActiveEntry/markIntegrated 同口径）。
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：回滚一条「worktree 已建、子 Agent 未起」的条目（spawn 抛错路径）。
   *
   * 条目在 `subagents.start` **之前**登记（request 需要 worktree 路径），因此 start
   * 失败时台账会留下一条永远 active、且永不绑定 runId 的条目：它占满
   * `maxParallelChildren` 额度，并让该会话后续每次派遣都命中并发信号③而强制隔离。
   * （2026-09-10 实机：官方 preset 三个会话各泄漏数条 worktree。）
   *
   * 此时 worktree 目录与分支都是本次 spawn 的产物，子 Agent 从未执行过任何工具，
   * 不可能有未合并提交——强清理安全。已绑定 runId 的条目一律不动（那条 run 真实
   * 存在，settle 路径负责它）。
   */
  discardEntry(sessionId: string, slug: string): void {
    const entries = this.ledger.get(sessionId)
    const cwd = this.ledgerCwds.get(sessionId)
    const entry = entries?.find(item => item.slug === slug)
    if (entries === undefined || entry === undefined || cwd === undefined) return
    if (entry.runId !== undefined) return
    corumCleanupWorktree(cwd, entry, { force: true })
    this.ledger.set(sessionId, entries.filter(item => item.slug !== slug))
    this.persist(sessionId)
    this.emitFrame(sessionId)
  }

  /**
   * fork（corum）：会话级「在跑写子 Agent」计数——并发感知隔离的输入。
   *
   * 与台账的区别：台账只登记**已隔离**的条目（worktree 路径/分支是它的语义），
   * 而并发判定必须连**不隔离**的在跑写子 Agent 一起算——否则同一条消息里并发发出
   * 的两个 `subagent` 前台调用会各自认为「没有并发」，双双写主工作区。
   * 计数在 spawn 前同步自增（JS 单线程，第二个调用必然看到第一个），settle/异常
   * 路径 `finally` 自减；不落盘（进程内事实）。
   */
  private readonly runningWriteChildren = new Map<string, number>()

  /** 登记一个在跑写子 Agent（spawn 前同步调用）。 */
  beginWriteChild(sessionId: string): void {
    this.runningWriteChildren.set(sessionId, (this.runningWriteChildren.get(sessionId) ?? 0) + 1)
  }

  /** 注销一个在跑写子 Agent（settle/异常后调用；计数归零即删表）。 */
  endWriteChild(sessionId: string): void {
    const next = (this.runningWriteChildren.get(sessionId) ?? 0) - 1
    if (next <= 0) this.runningWriteChildren.delete(sessionId)
    else this.runningWriteChildren.set(sessionId, next)
  }

  /** 该会话当前在跑的写子 Agent 数（>0 表示新派遣与它并发）。 */
  runningWriteChildrenOf(sessionId: string): number {
    return this.runningWriteChildren.get(sessionId) ?? 0
  }

  /**
   * fork（corum）：解析 `subagent/end` 对应的父会话 id。
   *
   * 优先用 dispatch carrier 解出的父 Agent（调用方经 `carrierKeyOf(this)` 取）；
   * carrier 缺失时用子会话 id 经 `agents` 服务反查 `session.header.parentSession`
   * （与 corum-tool-subagent 模型选择路径同款用法）。拿不到就返回 undefined——
   * 调用方静默跳过，绝不抛错（旧实现在此处抛错导致 settle 静默失效）。
   */
  private parentSessionIdOf(info: CorumSubagentEndInfo, parentAgent?: Agent): string | undefined {
    if (parentAgent !== undefined) return String(parentAgent.session.id)
    // 红线 3：跨包类型用局部能力接口收窄，不耦合官方实现包。
    const agents = this.ctx.get('agents') as
      | { get: (id: unknown) => { session: { header: { parentSession?: unknown } } } | undefined }
      | undefined
    const parent = agents?.get(info.id)?.session.header.parentSession
    return parent === undefined ? undefined : String(parent)
  }

  /**
   * subagent/end settle 联动（翻转成功时发射台账帧）。
   *
   * 2026-09-09 修复：`parentAgent` 改为可选——fork #9 的 `subagent/end` 声明父 Agent 是
   * dispatch 的 `this`（scope carrier）而非第二参数，监听端若拿不到就传 undefined；
   * 此时用 `info.id`（子会话 id）经 agents 服务反查父会话（session.header.parentSession）
   * 兜底，绝不抛错（旧实现 `parentAgent.session.id` 恒抛、被 emitter 吞掉 → settle 从未生效）。
   */
  settleFromEnd(info: CorumSubagentEndInfo, parentAgent?: Agent): boolean {
    const sessionId = this.parentSessionIdOf(info, parentAgent)
    if (sessionId === undefined) return false
    const entries = this.ledger.get(sessionId)
    if (entries === undefined) return false
    // 2026-09-15 机制补漏：**收口前强制提交**（用户裁定：机制保证，不由 Agent 自己决定）。
    // 在 `corumMarkSettled` **之前**做：未提交的隔离成果不允许存活过收口。
    // ⚠️ 本函数在 `subagent/end` 监听里被调用，而 **emitter 的 per-listener 容错会吞掉抛错**
    // （既有注释明写此前 `parentAgent.session.id` 抛错就是被吞掉的）⇒ **失败不能靠 throw 传给模型**，
    // 故失败原因**暂存到台账实例**，由调用方（corum-tool-subagent，已有 notice 投递机制）取走并投递。
    const failures: CorumSettleCommitFailure[] = []
    for (const entry of entries) {
      if (entry.status !== 'active') continue
      const failure = corumCommitWorktreeOnSettle(entry.path, entry.slug)
      if (failure !== undefined) failures.push(failure)
    }
    if (failures.length > 0) this.commitFailures.set(sessionId, failures)
    const flipped = corumMarkSettled(entries, { runId: String(info.runId), childId: String(info.id) })
    if (flipped) {
      this.persist(sessionId)
      this.emitFrame(sessionId)
    }
    return flipped
  }

  /**
   * fork（corum）：**取走**该会话最近一次收口的提交失败（取出即清，避免重复投递）。
   *
   * 与 {@link settleFromEnd} 配对：settle 负责尝试提交并暂存失败，
   * 调用方（`corum-tool-subagent`）取走后经 `parent.inject(...)` 以 notice 形态交给模型，
   * 由模型把提交完成（用户裁定：「commit 失败后交由模型处理并完成提交」）。
   * @param sessionId - 父会话 id（台账键）。**省略时取走并清空全部会话的暂存**——
   * 调用方拿不到父会话（`parent` undefined）时用它兜底，避免失败在实例里越积越多。
   * @returns 失败清单；无失败时为空数组。
   */
  drainSettleCommitFailures(sessionId?: string): readonly CorumSettleCommitFailure[] {
    if (sessionId !== undefined) {
      const failures = this.commitFailures.get(sessionId)
      if (failures === undefined) return []
      this.commitFailures.delete(sessionId)
      return failures
    }
    const all = [...this.commitFailures.values()].flat()
    this.commitFailures.clear()
    return all
  }

  /** 供单测直接操作台账（行为等价迁移前的测试面）。 */
  _testLedger(): Map<string, CorumWorktreeEntry[]> {
    return this.ledger
  }
}
