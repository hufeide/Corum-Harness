/**
 * session-bar —— 会话顶栏的 corum 段（状态胶囊 + 常驻 Agent 胶囊 + 轨迹按钮）。
 *
 * 2026-09-10「顶栏归会话」：这一段原先由壳在**窗口级** float 层渲染
 * （`titlebar-row` 的 `.agentTitleBarSeat`，见 AppFrame 历史），会话拖出为独立
 * 窗口后它仍留在主窗口——独立窗口看不到会话标题/状态/子 Agent。现改为**注册进
 * 会话级槽**：
 *
 *   conversation.session.header.actions   ← 状态胶囊（含常驻 Agent 胶囊段）
 *   conversation.session.header.utilities ← 轨迹按钮（右对齐）
 *
 * 两个槽由 `@corum/corum-ui-conversation` 声明（官方 0.1.3 结构），宿主行是
 * 会话插件 `ConversationSessionHeader` 里的 titleRow（本会话已恢复该行）。
 * 会话拖出为独立窗口时 `?floating=conversation` 挂载 ConversationRoot → 同一
 * header → 本段随之出现（实测：浮动窗会恢复当前会话）。
 *
 * **为什么注册进槽而不是在壳里再画一份**：这两段需要会话作用域（sessionId +
 * 用 `useSessions` 读投影），槽 occupant 天然拿到 `SessionStandardProps`
 * （sessionId）与 `GlobalStandardProps`（useSessions），无需自建上下文桥；
 * 且只有一份实现（历史上曾同时存在壳实现与孤儿 SessionHeaderSlot，已收敛）。
 *
 * 红线：本文件属 corum-ide-ui（壳 bundle），不 import 任何 `@corum/corum-ui-
 * conversation` 的**运行时**导出——只用它的 SlotMap 类型声明（type-only），
 * 与 chat/questions/trajectory 的既有口径一致（见 docs/fork-delta.md §3.1）。
 *
 * @module corum-ide-ui/client/session-bar
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入 corum-ui-conversation 的 SlotMap 声明（header.actions /
// header.utilities 两个槽由它声明），让本文件的槽注册通过类型检查
// （TS 模块合并全局生效；与 corum-ui-questions 拉 conversation.input.dock 同法）。
import type {} from '@corum/corum-ui-conversation/client'
import { useDeveloperMode } from './settings/developer-mode.ts'
import css from './AppFrame.module.css'

/** session/list 行 projectionValues 的窄化形（顶栏统计的数据源）。
 *  字段名与官方 `dsh-session-stats/types` 的 `SessionStatsProjection` 同构。 */
interface SessionStatsProjection {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  /** 首词元延迟合计（`step/start` → 首个非空 delta），配合 ttftSteps 求平均。 */
  ttftMs?: number
  /** 带首词元记录（= 可用于求 TTFT 平均）的 step 数。 */
  ttftSteps?: number
  /** 解码墙钟合计（首词元 → assistant/message），配合 decodeTokens 求平均速度。 */
  decodeMs?: number
  /** 与 decodeMs 同口径的服务方输出词元数。 */
  decodeTokens?: number
}
interface TokenUsageProjection {
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
interface ContextPressureProjection {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}
interface ContextBreakdownProjection {
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
}
interface AgentSessionProjections {
  sessionStats?: SessionStatsProjection
  tokenUsage?: TokenUsageProjection
  contextPressure?: ContextPressureProjection
  contextBreakdown?: ContextBreakdownProjection
}

/**
 * 官方 SessionListState 的结构窄化（与 dsh-api-session-controller/client 同名
 * 类型同构；包未直接依赖该 controller——结构窄化避免新增运行时依赖，红线 3）。
 */
interface SessionListState {
  current?: string | undefined
  byId: Record<string, {
    blank?: boolean
    displayTitle?: string
    projectionValues?: unknown
    /** 该会话此刻是否在跑。 */
    running?: boolean
  } | undefined>
  /**
   * 官方「直接子会话目录」（durable catalog，key = 父会话 id）。**子 Agent 花名册的
   * 权威冷启动基线**：它由宿主 `subagent.list` 读子会话血缘得到，durable、随会话
   * 选择自动拉一次、并在 `setCatalogOpen` 期间随成员变更增量刷新。
   *
   * 为什么不用 `byId` 血缘兜底（前一版的错）：官方 `SessionSummary` 的字段名是
   * `parentId`（不是 `parentSessionId`），而且 `byId` **只装列表根行 + 当前寻址的
   * 面包屑链**，普通子 Agent 会话根本不在里面 —— 于是基线恒为空，胶囊与浮层都
   * 不显示子 Agent（就是用户实测到的现象）。
   */
  subagentsByParent?: Record<string, SessionCatalogSnapshot | undefined>
}

/** 官方子会话目录快照的窄化形（只读消费；结构同构于 `SubagentCatalogSnapshot`）。 */
interface SessionCatalogSnapshot {
  entries?: ReadonlyArray<SessionCatalogRow | undefined>
  state?: 'loading' | 'ready' | 'error'
}

/** 目录中的一行（只取本组件渲染所需字段；`diagnostic` 行没有 `activity`）。 */
interface SessionCatalogRow {
  kind?: 'child' | 'diagnostic'
  id?: string
  /** `inactive` = 只存在于持久化里（已不在跑）→ 展示为「已完成」。 */
  activity?: 'running' | 'inactive'
  /** 官方续聊能力（`one-shot` 不可续聊、`continuable` 可续聊）。 */
  mode?: 'one-shot' | 'continuable'
  label?: string
  hasChildren?: boolean
}

/**
 * `ctx.sessions` 的目录能力面（红线 3/4：由 inject 下发的本地能力接口收窄，
 * 不 import 官方 controller 实现包）。
 */
export interface SubagentCatalogFace {
  /** 主动拉一次直接子会话目录。 */
  refresh: (parentSessionId: string) => void
  /** 声明「本会话的目录有消费方」：为真期间官方按成员变更增量重拉，卸载后释放。 */
  setCatalogOpen: (parentSessionId: string, open: boolean) => void
}

/** 会话列表 selector hook（本组件只读血缘 / 标题 / 运行态）。 */
type UseSessionsHook = <T>(selector: (state: SessionListState) => T) => T

/** `ctx.remote` 的窄化面（只用到转发事件订阅）。 */
export interface RemoteEventFace {
  $on: (event: string, listener: (frame: never) => void) => () => void
}

/** 紧凑时长：12m 34s / 3.8秒（顶栏摘要 + 详情 Active 共用）。 */
function compactDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

/** 紧凑词元：12.4k / 3.1k / 178.3k（千分位紧凑，详情行用全量 toLocaleString）。 */
function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 解码速度文案：42 词元/s（中文口径——用户定：中文用「词元」，英文界面才用 tok/s）。 */
function compactTps(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return '—'
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} 词元/s`
}

/**
 * 顶栏合并胶囊的统计段（设计稿 ①②④ 的 status-pill stats 文案）。
 *
 * 口径（用户定调）：
 * - 轮次与步骤合并成 `X 轮 / X 步`（原为两个独立事实，占宽且信息密度低）；
 * - **词元输入/输出改为 context 占用百分比**（用户 2026-09-10：收起态不需要累计
 *   账单量，占用率才是「还能聊多久」的可执行信息；累计词元量保留在展开浮层的
 *   指标格里，一个事实一个家）。
 * - 命中率只留数值（缓存命中曲线已按用户要求删除）。
 *
 * @param p - 会话投影（可为 undefined，未上报时整段显示 —）。
 * @returns 形如 `4 轮 / 20 步 · 31m 26s · 上下文 2.1% · 命中 90%`。
 */
function agentStatsSummary(p: AgentSessionProjections | undefined): string {
  if (p === undefined) return '—'
  const turns = p.sessionStats?.turns ?? 0
  const steps = p.sessionStats?.steps ?? 0
  const active = (p.sessionStats?.llmMs ?? 0) + (p.sessionStats?.toolMs ?? 0)
  const input = (p.tokenUsage?.uncachedInputTokens ?? 0) + (p.tokenUsage?.cacheReadTokens ?? 0) + (p.tokenUsage?.cacheWriteTokens ?? 0)
  const cacheRead = p.tokenUsage?.cacheReadTokens ?? 0
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  return `${turns} 轮 / ${steps} 步 · ${compactDuration(active)} · 上下文 ${contextPercent(p)} · 命中 ${hit}%`
}

/**
 * context 占用百分比文案（`2.1%`；窗口未上报时 `—`）。
 *
 * 保留一位小数：窗口常是 1000k 量级，整数会把 0.4% 与 1.4% 都显示成「1%」，
 * 在低占用阶段丢掉全部分辨率（实测本会话 20.6k/1000k = 2.1%）。
 * @param p - 会话投影。
 * @returns 百分比文案（含 % 号）。
 */
function contextPercent(p: AgentSessionProjections | undefined): string {
  const used = p?.contextPressure?.pressureTokens ?? 0
  const window = p?.contextPressure?.contextWindow ?? 0
  if (window <= 0) return '—'
  return `${Math.round((used / window) * 1000) / 10}%`
}

/**
 * 每个 step 的解码速度采样点（设计稿 chart-speed 实时曲线的数据单元）。
 * `tps = 该步输出词元 / 该步解码秒数`。
 */
interface SpeedSample {
  /** step 序号（用于 React key 与「第 N 步」提示）。 */
  readonly step: number
  /** 该步解码速度（词元/s）。 */
  readonly tps: number
}

/** 曲线最多保留的采样点数（超出丢最旧；浮层宽度约 300px，40 点已足够密）。 */
const SPEED_SERIES_CAP = 40

/**
 * `useTrajectory` 快照的窄化面（只取 eventNodes；见下方 useSpeedSeries 的取数注释）。
 * 该 hook 由 corum-ui-trajectory 经 `SessionStandardProps` 模块合并声明，
 * 会话作用域 occupant 都能拿到——结构窄化避免本包新增运行时依赖（红线 3）。
 */
interface TrajectorySnapshotLike {
  readonly eventNodes?: readonly TrajectoryNodeLike[]
}
/** 轨迹事件节点里与吞吐曲线相关的字段（AssistantMessageNode 的子集）。 */
interface TrajectoryNodeLike {
  kind?: string
  turn?: number
  step?: number
  usage?: { outputTokens?: number } | undefined
  timing?: {
    stepStartTime?: number | null
    firstTokenTime?: number | null
    completedTime?: number
  } | undefined
}
export type UseTrajectoryHook = <T>(selector: (snapshot: TrajectorySnapshotLike) => T) => T

/** 空轨迹快照（缺省 hook 的返回值；模块级常量保证引用稳定，避免每次渲染换新数组）。 */
const EMPTY_TRAJECTORY_NODES: readonly TrajectoryNodeLike[] = []

/**
 * 缺省轨迹 hook（`useTrajectory` 未注入时的替身）。
 *
 * ⚠️ Rules of Hooks：不能按「prop 有没有」改变 hook 调用数量，故本函数**不调用任何
 * hook**（真实 `useTrajectory` 内部会调 useStore 之类）。两支的 hook 数因此不同，
 * 但该分支只随插件装配变化——本项目里 corum-ui-trajectory 是常驻插件
 * （见 `__DSH_BOOT__` 的 application 批），运行期不会翻转；真换成没装该插件的
 * 精简装配时需要重新挂载，属可接受边界（已在 docs/TODO.md 登记）。
 */
function useEmptyTrajectory<T>(_selector: (snapshot: TrajectorySnapshotLike) => T): T {
  return EMPTY_TRAJECTORY_NODES as unknown as T
}

/** 从一步 assistant 节点算解码速度（词元/s）；不可算返回 null。 */
function stepTps(node: TrajectoryNodeLike): number | null {
  const first = node.timing?.firstTokenTime
  const done = node.timing?.completedTime
  const tokens = node.usage?.outputTokens
  if (typeof first !== 'number' || typeof done !== 'number' || typeof tokens !== 'number') return null
  const decodeMs = Math.max(0, done - first)
  // 解码时长过短（<50ms）说明该步几乎瞬时结束，速度会是噪声级大数，跳过。
  if (decodeMs < 50 || tokens <= 0) return null
  const tps = tokens / (decodeMs / 1000)
  return Number.isFinite(tps) && tps > 0 ? tps : null
}

/**
 * 逐步解码速度序列（设计稿 chart-speed「生成速度」实时曲线）。
 *
 * **取数与可行性（用户 2026-09-10 点名要评估）**：
 * - 逐词元的 `assistant/live-chunk` 事件带 seq/time，但被 conversation 装配器内部
 *   消费，官方 `ISession` 面只暴露生命周期 + 行为动词 —— 槽位占用者拿不到事件窗口，
 *   故**不做**逐词元订阅（那需要新增宿主事件通路 + 重启，即 docs/TODO.md 的 B 档）。
 * - 这里走**真实历史**：`useTrajectory().eventNodes` 是本会话装配好的 assistant
 *   节点序列，每个节点自带 `timing`（stepStartTime/firstTokenTime/completedTime）
 *   与 `usage.outputTokens` —— 与官方 TrajectoryTable 算 TTFT/吞吐同源。
 *   于是 `tps = outputTokens / ((completedTime - firstTokenTime)/1000)` 得到每一步的
 *   真实速度，**已结束的会话也有完整曲线**（投影增量方案只能从挂载点开始累积，
 *   对历史会话恒为空——这正是第一版曲线画不出东西的原因，实测已证）。
 *
 * 仅取可算的步；按到达顺序（= step 升序）保留，超上限丢最旧。
 *
 * @param useTrajectory - 会话作用域标准 props 的轨迹快照 hook（缺失时用空实现）。
 * @returns 按时间升序的速度采样点。
 */
function useSpeedSeries(useTrajectory: UseTrajectoryHook | undefined): readonly SpeedSample[] {
  const hook = useTrajectory ?? useEmptyTrajectory
  const nodes = hook(s => s.eventNodes ?? EMPTY_TRAJECTORY_NODES)
  return useMemo(() => {
    const out: SpeedSample[] = []
    for (const node of nodes) {
      if (node.kind !== 'assistant') continue
      const tps = stepTps(node)
      if (tps === null) continue
      out.push({ step: node.step ?? out.length + 1, tps })
    }
    return out.slice(-SPEED_SERIES_CAP)
  }, [nodes])
}

/**
 * 生成速度曲线（设计稿 chart-speed）：折线 + 面积，横轴 = 步，纵轴 = 词元/s。
 *
 * 采样不足（<2 点）时**不画假曲线**，改为一条虚线基线。原因：本组件装在会话顶栏，
 * 页面刷新后历史帧不重放，`useSpeedSeries` 从当次挂载才开始累积，已结束的会话
 * 永远只有 0~1 个点——画成实心块会被误读为「速度恒为 0」。
 *
 * @param samples - 速度采样点（按时间升序）。
 * @param width - 画布宽（px）。
 * @param height - 画布高（px）。
 * @returns 折线 + 面积（或空态基线）的 SVG。
 */
function SpeedChart({ samples, width = 300, height = 138 }: {
  samples: readonly SpeedSample[]
  width?: number
  height?: number
}) {
  const pad = 10
  const inner = height - pad * 2
  // 纵轴上限：取样本最大值再上浮 15%（避免顶点贴底/贴顶），下限 10 防止除零。
  const peak = samples.length > 0 ? Math.max(...samples.map(s => s.tps)) : 0
  const maxV = Math.max(10, peak * 1.15)
  const n = samples.length
  if (n < 2) {
    // 空态：虚线基线（不填充），避免被读成「速度 0」的实心块。
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={css.statusDetailTrend}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1="0" y1={height / 2} x2={width} y2={height / 2}
          stroke="var(--corum-glass-border, rgba(185,140,255,.3))"
          strokeWidth="1" strokeDasharray="4 4"
        />
      </svg>
    )
  }
  const pts = samples.map((s, i) => [
    (i / (n - 1)) * width,
    pad + (1 - s.tps / maxV) * inner,
  ] as const)
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={css.statusDetailTrend}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill="var(--dsw-alias-brand-primary)" opacity="0.18" stroke="none" />
      <path d={line} fill="none" stroke="var(--dsw-alias-brand-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 子 Agent 终局原因（与 `@corum/corum-api-remotes/corum-events` 的
 *  `SubagentStopReason` 同构；本包不 import 该包——红线 3：跨 bundle 用本地
 *  能力接口收窄，与 `WorktreeLedgerFrame` 窄化注释同惯例）。 */
type SubagentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** RPC 返回的 stopReason 合法化（不认识的字符串不当成功）。 */
const VALID_STOP_REASONS = new Set<string>(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

/** stopReason → 三态终态（undefined = 运行中/未结束）；与 `subagentOutcomeOf` 同语义。 */
function subagentOutcomeOf(stopReason: SubagentStopReason | undefined): 'completed' | 'aborted' | 'failed' | undefined {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'error': case 'max-tokens': case 'refusal': return 'failed'
    case undefined: return undefined
  }
}

/** 子 Agent 花名册条目（会话顶栏常驻胶囊 + 详情浮层的子 Agent 区数据源）。 */
interface SubagentRosterEntry {
  readonly childSessionId: string
  readonly label: string
  /**
   * 前后台 / 隔离：**只有 corum 推送帧带这两个字段**（官方目录不带）。
   * 故它们是 optional 而非默认值——基线行不能凭空声明「后台」，否则浮层会对
   * 每个历史子 Agent 都挂一个不成立的徽标（用户看到的正是「全是后台」）。
   */
  readonly mode?: 'foreground' | 'background'
  readonly isolated?: boolean
  /** 子 Agent 实际在跑的模型（child 帧携带 + session/list 冷启动补强）。 */
  readonly model?: { provider: string; model: string }
  readonly step: number
  readonly currentAction?: string
  /** 最新 turn 已闭合（turn/end）；只表示 turn 闭合，不代表终态。 */
  readonly done: boolean
  /** 终局原因；仅在该 turn 闭合时给出（undefined = 运行中/未结束）。 */
  readonly stopReason?: SubagentStopReason
  readonly lastActive: number
}

/** 花名册内帧形（corum/subagent/child 与 corum/subagent/progress 的并集窄化）。 */
interface ChildFrame {
  parentSessionId?: string
  callId?: string
  childSessionId?: string
  label?: string
  mode?: 'foreground' | 'background'
  isolated?: boolean
  /** child 帧携带的 worktree 三件套（仅隔离时非空；用于 slug→model 关联）。 */
  worktree?: { slug?: string; branch?: string; path?: string }
  /** child 帧携带的真实生效模型路由（progress 帧不带）。 */
  model?: { provider?: string; model?: string; reasoningEffort?: string }
  sessionId?: string
  turn?: number
  step?: number
  currentAction?: string
  done?: boolean
  stopReason?: SubagentStopReason
  lastActive?: number
}

/**
 * 当前会话的子 Agent 花名册（2026-09-10 用户定调：常驻胶囊与状态展示合并）。
 *
 * 数据源 = 统一事件中心转发帧（`corum/subagent/child` 精确父子映射 +
 * `corum/subagent/progress` 进度推送），按父会话过滤后折叠成条目；运行中在前、
 * 最近活动排序。页面刷新后无回放帧，花名册从空开始，下一次派遣即恢复
 * （与 SubagentCard 的「广播优先、时间就近兜底」同源，这里只取精确通道）。
 */
/**
 * 子 Agent 花名册 = **官方直接子会话目录（durable 基线）** + **corum 推送帧增量**。
 *
 * ① 基线为什么必须有：推送帧（`corum/subagent/child` / `corum/subagent/progress`）只在
 *    **变更时**发，页面刷新 / 应用重启 / 会话切走再切回**都不会重放** —— 纯推送订阅会让
 *    「已经跑完的子 Agent」永远消失。用户实测到的「胶囊与展开浮层都不显示子 Agent」
 *    就是这么来的：设计稿的浮层明确要求列出 `2 运行中 · 1 已完成`，而 roster 是空的。
 *    这与 host `getWorktreeLedger` 注释记载的是同一个坑（推送为主 + 快照冷启动基线）。
 *    基线源 = 官方 `ctx.sessions` 同步过来的 `subagentsByParent`（宿主 `subagent.list`
 *    读子会话血缘，durable、零新增 RPC）；编排模式下派出的子 Agent 同样是 subagent
 *    会话，所以一并覆盖。
 *
 * ② 「是否还在跑」以目录行的 `activity` 为准（`running` / `inactive`）；推送帧的
 *    `done` 只在目录里找不到该子会话时兜底（避免帧停在旧状态）。
 *
 * ③ 目录的**新鲜度**靠 `setCatalogOpen(parent, true)`：官方在成员变更帧到达时防抖重拉
 *    该父的目录，本组件常驻会话顶栏，所以整个会话生命周期内都订阅（见下方 effect）。
 */
function useSubagentRoster(
  remote: RemoteEventFace | undefined,
  sessionId: string | undefined,
  useSessions: UseSessionsHook,
  catalog: SubagentCatalogFace | undefined,
  connection: RpcFace | undefined,
): readonly SubagentRosterEntry[] {
  const rows = useSessions((state: SessionListState) => {
    return sessionId === undefined ? undefined : state.subagentsByParent?.[sessionId]?.entries
  })
  /**
   * 打开目录订阅（官方机制）：
   * `refresh` 补一次立即拉取；`setCatalogOpen(true)` 让官方在**成员变更帧**到达时
   * 防抖重拉——这是「新派出的子 Agent 无需刷新页面就出现在胶囊里」的唯一正路
   * （推送帧 `corum/subagent/*` 不重放，只做增量覆盖）。卸载时释放，避免常驻订阅。
   */
  useEffect(() => {
    if (sessionId === undefined || catalog === undefined) return undefined
    catalog.refresh(sessionId)
    catalog.setCatalogOpen(sessionId, true)
    return () => { catalog.setCatalogOpen(sessionId, false) }
  }, [catalog, sessionId])
  const baseline = useMemo((): readonly SubagentRosterEntry[] => {
    const out: SubagentRosterEntry[] = []
    if (rows === undefined) return out
    for (const row of rows) {
      // `diagnostic` 行是目录读取失败的占位（没有 activity/label），不进花名册。
      if (row === undefined || row.kind !== 'child' || row.id === undefined) continue
      out.push({
        childSessionId: row.id,
        label: row.label !== undefined && row.label !== '' ? row.label : row.id,
        // mode/isolated 故意**不给默认值**（官方目录没有这两轴，见类型注释）；
        // step 先给 0，corum 推送帧到了由下面的合并覆盖。
        step: 0,
        // 目录基线只有 running/inactive 两态，无法区分 aborted：
        // inactive 可能是已完成、也可能是手动终止——此处作为无推送帧时的兜底，
        // 真正的终态判定以推送帧的 stopReason 为准（见合并与渲染）。
        done: row.activity !== 'running',
        lastActive: 0,
      })
    }
    return out
  }, [rows])

  /** 冷启动终态种子：目录基线只区分 running/inactive，已结束（inactive）的子会话
   *  无法区分「正常完成」与「手动终止」。推送帧不重放（刷新/重启/切走后丢失），
   *  故对已结束的子会话一次性 RPC 拉 stopReason，只填补、不覆盖推送帧的权威值。
   *  会话切走/换 sessionId 时重置已拉记录。 */
  const [seededStopReason, setSeededStopReason] = useState<ReadonlyMap<string, SubagentStopReason>>(new Map())
  const seededRef = useRef<Set<string>>(new Set())
  // 已结束的子会话 id 列表（只在成员变化时变，不受 step 等增量字段影响）。
  const finishedIds = useMemo(
    () => baseline.filter(e => e.done).map(e => e.childSessionId),
    [baseline],
  )
  useEffect(() => {
    // 会话切换时清空种子与已拉记录，避免跨会话串数据。
    seededRef.current = new Set()
    setSeededStopReason(new Map())
    if (connection === undefined || sessionId === undefined) return undefined
    let cancelled = false
    for (const id of finishedIds) {
      // 只拉尚未拉过的子会话（running 的不在 finishedIds 里）。
      if (seededRef.current.has(id)) continue
      seededRef.current.add(id)
      void (async () => {
        try {
          const result = await connection.rpc.call('/api', 'corumAgent/getChildSessionProgress', {
            args: { sessionId: id },
          })
          if (cancelled || !result.ok || result.value === undefined) return
          const value = result.value as { progress?: { stopReason?: string } }
          const raw = value.progress?.stopReason
          if (raw === undefined) return
          if (!VALID_STOP_REASONS.has(raw)) return
          const sr = raw as SubagentStopReason
          setSeededStopReason(prev => {
            const next = new Map(prev)
            next.set(id, sr)
            return next
          })
        } catch {
          // 拉取失败静默忽略（与兜底风格一致：可见性增强，绝不影响会话）。
        }
      })()
    }
    return () => { cancelled = true }
  }, [connection, sessionId, finishedIds])

  /**
   * 冷启动模型补强：基线（官方目录）不带模型字段，页面刷新后推送帧不重放。
   * 按 SubagentCard.useChildModel 同口径一次性拉 session/list（limit 200），
   * 批量映射 childSessionId → modelSelection.lastUsed。拉不到或不在表里 →
   * 保持 undefined（渲染时显式显示「未记录」）。
   *
   * 并行工作区行不由此补强：台账 slug 无法经 session/list 关联，刷新后
   * 显示「未记录」是预期且可接受的——不硬造数据。
   */
  const [seededModel, setSeededModel] = useState<ReadonlyMap<string, { provider: string; model: string }>>(new Map())
  useEffect(() => {
    setSeededModel(new Map())
    if (connection === undefined || sessionId === undefined) return undefined
    let cancelled = false
    void (async () => {
      try {
        const result = await connection.rpc.call('/api', 'session/list', { args: { _request: { limit: 200 } } })
        if (cancelled || !result.ok || result.value === undefined) return
        const value = result.value as {
          items?: ReadonlyArray<{
            sessionId?: string
            projections?: { values?: { modelSelection?: { lastUsed?: { provider?: string; model?: string } } } }
          }>
        }
        const map = new Map<string, { provider: string; model: string }>()
        for (const item of value.items ?? []) {
          if (item.sessionId === undefined) continue
          const m = item.projections?.values?.modelSelection?.lastUsed
          if (m?.model === undefined || m.model === '' || m.provider === undefined) continue
          map.set(item.sessionId, { provider: m.provider, model: m.model })
        }
        if (map.size === 0) return
        if (cancelled) return
        setSeededModel(map)
      } catch {
        // 单次失败静默忽略（模型行缺省显示「未记录」）。
      }
    })()
    return () => { cancelled = true }
  }, [connection, sessionId])

  const live = useLiveRoster(remote, sessionId)
  return useMemo(() => {
    const merged = new Map<string, SubagentRosterEntry>()
    for (const entry of baseline) merged.set(entry.childSessionId, entry)
    // 冷启动种子填补 stopReason（仅当推送帧未给时；推送帧的值更权威）。
    for (const [id, sr] of seededStopReason) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.stopReason === undefined) {
        merged.set(id, { ...entry, stopReason: sr })
      }
    }
    // 冷启动种子填补 model（仅当基线 / 推送帧都没给时；推送帧的值更权威）。
    for (const [id, m] of seededModel) {
      const entry = merged.get(id)
      if (entry !== undefined && entry.model === undefined) {
        merged.set(id, { ...entry, model: m })
      }
    }
    for (const entry of live) {
      const prior = merged.get(entry.childSessionId)
      // done/stopReason 以推送帧（live）为准：目录基线只有 running/inactive 两态，
      // 无法区分 aborted（见基线注释）；推送帧带 stopReason 时它才是权威终态。
      // model 同步用与 label/step 同款的继承语义：live 无 model 时继承 prior（基线
      // 或 session/list 补强的值），避免 progress 帧把已有 model 抹掉。
      merged.set(entry.childSessionId, {
        ...entry,
        ...prior === undefined ? {} : { label: entry.label === '' ? prior.label : entry.label },
        ...prior !== undefined && entry.step === 0 ? { step: prior.step } : {},
        ...(entry.model === undefined && prior?.model !== undefined ? { model: prior.model } : {}),
      })
    }
    return [...merged.values()]
  }, [baseline, live, seededStopReason, seededModel])
}

/** 推送帧累积（历史上的唯一来源；现在只作基线之上的增量）。 */
function useLiveRoster(remote: RemoteEventFace | undefined, sessionId: string | undefined): readonly SubagentRosterEntry[] {
  const [entries, setEntries] = useState<readonly SubagentRosterEntry[]>([])
  useEffect(() => {
    if (remote === undefined || sessionId === undefined) { setEntries([]); return undefined }
    setEntries([])
    const upsert = (patch: Partial<SubagentRosterEntry> & { childSessionId: string }): void => {
      setEntries((prev) => {
        const index = prev.findIndex(e => e.childSessionId === patch.childSessionId)
        if (index < 0) {
          if (patch.label === undefined) return prev
          return [...prev, {
            childSessionId: patch.childSessionId,
            label: patch.label,
            ...(patch.mode === undefined ? {} : { mode: patch.mode }),
            ...(patch.isolated === undefined ? {} : { isolated: patch.isolated }),
            ...(patch.model === undefined ? {} : { model: patch.model }),
            step: patch.step ?? 0,
            ...(patch.currentAction === undefined ? {} : { currentAction: patch.currentAction }),
            done: patch.done ?? false,
            ...(patch.stopReason === undefined ? {} : { stopReason: patch.stopReason }),
            lastActive: patch.lastActive ?? Date.now(),
          }]
        }
        const next = [...prev]
        next[index] = { ...next[index], ...patch } as SubagentRosterEntry
        return next
      })
    }
    const disposeChild = remote.$on('corum/subagent/child', (frame: ChildFrame) => {
      if (frame.parentSessionId !== sessionId || frame.childSessionId === undefined) return
      upsert({
        childSessionId: frame.childSessionId,
        ...(frame.label === undefined ? {} : { label: frame.label }),
        ...(frame.mode === undefined ? {} : { mode: frame.mode }),
        ...(frame.isolated === undefined ? {} : { isolated: frame.isolated }),
        ...(frame.model === undefined || frame.model.model === undefined || frame.model.provider === undefined
          ? {}
          : { model: { provider: frame.model.provider, model: frame.model.model } }),
        lastActive: Date.now(),
      })
    })
    const disposeProgress = remote.$on('corum/subagent/progress', (frame: ChildFrame) => {
      if (frame.sessionId === undefined) return
      upsert({
        childSessionId: frame.sessionId,
        ...(frame.step === undefined ? {} : { step: frame.step }),
        ...(frame.currentAction === undefined ? {} : { currentAction: frame.currentAction }),
        ...(frame.done === undefined ? {} : { done: frame.done }),
        ...(frame.stopReason === undefined ? {} : { stopReason: frame.stopReason }),
        ...(frame.lastActive === undefined ? {} : { lastActive: frame.lastActive }),
      })
    })
    return () => { disposeChild(); disposeProgress() }
  }, [remote, sessionId])
  return entries
}

/**
 * `corum/worktree-ledger` 转发帧的窄化形（宿主 fork #10 发射，按父 sessionId 过滤）。
 * 字段与 `@corum/corum-api-remotes/corum-events` 的 `CorumWorktreeLedgerFrameEvent`
 * 结构同构——本包不 import 该包（红线 3：跨 bundle 用本地能力接口收窄）。
 */
interface WorktreeLedgerFrame {
  sessionId?: string
  entries?: ReadonlyArray<{
    slug?: string
    branch?: string
    path?: string
    status?: string
  }>
  pending?: number
}

/** 一条隔离工作区（渲染用，字段已归一）。 */
interface WorktreeEntry {
  readonly slug: string
  readonly branch: string
  readonly status: string
  /** 该工作区对应的子 Agent 真实模型（child 帧 worktree.slug 关联）。 */
  readonly model?: { provider: string; model: string }
}

/** 台账状态文案（与 SubagentCard 的 WORKTREE_STATUS_LABEL 同口径）。 */
const WORKTREE_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  settled: '待集成',
  integrated: '已集成',
  discarded: '已丢弃',
}

/**
 * 当前会话的隔离 worktree 台账（「并行工作区」区的数据源）。
 *
 * 为什么搬到这里：`SubagentCard` 卡内的「并行工作区」chip 在 P8（逐次成节点）后
 * 被移除——按次成节点会让它在每张卡上重复 N 份。用户定调的新家 = **会话条状态
 * 胶囊的展开浮层**（与子 Agent 区并列），一个会话一处、不重复。
 *
 * @param remote - 统一事件中心 remote 面（缺省不订阅）。
 * @param sessionId - 当前��话 id（按父会话过滤帧）。
 * @returns 台账条目（无台账时为空数组）。
 */
function useWorktreeLedger(
  remote: RemoteEventFace | undefined,
  sessionId: string | undefined,
  connection: RpcFace | undefined,
): readonly WorktreeEntry[] {
  const [entries, setEntries] = useState<readonly WorktreeEntry[]>([])
  // slug → model 映射：child 帧携带 worktree.slug + model，隔离子 Agent 的
  // 工作区行据此关联模型。台账帧本身不带 model（不改 CorumWorktreeEntry）。
  // 用 ref 而非 state——避免 child 帧到达时 effect 重跑（effect 依赖里没有它）。
  const slugModelRef = useRef<ReadonlyMap<string, { provider: string; model: string }>>(new Map())
  useEffect(() => {
    if (sessionId === undefined) { setEntries([]); slugModelRef.current = new Map(); return undefined }
    setEntries([])
    slugModelRef.current = new Map()
    // child 帧的 model 写入 slug→model 映射（只取隔离帧的 worktree.slug）。
    const disposeChild = remote?.$on('corum/subagent/child', (frame: ChildFrame) => {
      if (frame.parentSessionId !== sessionId) return
      const slug = frame.worktree?.slug
      const m = frame.model
      if (slug === undefined || m?.provider === undefined || m?.model === undefined) return
      // 提取为非可选 string 常量，避免闭包内类型收窄丢失。
      const provider = m.provider
      const model = m.model
      const existing = slugModelRef.current.get(slug)
      if (existing !== undefined && existing.provider === provider && existing.model === model) return
      const next = new Map(slugModelRef.current)
      next.set(slug, { provider, model })
      slugModelRef.current = next
      // 若已有该 slug 的台账行，就地更新 model 字段（台账帧不重放，child 帧后到时
      // 需主动刷一次 entries）。
      setEntries(prev => {
        const idx = prev.findIndex(e => e.slug === slug)
        if (idx < 0) return prev
        const updated = [...prev]
        updated[idx] = { ...updated[idx], model: { provider, model } }
        return updated
      })
    })
    /** 帧 → 渲染形（归一字段、跳过畸形条目、合并 slug→model）。 */
    const apply = (frame: WorktreeLedgerFrame): void => {
      const next: WorktreeEntry[] = []
      for (const entry of frame.entries ?? []) {
        if (entry.slug === undefined || entry.branch === undefined) continue
        const m = slugModelRef.current.get(entry.slug)
        next.push({
          slug: entry.slug,
          branch: entry.branch,
          status: entry.status ?? 'active',
          ...m !== undefined ? { model: m } : {},
        })
      }
      setEntries(next)
    }
    // 冷启动基线：台账推送只在**变更时** emit，页面刷新后不重放——不拉一次的话
    // 历史会话永远看到空台账（而「待集成」正是刷新后最需要看的信息）。
    let cancelled = false
    const pullBaseline = async (): Promise<void> => {
      if (connection === undefined) return
      try {
        const result = await connection.rpc.call('/api', 'corumAgent/getWorktreeLedger', { args: { sessionId } })
        if (cancelled || !result.ok || result.value === undefined) return
        apply(result.value as WorktreeLedgerFrame)
      } catch {
        // 拉取失败保持空台账（推送帧仍会补齐）。
      }
    }
    void pullBaseline()
    const disposeLedger = remote?.$on('corum/worktree-ledger', (frame: WorktreeLedgerFrame) => {
      if (frame.sessionId !== sessionId) return
      apply(frame)
    })
    return () => {
      cancelled = true
      disposeChild?.()
      disposeLedger?.()
    }
  }, [remote, sessionId, connection])
  return entries
}

/** 运行中（无终态）在前、已结束在后，最近活动倒序（胶囊取第一个当「当前子 Agent」）。 */
function rankRoster(entries: readonly SubagentRosterEntry[]): readonly SubagentRosterEntry[] {
  return [...entries].sort((a, b) => {
    const aEnded = subagentOutcomeOf(a.stopReason) !== undefined
    const bEnded = subagentOutcomeOf(b.stopReason) !== undefined
    return (Number(aEnded) - Number(bEnded)) || (b.lastActive - a.lastActive)
  })
}

/**
 * 状态栏详情卡（设计稿 ④ J3tMzR「合并态下拉浮层」）：点击 status-pill 展开的
 * 会话统计浮层。结构自上而下（与设计稿逐段对应）：
 *   1. 标题行（状态点 + `会话统计 · <会话名>`）
 *   2. 3 列指标格 ×2 行：轮次/步骤（合并）· 工作时长 · LLM 思考
 *                       词元输入 · 词元输出 · 工具调用
 *   3. 两列图表：左 = 生成速度实时曲线（+ 平均 / 首词元平均）；右 = 上下文 donut + 图例
 *   4. 分隔线 + 子 Agent 列表（运行中在前，可点击进入子会话）
 *
 * 用户 2026-09-10 定调：轮次与步骤合并成 `X 轮 / X 步`；「LLM 思考」用
 * `sessionStats.llmMs`（= step/start → assistant/message，与工具调用相加 = 工作时长）；
 * 缓存命中与累计费用**不画曲线**（命中率数值仍在顶栏胶囊；基座无会话级费用投影）。
 *
 * 上下文 donut 的口径（修 2026-09-10 发现的 129% bug）：只画**当前占用**的构成
 * （对话消息 / 系统提示词 / 工具 / 未用，合计恒为 100%）。旧实现把累计账单量
 * `tokenUsage`（整段日志累加）和当前占用 `contextPressure.pressureTokens` 混在
 * 同一个饼里，四段相加 129.3%——几何上不成立。累计账单留在上方指标格的
 * 「词元输入/输出」。`contextBreakdown` 是启发式构成近似（基座注释：never as a total），
 * 故这里用它只表达占比，且与 pressureTokens 的差额归入「未用」以保证合计闭合。
 */
function AgentStatusDetail({ title, projections: p, anchor, roster, openSession, speedSeries, worktrees }: {
  title: string
  projections: AgentSessionProjections | undefined
  /** 会话顶栏行在**包含块坐标系**中的盒子（left/width），详情卡据此水平居中
   *  （见 SessionStatusPill 的锚点测量注释：fixed 的包含块不是视口）。 */
  anchor: { left: number; width: number }
  /** 子 Agent 花名册（用户 2026-09-10：下拉浮层在下方追加 subagent 信息）。 */
  roster: readonly SubagentRosterEntry[]
  /** 打开会话（子 Agent 行点击 → 进入该子会话）。 */
  openSession?: ((sessionId: string) => void) | undefined
  /** 生成速度采样序列（useSpeedSeries；空序列时曲线画基线占位）。 */
  speedSeries: readonly SpeedSample[]
  /** 隔离工作区台账（用户 2026-09-10：P8 后 chip 的新家 = 本浮层）。 */
  worktrees: readonly WorktreeEntry[]
}) {
  const stats = p?.sessionStats
  const usage = p?.tokenUsage
  const pressure = p?.contextPressure
  const breakdown = p?.contextBreakdown
  const turns = stats?.turns ?? 0
  const steps = stats?.steps ?? 0
  const llmMs = stats?.llmMs ?? 0
  const toolMs = stats?.toolMs ?? 0
  const active = llmMs + toolMs
  const input = (usage?.uncachedInputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
  const output = usage?.outputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? 0
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  const ctxUsed = pressure?.pressureTokens ?? 0
  const ctxWindow = pressure?.contextWindow ?? 0
  const ctxPct = ctxWindow > 0 ? Math.round((ctxUsed / ctxWindow) * 1000) / 10 : 0
  const system = breakdown?.systemTokens ?? 0
  const tools = breakdown?.toolsTokens ?? 0
  const messages = breakdown?.messageTokens ?? 0
  // 平均解码速度（整段累计口径：decodeTokens / decodeMs）与首词元平均延迟。
  const decodeMs = stats?.decodeMs ?? 0
  const decodeTokens = stats?.decodeTokens ?? 0
  const avgTps = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : 0
  const ttftSteps = stats?.ttftSteps ?? 0
  const avgTtftMs = ttftSteps > 0 ? (stats?.ttftMs ?? 0) / ttftSteps : 0
  // 当前占用构成（设计稿 chart-context 的 donut）：三段启发式 + 未用补数。
  //
  // ⚠️ 「未用」必须由**三段之和**反推，不能用 `ctxWindow - ctxUsed`：`ctxUsed`
  // （provider 锚定的 pressureTokens）与 `contextBreakdown` 的启发式三段是两个
  // 不同估计器，基座注释明确说二者**不会相等**。若拿 ctxUsed 求补数，图例四项
  // 之和会超过窗口上限（实测 1002.8k / 1000k），饼图几何上不成立——这正是旧实现
  // 四段相加 129% 的同类错误。这里以三段之和为分母保证**合计恒等于窗口**，
  // 环心仍显示权威占用率 ctxPct（两者微小差异属估计器固有，见基座注释）。
  const ctxParts = messages + system + tools
  const ctxFree = Math.max(0, ctxWindow - ctxParts)
  const ctxSum = ctxParts + ctxFree || 1
  const pctOf = (n: number): number => Math.round((n / ctxSum) * 1000) / 10
  // 曲线读数：latest = 最近一步速度（无序列时退回整段平均，避免空态显示「—」）；峰值 = 样本最大。
  const nowTps = speedSeries.length > 0 ? (speedSeries[speedSeries.length - 1]?.tps ?? avgTps) : avgTps
  const peakTps = speedSeries.length > 0 ? Math.max(...speedSeries.map(s => s.tps)) : 0
  // 曲线：本条会话的真实逐步速度；空序列时弧长/顶点都退化，交给 SpeedChart 画基线。
  // 3 列指标格（设计稿 ④）：key 上 / value 下，两行共 6 项。
  const metrics: ReadonlyArray<readonly [string, string]> = [
    ['轮次 / 步骤', `${turns} 轮 / ${steps} 步`],
    ['工作时长 Active', compactDuration(active)],
    ['LLM 思考', compactDuration(llmMs)],
    ['词元输入 Input', compactTokens(input)],
    ['词元输出 Output', compactTokens(output)],
    ['工具调用 Tool', `${toolMs > 0 ? compactDuration(toolMs) : '—'}${hit > 0 ? ` · 命中 ${hit}%` : ''}`],
  ]
  return (
    <div
      className={css.statusDetail}
      role="dialog"
      aria-label="会话统计详情"
      style={{ left: anchor.left + anchor.width / 2 }}
    >
      <div className={css.statusDetailHead}>
        <span className={css.statusDetailDot} />
        <span className={css.statusDetailTitle}>会话统计 · {title}</span>
      </div>
      {/* 3 列指标格 ×2 行（设计稿 ④ mrow/stat/k/v）。 */}
      <div className={css.statusDetailGrid}>
        {metrics.map(([k, v]) => (
          <div key={k} className={css.statusDetailStat}>
            <span className={css.statusDetailStatKey}>{k}</span>
            <span className={css.statusDetailStatValue}>{v}</span>
          </div>
        ))}
      </div>
      {/* 图表两列（设计稿 ④ charts）：左 = 生成速度实时曲线，右 = 上下文 donut+图例。 */}
      <div className={css.statusDetailChartsRow}>
        {/* 生成速度（chart-speed）：实时曲线 + 平均 / 首词元平均。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColHead}>
            <span className={css.statusDetailChartColLabel}>生成速度</span>
            <span className={css.statusDetailChartColSpacer} />
            <span className={css.statusDetailPulse} />
            <span className={css.statusDetailChartLive}>{compactTps(nowTps)}</span>
          </span>
          <SpeedChart samples={speedSeries} width={300} height={138} />
          <span className={css.statusDetailSpeedFoot}>
            <span className={css.statusDetailSpeedItem}>
              <span className={css.statusDetailSpeedKey}>平均</span>
              <span className={css.statusDetailSpeedValue}>{compactTps(avgTps)}</span>
            </span>
            <span className={css.statusDetailSpeedItem}>
              <span className={css.statusDetailSpeedKey}>首词元平均</span>
              <span className={css.statusDetailSpeedValue}>{avgTtftMs > 0 ? compactDuration(avgTtftMs) : '—'}</span>
            </span>
            {peakTps > 0 && (
              <span className={css.statusDetailSpeedItem}>
                <span className={css.statusDetailSpeedKey}>峰值</span>
                <span className={css.statusDetailSpeedValue}>{compactTps(peakTps)}</span>
              </span>
            )}
          </span>
        </div>
        {/* 上下文占用（chart-context）：donut（构成占比，合计 100%）+ 图例。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColLabel}>
            上下文 Context{ctxWindow > 0 ? ` · 上限 ${compactTokens(ctxWindow)}` : ''}
          </span>
          {ctxWindow > 0 ? (
            <>
              <span className={css.statusDetailDonut} style={{
                background: `conic-gradient(var(--dsw-alias-brand-primary) 0deg ${pctOf(messages) * 3.6}deg, `
                  + `var(--dsw-alias-state-warn-primary, #FFB45C) ${pctOf(messages) * 3.6}deg ${(pctOf(messages) + pctOf(system)) * 3.6}deg, `
                  + `var(--corum-brand-accent, #FF71CE) ${(pctOf(messages) + pctOf(system)) * 3.6}deg ${(pctOf(messages) + pctOf(system) + pctOf(tools)) * 3.6}deg, `
                  + `var(--corum-glass-2, rgba(42,24,64,.85)) ${(pctOf(messages) + pctOf(system) + pctOf(tools)) * 3.6}deg 360deg)`,
              }}>
                <span className={css.statusDetailDonutCenter}>
                  <span className={css.statusDetailDonutPct}>{ctxPct}%</span>
                  <span className={css.statusDetailDonutCap}>已用 {compactTokens(ctxUsed)}</span>
                </span>
              </span>
              <span className={css.statusDetailLegend}>
                {([
                  ['var(--dsw-alias-brand-primary)', '对话消息', messages],
                  ['var(--dsw-alias-state-warn-primary, #FFB45C)', '系统提示词', system],
                  ['var(--corum-brand-accent, #FF71CE)', '工具', tools],
                  ['var(--corum-glass-2, rgba(42,24,64,.85))', '未用', ctxFree],
                ] as const).map(([color, label, n]) => (
                  <span key={label} className={css.statusDetailLegendRow}>
                    <span className={css.statusDetailLegendDot} style={{ background: color }} />
                    <span className={css.statusDetailLegendLabel}>{label}</span>
                    <span className={css.statusDetailLegendValue}>{compactTokens(n)}</span>
                  </span>
                ))}
              </span>
            </>
          ) : (
            <span className={css.statusDetailChartEmpty}>暂未上报上下文占用</span>
          )}
        </div>
      </div>
      <div className={css.statusDetailDivider} />
      {/* 子 Agent 区（用户 2026-09-10：下拉浮层在下方追加 subagent 信息，与统计同卡统一）。
          运行中在前、已结束在后；每行 = 状态点 + 标签 + Step + 前后台/隔离徽标，
          点击进入该子会话（官方 lineage 下拉已按「顶栏只保留一个下拉」屏蔽）。 */}
      {roster.length > 0 && (
        <div className={css.statusDetailAgents}>
          <div className={css.statusDetailAgentsHead}>
            <span className={css.statusDetailAgentsTitle}>子 Agent</span>
            <span className={css.statusDetailAgentsCount}>
              {roster.filter(e => subagentOutcomeOf(e.stopReason) === undefined).length} 运行中{' · '}
              {roster.filter(e => subagentOutcomeOf(e.stopReason) === 'completed').length} 已完成
              {roster.some(e => subagentOutcomeOf(e.stopReason) === 'aborted') && ` · ${roster.filter(e => subagentOutcomeOf(e.stopReason) === 'aborted').length} 手动终止`}
              {roster.some(e => subagentOutcomeOf(e.stopReason) === 'failed') && ` · ${roster.filter(e => subagentOutcomeOf(e.stopReason) === 'failed').length} 失败`}
            </span>
          </div>
          {rankRoster(roster).map((entry) => {
            const outcome = subagentOutcomeOf(entry.stopReason)
            return (
            <button
              key={entry.childSessionId}
              type="button"
              className={css.statusDetailAgentRow}
              data-done={outcome !== undefined || entry.done || undefined}
              data-outcome={outcome ?? undefined}
              title={`进入子会话 ${entry.childSessionId}`}
              aria-label={`进入子会话 ${entry.label}`}
              onClick={() => { openSession?.(entry.childSessionId) }}
            >
              <span className={css.statusDetailAgentDot} data-outcome={outcome ?? (entry.done ? 'completed' : undefined)} />
              <span className={css.statusDetailAgentLabel}>{entry.label}</span>
              <span className={css.statusDetailAgentStep}>
                {outcome === 'aborted' ? '手动终止'
                  : outcome === 'failed' ? '失败'
                  : outcome === 'completed' ? '已完成'
                  : entry.done ? '已完成'
                  : `Step ${entry.step}${entry.currentAction === undefined ? '' : ` · ${entry.currentAction}`}`}
              </span>
              <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
                {entry.model?.model ?? '未记录'}
              </span>
              {entry.isolated === true && <span className={css.statusDetailAgentBadge}>隔离</span>}
              {entry.mode === 'background' && <span className={css.statusDetailAgentBadge}>后台</span>}
              <span className={css.statusDetailAgentGo} aria-hidden="true">→</span>
            </button>
            )
          })}
        </div>
      )}
      {/* 并行工作区（隔离 worktree 台账）。用户 2026-09-10：P8 逐次成节点后卡内
          chip 会重复 N 份，故搬到本浮层——一个会话一处。数据源 = 宿主
          'corum/worktree-ledger' 转发帧（按父会话过滤）。 */}
      {worktrees.length > 0 && (
        <div className={css.statusDetailAgents}>
          <div className={css.statusDetailAgentsHead}>
            <span className={css.statusDetailAgentsTitle}>并行工作区</span>
            <span className={css.statusDetailAgentsCount}>
              {worktrees.filter(entry => entry.status === 'active' || entry.status === 'settled').length} 待集成
              {' · '}
              {worktrees.length} 个隔离工作区
            </span>
          </div>
          {worktrees.map(entry => (
            <div key={entry.slug} className={css.statusDetailAgentRow} data-worktree>
              <span className={css.statusDetailWorktreeIcon} aria-hidden="true">⑂</span>
              <span className={css.statusDetailAgentLabel} title={entry.branch}>{entry.branch}</span>
              <span className={css.statusDetailAgentStep}>{entry.slug}</span>
              <span className={css.statusDetailAgentBadge} data-model={entry.model?.model ?? '未记录'} title={entry.model !== undefined ? `模型提供方 ${entry.model.provider}` : '模型未记录'}>
                {entry.model?.model ?? '未记录'}
              </span>
              <span className={css.statusDetailAgentBadge} data-status={entry.status}>
                {WORKTREE_STATUS_LABEL[entry.status] ?? entry.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** `conversation.session.header.actions` occupant 的业务注入面。 */
export interface SessionStatusInjected {
  /** 统一事件中心 remote 面（子 Agent 花名册订阅源；缺省不渲染胶囊）。 */
  readonly remote?: RemoteEventFace | undefined
  /** 打开会话（浮层子 Agent 行点击 → 进入子会话）。 */
  readonly openSession: (sessionId: string) => void
  /**
   * RPC 面（隔离台账 + 子 Agent 花名册的冷启动基线：推送帧不重放，
   * 刷新后需主动拉一次）。结构窄化到「调用一个具名 RPC」——不 import
   * connection 包的具体类型（红线 3）。
   */
  readonly connection?: RpcFace | undefined
  /**
   * 官方 `ctx.sessions` 的直接子会话目录面（卷取子 Agent 花名册的 durable 基线）。
   * 缺省时花名册退化为「仅推送帧」——旧行为，不会报错。
   */
  readonly catalog?: SubagentCatalogFace | undefined
}

/** `ctx.get('connection')` 的窄化面（只用到一元 RPC 调用）。 */
export interface RpcFace {
  rpc: {
    call: (ns: string, method: string, payload: { args: unknown }) => Promise<{
      ok: boolean
      value?: unknown
    }>
  }
}

/**
 * 状态胶囊 occupant 的完整 props（运行时 share 已含 sessionId + useSessions）。
 *
 * `useTrajectory` 由 corum-ui-trajectory 经
 * `declare module '@deepseek-ai/dsh-client-ui-slots'` 的 `SessionStandardProps`
 * 模块合并注入——本包不 import 该实现包（红线 3：跨 bundle 类型面用本地能力接口
 * 收窄），故这里用 `TrajectoryCapableProps` 显式并上钩子面；运行时由槽的
 * PropsRuntime 实际提供（已实机确认 ConversationSessionHeader 收到的 props 含
 * useTrajectory）。若精简装配里没装轨迹插件，该 prop 为 undefined，曲线退化为
 * 空态基线（不报错）。
 */
export type SessionStatusPillProps =
  PropsRuntime<'conversation.session.header.actions'>
  & SessionStatusInjected
  & TrajectoryCapableProps

/** 会话标准 props 里本组件消费的轨迹能力（本地能力接口，见上注释）。 */
export interface TrajectoryCapableProps {
  readonly useTrajectory?: UseTrajectoryHook | undefined
}

/**
 * 会话顶栏的 corum 状态段：状态胶囊（真实统计）+ 常驻子 Agent 胶囊 + 详情浮层。
 *
 * 锚点：详情浮层按**会话顶栏行的水平中心**居中——行在 `header` 元素内，主窗口
 * 与独立窗口都存在（独立窗口没有网格，故不能再用壳的会话列几何）。
 * @param props - 槽运行时 share（sessionId/useSessions/useTrajectory）+ 业务注入面。
 * @returns 状态胶囊与其展开的统计详情卡。
 */
export function SessionStatusPill({ sessionId, useSessions, remote, openSession, useTrajectory, connection, catalog }: SessionStatusPillProps) {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [anchor, setAnchor] = useState({ left: 0, width: 0 })
  // 当前会话的统计投影（session/list 行 projectionValues）——真实数据。
  const projections = useSessions((s: SessionListState) => {
    return (s.byId as unknown as Readonly<Record<string, { projectionValues?: AgentSessionProjections }>>)[sessionId]?.projectionValues
  })
  const title = useSessions((s: SessionListState) => s.byId[sessionId]?.displayTitle) ?? '会话'
  // 子 Agent 花名册（2026-09-10 用户定调：胶囊与状态展示合并到同一 pill）。
  const roster = rankRoster(useSubagentRoster(remote, sessionId, useSessions, catalog, connection))
  // 终态分组（按 stopReason 派生；done 布尔仅作无推送帧时的兜底——见基线注释）。
  const running = roster.filter(e => subagentOutcomeOf(e.stopReason) === undefined)
  const completed = roster.filter(e => subagentOutcomeOf(e.stopReason) === 'completed' || (e.done && e.stopReason === undefined))
  const aborted = roster.filter(e => subagentOutcomeOf(e.stopReason) === 'aborted')
  // 领跑者 = 运行中的第一个；全已结束时为 undefined（胶囊改显示终态计数）。
  const lead = running[0]
  // 生成速度序列（chart-speed 实时曲线）：来自轨迹快照的逐步真实速度。
  const speedSeries = useSpeedSeries(useTrajectory)
  // 隔离工作区台账（浮层「并行工作区」区；P8 后 chip 的新家）。
  const worktrees = useWorktreeLedger(remote, sessionId, connection)

  // 详情浮层锚点 = 会话顶栏行在视口中的水平中心（列宽变化/窗口缩放时重测）。
  // 上溯 <header>（会话插件 header 是行的宿主，两种窗口都在）；取不到则退回胶囊自身。
  //
  // ⚠️ 坑（2026-09-10 实测）：详情卡是 `position: fixed`，但它的**包含块不是视口**——
  // 会话列的 leaf 带 `will-change: transform`（GridView 的 .leaf），任何 transform/
  // will-change 都会为 fixed 后代建立包含块，于是内联 `left` 是**相对该 leaf** 的偏移。
  // 故本处把行矩形换算到**包含块坐标系**再存进 anchor（{left,width} 语义 = 行在
  // 包含块坐标系里的盒子），JSX 侧统一算 `left = anchor.left + width/2` 居中对齐。
  // 不换算会整体偏移一个「会话列左缘」的距离（实测偏 300px——旧实现量的是同一坐标系
  // 才碰巧没暴露）。
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (el === null) return undefined
    const measure = (): void => {
      const bar = el.closest('header') ?? el
      const rect = bar.getBoundingClientRect()
      // 包含块左缘：向上找第一个建立包含块的祖先（transform/will-change/filter/…），
      // 都没有则对视口（0）。fixed 的定位基点是该祖先的 padding box 左缘。
      let base = 0
      let node: HTMLElement | null = el.parentElement
      while (node !== null && node !== document.documentElement) {
        const cs = getComputedStyle(node)
        if (cs.transform !== 'none' || cs.willChange.includes('transform')
          || cs.filter !== 'none' || cs.backdropFilter !== 'none'
          || cs.perspective !== 'none' || cs.contain !== 'none') {
          base = node.getBoundingClientRect().left
          break
        }
        node = node.parentElement
      }
      const left = Math.round(rect.left - base)
      const width = Math.round(rect.width)
      setAnchor(prev => (prev.left === left && prev.width === width ? prev : { left, width }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  // 详情卡外点击关闭（Escape 同步关）。
  const detailRef = useRef<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    if (!detailOpen) return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (detailRef.current !== null && !detailRef.current.contains(e.target as Node)) setDetailOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setDetailOpen(false) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [detailOpen])

  return (
    <>
      <span className={css.agentDivider} />
      {/* 状态胶囊（design.pen status-pill + GpfJh 详情卡）：真实统计 + 点击展开详情。 */}
      <span ref={wrapRef} className={css.agentStatusWrap}>
        <span ref={detailRef} className={css.agentStatusWrap}>
          <button
            type="button"
            className={css.agentStatusPill}
            aria-expanded={detailOpen}
            aria-label="会话统计，点击展开详情"
            onClick={() => { setDetailOpen(open => !open) }}
          >
            <span className={css.agentStatusDot} />
            <span className={css.agentStats}>{agentStatsSummary(projections)}</span>
            {/* 常驻子 Agent 胶囊（用户 2026-09-10 定调：放 Title 右边、与状态展示合并；
                2026-09-11 补充：**已运行结束的与编排模式下派出的子 Agent 也要显示**，
                所以这里不再只认「运行中」——只要名册非空就渲染这一段：
                  有运行中 → `运行中 N` + 领跑者 + `Step x` + `+K`（其余） + `M 已完成`
                  全已结束 → `已完成 M` + 最后一个 + `+K`
                终态判定走 stopReason（aborted 不算「已完成」）；名册本身是
                「会话血缘基线 + 推送帧增量」（见 useSubagentRoster）。 */}
            {roster.length > 0 && (
              <>
                <span className={css.agentCapsuleDivider} />
                <span className={css.agentCapsuleDot} data-done={lead === undefined ? 'true' : undefined} />
                <span className={css.agentCapsuleCount}>
                  {lead === undefined ? `已完成 ${completed.length}` : `运行中 ${running.length}`}
                </span>
                {lead !== undefined
                  ? (
                    <>
                      <span className={css.agentCapsuleLabel}>{lead.label}</span>
                      {/* step 为 0 = 目录基线还没收到 corum 进度帧，此时不假装知道步骤数。 */}
                      {lead.step > 0 && <span className={css.agentCapsuleStep}>Step {lead.step}</span>}
                      {running.length > 1 && <span className={css.agentCapsuleMore}>+{running.length - 1}</span>}
                      {completed.length > 0 && <span className={css.agentCapsuleDone}>{completed.length} 已完成</span>}
                      {aborted.length > 0 && <span className={css.agentCapsuleAborted}>{aborted.length} 手动终止</span>}
                    </>
                  )
                  : (
                    <>
                      <span className={css.agentCapsuleLabel}>{roster[0]?.label}</span>
                      {roster.length > 1 && <span className={css.agentCapsuleMore}>+{roster.length - 1}</span>}
                      {aborted.length > 0 && <span className={css.agentCapsuleAborted}>{aborted.length} 手动终止</span>}
                    </>
                  )}
              </>
            )}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`${css.agentChev}${detailOpen ? ` ${css.agentChevOpen}` : ''}`}><path d="m6 9 6 6 6-6" /></svg>
          </button>
          {detailOpen && (
            <AgentStatusDetail
              title={title}
              projections={projections}
              anchor={anchor}
              roster={roster}
              openSession={openSession}
              speedSeries={speedSeries}
              worktrees={worktrees}
            />
          )}
        </span>
      </span>
    </>
  )
}

/** `conversation.session.header.utilities` occupant 的业务注入面。 */
export interface SessionTrajectoryInjected {
  /** 切换「轨迹」区域的显隐（壳网格区域；浮窗内为 no-op）。 */
  readonly toggleTrajectory: () => void
}

/** 轨迹按钮 occupant 的完整 props。 */
export type SessionTrajectoryButtonProps =
  PropsRuntime<'conversation.session.header.utilities'> & SessionTrajectoryInjected

/**
 * 会话顶栏右端：轨迹按钮。
 *
 * fork（corum）：轨迹是开发者功能——仅在「设置 → 高级 → 开发者模式」开启时可见
 * （用户 2026-09-09 定调）。独立窗口没有网格，`toggleTrajectory` 在浮窗内是
 * no-op（轨迹区域属于主窗口的网格树）。
 * @param props - 槽运行时 share + 轨迹切换动作。
 * @returns 轨迹按钮，或开发者模式关闭时的 null。
 */
export function SessionTrajectoryButton({ toggleTrajectory }: SessionTrajectoryButtonProps) {
  const developerMode = useDeveloperMode()
  if (!developerMode) return null
  return (
    <button
      type="button" className={css.agentTrajBtn} title="轨迹" aria-label="打开轨迹视图"
      onClick={() => { toggleTrajectory() }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></svg>
    </button>
  )
}

/**
 * 本模块供壳注册用的两个槽 occupant 描述（槽名 + id + 组件 + 注入面工厂）。
 *
 * 注册本身在 `index.tsx` 的 apply 内完成（那里有 `ctx.slots` 的精确类型与
 * `ctx.remote`/`ctx.sessions`/`ctx.layout` 闭包）；本常量只把「注册什么」与
 * 「怎么注册」分开，便于壳在两处复用同一份声明。
 */
export const SESSION_BAR_SLOTS = {
  status: 'conversation.session.header.actions',
  trajectory: 'conversation.session.header.utilities',
} as const

/** 槽 occupant 的注册 id（诊断用；同名槽由 conversation 插件声明）。 */
export const SESSION_BAR_IDS = {
  status: 'corum-session-status',
  trajectory: 'corum-session-trajectory',
} as const

/** 轨迹按钮点亮的壳网格区域（corum-ide-ui 的轨迹区域槽）。 */
export const TRAJECTORY_REGION = 'corum.trajectory'
