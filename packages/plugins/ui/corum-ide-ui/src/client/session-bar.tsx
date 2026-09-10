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
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only：拉入 corum-ui-conversation 的 SlotMap 声明（header.actions /
// header.utilities 两个槽由它声明），让本文件的槽注册通过类型检查
// （TS 模块合并全局生效；与 corum-ui-questions 拉 conversation.input.dock 同法）。
import type {} from '@corum/corum-ui-conversation/client'
import { useDeveloperMode } from './settings/developer-mode.ts'
import css from './AppFrame.module.css'

/** session/list 行 projectionValues 的窄化形（顶栏统计的数据源）。 */
interface SessionStatsProjection {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  decodeMs?: number
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

/** 紧凑 token：12.4k / 3.1k / 178.3k（千分位紧凑，详情行用全量 toLocaleString）。 */
function compactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 顶栏统计（真实数据，session/list 投影折叠）。 */
function agentStatsSummary(p: AgentSessionProjections | undefined): string {
  if (p === undefined) return '—'
  const turns = p.sessionStats?.turns ?? 0
  const active = (p.sessionStats?.llmMs ?? 0) + (p.sessionStats?.toolMs ?? 0)
  const input = (p.tokenUsage?.uncachedInputTokens ?? 0) + (p.tokenUsage?.cacheReadTokens ?? 0) + (p.tokenUsage?.cacheWriteTokens ?? 0)
  const output = p.tokenUsage?.outputTokens ?? 0
  const cacheRead = p.tokenUsage?.cacheReadTokens ?? 0
  const hit = input > 0 ? Math.round((cacheRead / input) * 100) : 0
  return `${turns} 轮 · ${compactDuration(active)} · In ${compactTokens(input)} / Out ${compactTokens(output)} · 命中 ${hit}%`
}

/** 迷你趋势曲线（设计稿 chart-cache/chart-cost 的 plot 170×40 折线）。
 *  数据源是当前会话聚合值（无逐 turn 历史序列投影），以「起步微升 → 收敛当前值」
 *  的单调折线近似趋势（语义对齐设计稿的上升曲线）。 */
function TrendLine({ color, width = 170, height = 40 }: { color: string; width?: number; height?: number }) {
  // 折线：左低右高收敛（0,32 → 40,24 → 90,18 → 130,12 → 170,8），圆角平滑。
  const d = `M0 ${height * 0.8} C ${width * 0.24} ${height * 0.6}, ${width * 0.5} ${height * 0.45}, ${width * 0.76} ${height * 0.3} S ${width * 0.94} ${height * 0.2}, ${width} ${height * 0.2}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={css.statusDetailTrend} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
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

/** 状态栏详情卡（设计稿 GpfJh，×1.25 放大 + 长方形三列 chart）：hover/点击
 *  status-pill 展开的会话统计浮层。长方形 = 左（上下文 donut+图例）右（命中率/
 *  累计费用两个趋势曲线）三列撑宽。 */
function AgentStatusDetail({ title, projections: p, anchor, roster, openSession }: {
  title: string
  projections: AgentSessionProjections | undefined
  /** 会话顶栏行在**包含块坐标系**中的盒子（left/width），详情卡据此水平居中
   *  （见 SessionStatusPill 的锚点测量注释：fixed 的包含块不是视口）。 */
  anchor: { left: number; width: number }
  /** 子 Agent 花名册（用户 2026-09-10：下拉浮层在下方追加 subagent 信息）。 */
  roster: readonly SubagentRosterEntry[]
  /** 打开会话（子 Agent 行点击 → 进入该子会话）。 */
  openSession?: ((sessionId: string) => void) | undefined
}) {
  const stats = p?.sessionStats
  const usage = p?.tokenUsage
  const pressure = p?.contextPressure
  const breakdown = p?.contextBreakdown
  const turns = stats?.turns ?? 0
  const steps = stats?.steps ?? 0
  const active = (stats?.llmMs ?? 0) + (stats?.toolMs ?? 0)
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
  const ctxFree = Math.max(0, ctxWindow - ctxUsed)
  const segOf = (n: number): number => (ctxWindow > 0 ? (n / ctxWindow) * 360 : 0)
  const inputDeg = segOf(input)
  const outputDeg = segOf(output)
  const systemDeg = segOf(system + tools)
  void messages
  const rows: ReadonlyArray<readonly [string, string]> = [
    ['轮次 Turns', String(turns)],
    ['工作时长 Active', compactDuration(active)],
    ['Token 输入 Input', input.toLocaleString('en-US')],
    ['Token 输出 Output', output.toLocaleString('en-US')],
    ['执行步骤 Steps', String(steps)],
    ['工具调用 Tool', compactDuration(stats?.toolMs ?? 0)],
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
        <span className={css.statusDetailHint}>hover 状态栏弹出</span>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className={css.statusDetailRow}>
          <span className={css.statusDetailKey}>{k}</span>
          <span className={css.statusDetailValue}>{v}</span>
        </div>
      ))}
      <div className={css.statusDetailRow}>
        <span className={css.statusDetailKey}>命中率 Cache Hit</span>
        <span className={css.statusDetailBarWrap}>
          <span className={css.statusDetailBar}><span className={css.statusDetailBarFill} style={{ width: `${hit}%` }} /></span>
          <span className={css.statusDetailValue}>{hit}%</span>
        </span>
      </div>
      <div className={css.statusDetailDivider} />
      {/* 实时统计区头（设计稿 sec-charts sh：pulse + 标题 + 实时更新）。 */}
      <div className={css.statusDetailChartHead}>
        <span className={css.statusDetailPulse} />
        <span className={css.statusDetailChartTitle}>实时统计 · {turns} 轮</span>
        <span className={css.statusDetailChartLive}>实时更新</span>
      </div>
      {/* 三列 chart 行（设计稿 charts-row，长方形撑宽关键）：上下文 donut+图例 /
          命中率趋势 / 累计费用趋势。 */}
      <div className={css.statusDetailChartsRow}>
        {/* 上下文 donut + 图例（chart-context）。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColLabel}>上下文 Context{ctxWindow > 0 ? ` · 上限 ${compactTokens(ctxWindow)}` : ''}</span>
          <div className={css.statusDetailChartColBody}>
            {ctxWindow > 0 && (
              <>
                <span className={css.statusDetailDonut} style={{
                  background: `conic-gradient(var(--dsw-alias-brand-primary) 0deg ${inputDeg}deg, var(--corum-brand-accent, #FF71CE) ${inputDeg}deg ${inputDeg + outputDeg}deg, var(--dsw-alias-state-warn-primary, #FFB45C) ${inputDeg + outputDeg}deg ${inputDeg + outputDeg + systemDeg}deg, var(--corum-glass-2, rgba(42,24,64,.85)) ${inputDeg + outputDeg + systemDeg}deg 360deg)`,
                }}>
                  <span className={css.statusDetailDonutCenter}>
                    <span className={css.statusDetailDonutPct}>{ctxPct}%</span>
                    <span className={css.statusDetailDonutCap}>已用</span>
                  </span>
                </span>
                <span className={css.statusDetailLegend}>
                  {([
                    ['var(--dsw-alias-brand-primary)', '输入', input],
                    ['var(--corum-brand-accent, #FF71CE)', '输出', output],
                    ['var(--dsw-alias-state-warn-primary, #FFB45C)', '系统提示词', system + tools],
                    ['var(--corum-glass-2, rgba(42,24,64,.85))', '未用', ctxFree],
                  ] as const).map(([color, label, n]) => (
                    <span key={label} className={css.statusDetailLegendRow}>
                      <span className={css.statusDetailLegendDot} style={{ background: color }} />
                      <span className={css.statusDetailLegendLabel}>{label}</span>
                      <span className={css.statusDetailLegendValue}>{compactTokens(n)} · {ctxWindow > 0 ? Math.round((n / ctxWindow) * 1000) / 10 : 0}%</span>
                    </span>
                  ))}
                </span>
              </>
            )}
          </div>
        </div>
        {/* 命中率趋势（chart-cache，state-success 折线）。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColLabel}>命中率</span>
          <TrendLine color="var(--dsw-alias-state-success, #22c55e)" />
          <span className={css.statusDetailTrendLegend}>
            <span className={css.statusDetailTrendDot} style={{ background: 'var(--dsw-alias-state-success, #22c55e)' }} />
            <span className={css.statusDetailTrendLabel}>平均 {hit}%</span>
          </span>
        </div>
        {/* 累计费用趋势（chart-cost，label-secondary 折线）。 */}
        <div className={css.statusDetailChartCol}>
          <span className={css.statusDetailChartColLabel}>累计费用</span>
          <TrendLine color="var(--dsw-alias-label-secondary)" />
          <span className={css.statusDetailTrendLegend}>
            <span className={css.statusDetailTrendDot} style={{ background: 'var(--dsw-alias-label-secondary)' }} />
            <span className={css.statusDetailTrendLabel}>—</span>
          </span>
        </div>
      </div>
      {/* 子 Agent 区（用户 2026-09-10：下拉浮层在下方追加 subagent 信息）。
          运行中在前、已完成在后；每行 = 状态点 + 标签 + Step + 前后台/隔离徽标。 */}
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

/** 状态胶囊 occupant 的完整 props（运行时 share 已含 sessionId + useSessions）。 */
export type SessionStatusPillProps =
  PropsRuntime<'conversation.session.header.actions'> & SessionStatusInjected

/**
 * 会话顶栏的 corum 状态段：状态胶囊（真实统计）+ 常驻子 Agent 胶囊 + 详情浮层。
 *
 * 锚点：详情浮层按**会话顶栏行的水平中心**居中——行在 `header` 元素内，主窗口
 * 与独立窗口都存在（独立窗口没有网格，故不能再用壳的会话列几何）。
 * @param props - 槽运行时 share（sessionId/useSessions）+ 业务注入面。
 * @returns 状态胶囊与其展开的统计详情卡。
 */
export function SessionStatusPill({ sessionId, useSessions, remote, openSession }: SessionStatusPillProps) {
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
