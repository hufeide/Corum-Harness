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
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-tools'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

// ── 台账类型与事件 ─────────────────────────────────────────────────────────

/** fork（corum）：会话级隔离台账条目（settled 不占 maxParallelChildren 额度）。 */
export interface CorumWorktreeEntry {
  readonly slug: string
  readonly branch: string
  readonly path: string
  status: 'active' | 'settled' | 'integrated' | 'discarded'
  /** settle 关联键——subagent/start|end 事件的 runId（session 级去重）。 */
  runId?: string
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
const CORUM_WRITE_TOOLS = ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh']

/**
 * fork（corum）：平台实际存在的写工具（deny 名单只能包含已注册工具——
 * tools.restrict 对未知名 fail loud。pwsh 仅在 win32 装载）。与 corum-agent
 * compile.ts 的 corumWriteToolsForPlatform 逐字对账（dev-conventions §4a 第 2 条
 * 两处对账）。orchestrate 任务级 research 的只读硬约束用它预 deny 写工具。
 */
export function corumWriteToolsForPlatform(): readonly string[] {
  return process.platform === 'win32'
    ? CORUM_WRITE_TOOLS
    : CORUM_WRITE_TOOLS.filter(tool => tool !== 'pwsh')
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
  if (corumWriteToolsForPlatform().every(t => toolFilter?.deny?.includes(t) === true)) return undefined
  return {
    ...toolFilter?.allow !== undefined ? { allow: toolFilter.allow } : {},
    deny: [...new Set([...(toolFilter?.deny ?? []), ...corumWriteToolsForPlatform()])],
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
 * @param filter - 机制生成的过滤器（config 原样透传的除外，见调用点）。
 * @param known - 目标 scope 可见的工具名（父 Agent scope 的可见名是其超集）。
 * @returns 收敛后的过滤器；deny 全被丢弃且无 allow 时返回 undefined（等于不限制）。
 */
export function corumNarrowDenyFilter(
  filter: { allow?: string[]; deny?: string[] } | undefined,
  known: ReadonlySet<string>,
): { allow?: string[]; deny?: string[] } | undefined {
  if (filter === undefined || filter.deny === undefined) return filter
  const deny = filter.deny.filter(name => known.has(name))
  if (deny.length === filter.deny.length) return filter
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
 * 2026-09-09 加固：仅在**完整清理**（目录已消失 + 分支已删）时标 `discarded`——
 * 安全模式下被保留的未合并分支/脏 worktree 保持原 status 并落盘，台账状态如实
 * 反映现场（此前无条件标 discarded 导致「worktree 已清、台账仍 active」的漂移）。
 */
export function corumCleanupLedgerEntries(
  cwd: string,
  entries: CorumWorktreeEntry[],
  statuses: readonly CorumWorktreeEntry['status'][],
  options: CorumCleanupOptions = {},
): void {
  for (const entry of entries) {
    if (!statuses.includes(entry.status)) continue
    if (corumCleanupWorktree(cwd, entry, options)) entry.status = 'discarded'
  }
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
  const byId = match(settle.runId) ?? match(settle.childId)
  if (byId !== undefined) {
    byId.status = 'settled'
    return true
  }
  if (settle.childId === undefined) return false
  const candidates = entries.filter(entry => entry.status === 'active' && entry.runId === undefined)
  if (candidates.length === 1) {
    candidates[0].status = 'settled'
    candidates[0].runId = settle.runId ?? settle.childId
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
 * - `integrated`：`unmerged` 与 `uncommitted` 均空才算真集成。
 */
export interface CorumIntegrationTruth {
  readonly integrated: boolean
  readonly unmerged: readonly string[]
  readonly uncommitted: readonly string[]
  readonly dirtyDelta: readonly string[]
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
 */
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
  const before = new Set(dirtyBefore.split('\n').filter(line => line.trim() !== ''))
  const dirtyDelta = corumGitStatusPorcelain(cwd)
    .split('\n')
    .filter(line => line.trim() !== '' && !before.has(line))
  return {
    integrated: unmerged.length === 0 && uncommitted.length === 0,
    unmerged,
    uncommitted,
    dirtyDelta,
    head: corumGitHead(cwd),
  }
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
  if (truth.dirtyDelta.length > 0) {
    lines.push(`main tree now has ${truth.dirtyDelta.length} uncommitted path(s) not present before integrate (e.g. ${truth.dirtyDelta.slice(0, 3).join(', ')})`)
  }
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
        this.ledger.set(sessionId, record.entries.map(e => ({ ...e })))
        this.ledgerCwds.set(sessionId, record.cwd)
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
      // 只落盘待集成条目（active/settled）；integrated/discarded 已清理，删记录。
      const pending = entries?.filter(e => e.status === 'active' || e.status === 'settled') ?? []
      if (pending.length === 0 || cwd === undefined) {
        await domain.table('ledger').delete(sessionId)
        return
      }
      await domain.table('ledger').put(sessionId, { cwd, entries: pending.map(e => ({ ...e })) })
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`corumOrchestration: persist ledger failed: ${String(error)}`)
    })
  }

  /**
   * 读某会话台账条目（不存在返回空数组，不自动建）。
   *
   * 2026-09-09：顺带剔除**彻底失效**的条目（worktree 与分支都不存在）——旧强删清理
   * 遗留的 active 条目会永久占用 `maxParallelChildren` 额度（实证：本仓
   * `corum-task-7cebf463` 的 3 条死条目使后续 spawn 只剩 1 个名额）。剔除后落盘。
   */
  entriesOf(sessionId: string): CorumWorktreeEntry[] {
    const entries = this.ledger.get(sessionId) ?? []
    const cwd = this.ledgerCwds.get(sessionId)
    if (cwd === undefined || entries.length === 0) return entries
    const alive = entries.filter(entry => !corumEntryDead(cwd, entry))
    if (alive.length === entries.length) return entries
    this.ledger.set(sessionId, alive)
    this.persist(sessionId)
    return alive
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
    mkdirSync(root, { recursive: true })
    try {
      corumGit(parentCwd, ['worktree', 'add', worktreePath, '-b', branch])
    } catch (error: unknown) {
      corumCleanupWorktree(parentCwd, { path: worktreePath, branch })
      throw error
    }
    this.addActiveEntry(sessionId, parentCwd, { slug, branch, path: worktreePath })
    return { slug, branch, path: worktreePath }
  }

  /** 台账变更后发射快照帧（renderer chip 订阅源）。 */
  emitFrame(sessionId: string): void {
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
    this.persist(sessionId)
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
  private parentSessionIdOf(info: SubagentRunEndInfo, parentAgent?: Agent): string | undefined {
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
  settleFromEnd(info: SubagentRunEndInfo, parentAgent?: Agent): boolean {
    const sessionId = this.parentSessionIdOf(info, parentAgent)
    if (sessionId === undefined) return false
    const entries = this.ledger.get(sessionId)
    if (entries === undefined) return false
    const flipped = corumMarkSettled(entries, { runId: String(info.runId), childId: String(info.id) })
    if (flipped) {
      this.persist(sessionId)
      this.emitFrame(sessionId)
    }
    return flipped
  }

  /** 供单测直接操作台账（行为等价迁移前的测试面）。 */
  _testLedger(): Map<string, CorumWorktreeEntry[]> {
    return this.ledger
  }
}
