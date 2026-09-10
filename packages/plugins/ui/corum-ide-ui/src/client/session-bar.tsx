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
  byId: Record<string, { blank?: boolean; displayTitle?: string; projectionValues?: unknown } | undefined>
}

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

/** 子 Agent 花名册条目（会话顶栏常驻胶囊 + 详情浮层的子 Agent 区数据源）。 */
interface SubagentRosterEntry {
  readonly childSessionId: string
  readonly label: string
  readonly mode: 'foreground' | 'background'
  readonly isolated: boolean
  readonly step: number
  readonly currentAction?: string
  readonly done: boolean
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
  sessionId?: string
  turn?: number
  step?: number
  currentAction?: string
  done?: boolean
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
function useSubagentRoster(remote: RemoteEventFace | undefined, sessionId: string | undefined): readonly SubagentRosterEntry[] {
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
            mode: patch.mode ?? 'foreground',
            isolated: patch.isolated ?? false,
            step: patch.step ?? 0,
            ...(patch.currentAction === undefined ? {} : { currentAction: patch.currentAction }),
            done: patch.done ?? false,
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
        ...(frame.lastActive === undefined ? {} : { lastActive: frame.lastActive }),
      })
    })
    return () => { disposeChild(); disposeProgress() }
  }, [remote, sessionId])
  return entries
}

/** 运行中在前、最近活动倒序（胶囊取第一个当「当前子 Agent」）。 */
function rankRoster(entries: readonly SubagentRosterEntry[]): readonly SubagentRosterEntry[] {
  return [...entries].sort((a, b) => (Number(a.done) - Number(b.done)) || (b.lastActive - a.lastActive))
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
function AgentStatusDetail({ title, projections: p, anchor, roster, openSession, speedSeries }: {
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
          运行中在前、已完成在后；每行 = 状态点 + 标签 + Step + 前后台/隔离徽标，
          点击进入该子会话（官方 lineage 下拉已按「顶栏只保留一个下拉」屏蔽）。 */}
      {roster.length > 0 && (
        <div className={css.statusDetailAgents}>
          <div className={css.statusDetailAgentsHead}>
            <span className={css.statusDetailAgentsTitle}>子 Agent</span>
            <span className={css.statusDetailAgentsCount}>
              {roster.filter(entry => !entry.done).length} 运行中 · {roster.filter(entry => entry.done).length} 已完成
            </span>
          </div>
          {rankRoster(roster).map((entry) => (
            <button
              key={entry.childSessionId}
              type="button"
              className={css.statusDetailAgentRow}
              data-done={entry.done || undefined}
              title={`进入子会话 ${entry.childSessionId}`}
              aria-label={`进入子会话 ${entry.label}`}
              onClick={() => { openSession?.(entry.childSessionId) }}
            >
              <span className={css.statusDetailAgentDot} data-done={entry.done || undefined} />
              <span className={css.statusDetailAgentLabel}>{entry.label}</span>
              <span className={css.statusDetailAgentStep}>
                {entry.done ? '已完成' : `Step ${entry.step}${entry.currentAction === undefined ? '' : ` · ${entry.currentAction}`}`}
              </span>
              {entry.isolated && <span className={css.statusDetailAgentBadge}>隔离</span>}
              {entry.mode === 'background' && <span className={css.statusDetailAgentBadge}>后台</span>}
              <span className={css.statusDetailAgentGo} aria-hidden="true">→</span>
            </button>
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
export function SessionStatusPill({ sessionId, useSessions, remote, openSession, useTrajectory }: SessionStatusPillProps) {
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [anchor, setAnchor] = useState({ left: 0, width: 0 })
  // 当前会话的统计投影（session/list 行 projectionValues）——真实数据。
  const projections = useSessions((s: SessionListState) => {
    return (s.byId as unknown as Readonly<Record<string, { projectionValues?: AgentSessionProjections }>>)[sessionId]?.projectionValues
  })
  const title = useSessions((s: SessionListState) => s.byId[sessionId]?.displayTitle) ?? '会话'
  // 子 Agent 花名册（2026-09-10 用户定调：胶囊与状态展示合并到同一 pill）。
  const roster = rankRoster(useSubagentRoster(remote, sessionId))
  const running = roster.filter(entry => !entry.done)
  const lead = running[0]
  // 生成速度序列（chart-speed 实时曲线）：来自轨迹快照的逐步真实速度。
  const speedSeries = useSpeedSeries(useTrajectory)

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
            {/* 常驻子 Agent 胶囊（用户 2026-09-10 定调：放 Title 右边、与状态展示合并）：
                仅在当前会话有运行中子 Agent 时出现，空闲时整段不渲染。 */}
            {lead !== undefined && (
              <>
                <span className={css.agentCapsuleDivider} />
                <span className={css.agentCapsuleDot} />
                <span className={css.agentCapsuleCount}>运行中 {running.length}</span>
                <span className={css.agentCapsuleLabel}>{lead.label}</span>
                <span className={css.agentCapsuleStep}>Step {lead.step}</span>
                {running.length > 1 && <span className={css.agentCapsuleMore}>+{running.length - 1}</span>}
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
