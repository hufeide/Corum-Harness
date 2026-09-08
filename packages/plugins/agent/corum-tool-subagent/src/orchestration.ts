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
 * @module @corum/corum-tool-subagent/orchestration
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
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

/** fork（corum）：隔离触发判定（readonlyResearch 实例恒不隔离）。 */
export function corumShouldIsolate(
  mode: 'always' | 'write-tasks' | 'off',
  isWriteTask: boolean,
  readonlyResearch: boolean,
): boolean {
  if (readonlyResearch) return false
  return mode === 'always' || (mode === 'write-tasks' && isWriteTask)
}

/** fork（corum）：最佳努力回滚/清理（清理失败不掩盖原始错误）。 */
export function corumCleanupWorktree(
  cwd: string,
  entry: Pick<CorumWorktreeEntry, 'path' | 'branch'>,
): void {
  try {
    corumGit(cwd, ['worktree', 'remove', '--force', entry.path])
  } catch {
    // Best effort: 台账仍登记，dispose 清理会重试。
  }
  try {
    corumGit(cwd, ['branch', '-D', entry.branch])
  } catch {
    // Best effort: 分支可能未建或已删。
  }
}

/** fork（corum）：删除指定状态的台账条目（worktree remove + branch -D + 标 discarded）。 */
export function corumCleanupLedgerEntries(
  cwd: string,
  entries: CorumWorktreeEntry[],
  statuses: readonly CorumWorktreeEntry['status'][],
): void {
  for (const entry of entries) {
    if (!statuses.includes(entry.status)) continue
    corumCleanupWorktree(cwd, entry)
    entry.status = 'discarded'
  }
}

/** fork（corum）：integrate 准入——active 或 settled 的待集成条目。 */
export function corumPendingIntegration(entries: CorumWorktreeEntry[]): CorumWorktreeEntry[] {
  return entries.filter(entry => entry.status === 'active' || entry.status === 'settled')
}

/**
 * fork（corum）：subagent/end settle 联动——按 runId 精确翻转 active→settled；
 * runId 未登记时回退匹配唯一 active 条目（continuable 登记的是 childId）。
 */
export function corumMarkSettled(
  entries: CorumWorktreeEntry[],
  settle: { runId?: string; childId?: string },
): boolean {
  if (settle.runId !== undefined) {
    const byRunId = entries.find(entry => entry.status === 'active' && entry.runId === settle.runId)
    if (byRunId !== undefined) {
      byRunId.status = 'settled'
      return true
    }
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

  /** 读某会话台账条目（不存在返回空数组，不自动建）。 */
  entriesOf(sessionId: string): CorumWorktreeEntry[] {
    return this.ledger.get(sessionId) ?? []
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

  /** 父 scope dispose 时清理未集成的 worktree。 */
  cleanupOnDispose(statuses: readonly CorumWorktreeEntry['status'][] = ['active', 'settled']): void {
    for (const [sessionId, entries] of this.ledger) {
      const cwd = this.ledgerCwds.get(sessionId)
      if (cwd === undefined) continue
      corumCleanupLedgerEntries(cwd, entries, statuses)
      this.persist(sessionId)
    }
  }

  /** subagent/end settle 联动（翻转成功时发射台账帧）。 */
  settleFromEnd(info: SubagentRunEndInfo, parentAgent: Agent): boolean {
    const sessionId = String(parentAgent.session.id)
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
