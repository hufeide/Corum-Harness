// Resident conversation skeleton. Hero chrome, composer positioning, the
// chain, AND the composer bar (session-maybe slot) stay mounted across
// no-session/session transitions — the bar renders inert via owner props.

import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Bot, Bug, Compass, FileText, History, LayoutGrid, Megaphone, PenLine, TestTube2, Wand2 } from 'lucide-react'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConversationSlotProps, InputZone, TaskAgentInfo } from '../contract/slots.ts'
import { conversationPhase } from '../contract/snapshot.ts'
import { HeroGlow, HeroShell, WorkspaceChip, workspaceLabel } from './EmptyHero.tsx'
import { EmptyStateHero } from './EmptyStateHero.tsx'
import { AgentTwoLevelSelect } from './AgentTwoLevelSelect.tsx'
import { DARK_ATTRIBUTE } from '@corum/corum-ui-base/client'
import css from './ConversationRoot.module.css'

/** 一条快捷指令卡（icon + 标题 + 描述 + 填入 composer 的提示词）。 */
interface QuickCommand {
  icon: typeof History
  title: string
  desc: string
  prompt: string
}

/** 通用快捷指令卡（设计稿 L4 1:1）：无岗位维度信息（official preset / 查询失败）时的回退集。 */
const GENERIC_QUICK_COMMANDS: readonly QuickCommand[] = [
  { icon: History, title: '继续未完成的任务', desc: '从上次中断的地方接着推进当前工作区的工作', prompt: '继续未完成的任务：从上次中断的地方接着推进当前工作区的工作。' },
  { icon: Wand2, title: '整理代码', desc: '清理结构、统一风格，让项目更易维护', prompt: '整理代码：清理结构、统一风格，让项目更易维护。' },
  { icon: Compass, title: '帮我探索项目', desc: '梳理项目结构，说明各模块职责与关联', prompt: '帮我探索项目：梳理项目结构，说明各模块职责与关联。' },
]

/**
 * 按 Agent 岗位维度定制的快捷指令卡（2026-09-07 用户定调：不同专业领域的
 * Agent，对话起始页的推荐命令应贴合其专业方向）。key = profile.dimension
 * （研发/产品/设计/市场/自媒体/创作）；未命中（含无 dimension 的 official
 * preset）回退 GENERIC_QUICK_COMMANDS。 */
const DIMENSION_QUICK_COMMANDS: Readonly<Record<string, readonly QuickCommand[]>> = {
  研发: [
    { icon: Wand2, title: '重构这段代码', desc: '优化结构与命名，提升可读性与可维护性', prompt: '重构这段代码：优化结构与命名，提升可读性与可维护性。' },
    { icon: Bug, title: '排查并修复问题', desc: '定位根因，给出修复方案与验证步骤', prompt: '排查并修复问题：定位根因，给出修复方案与验证步骤。' },
    { icon: TestTube2, title: '补充自动化测试', desc: '为核心逻辑补齐单元测试与边界用例', prompt: '补充自动化测试：为核心逻辑补齐单元测试与边界用例。' },
  ],
  产品: [
    { icon: FileText, title: '起草需求文档', desc: '把想法整理成结构化的 PRD 与用户故事', prompt: '起草需求文档：把想法整理成结构化的 PRD 与用户故事。' },
    { icon: LayoutGrid, title: '梳理任务优先级', desc: '按价值与成本排出迭代计划与里程碑', prompt: '梳理任务优先级：按价值与成本排出迭代计划与里程碑。' },
    { icon: Compass, title: '竞品调研分析', desc: '对比同类产品，提炼差异化机会点', prompt: '竞品调研分析：对比同类产品，提炼差异化机会点。' },
  ],
  设计: [
    { icon: PenLine, title: '设计界面方案', desc: '给出布局、配色与组件的设计建议', prompt: '设计界面方案：给出布局、配色与组件的设计建议。' },
    { icon: LayoutGrid, title: '走查现有界面', desc: '指出一致性与可用性问题并给改进建议', prompt: '走查现有界面：指出一致性与可用性问题并给改进建议。' },
    { icon: Compass, title: '提炼设计规范', desc: '整理颜色/字体/间距为可复用的设计令牌', prompt: '提炼设计规范：整理颜色/字体/间距为可复用的设计令牌。' },
  ],
  市场: [
    { icon: Megaphone, title: '撰写推广文案', desc: '面向目标用户提炼卖点与行动号召', prompt: '撰写推广文案：面向目标用户提炼卖点与行动号召。' },
    { icon: Compass, title: '分析目标用户', desc: '勾勒用户画像与触达渠道建议', prompt: '分析目标用户：勾勒用户画像与触达渠道建议。' },
    { icon: FileText, title: '策划营销活动', desc: '给出活动主题、节奏与物料清单', prompt: '策划营销活动：给出活动主题、节奏与物料清单。' },
  ],
  自媒体: [
    { icon: PenLine, title: '生成内容选题', desc: '结合定位给一批可落地的选题方向', prompt: '生成内容选题：结合定位给一批可落地的选题方向。' },
    { icon: FileText, title: '撰写图文初稿', desc: '产出标题、正文与结尾互动的完整初稿', prompt: '撰写图文初稿：产出标题、正文与结尾互动的完整初稿。' },
    { icon: Megaphone, title: '优化标题封面', desc: '提升点击率：标题候选与封面文案建议', prompt: '优化标题封面：提升点击率：标题候选与封面文案建议。' },
  ],
  创作: [
    { icon: PenLine, title: '续写这段文字', desc: '保持语气与风格，自然推进情节或论述', prompt: '续写这段文字：保持语气与风格，自然推进情节或论述。' },
    { icon: Compass, title: '头脑风暴创意方向', desc: '围绕主题发散多个可选切入点', prompt: '头脑风暴创意方向：围绕主题发散多个可选切入点。' },
    { icon: Wand2, title: '润色这段文字', desc: '精炼表达、修正语病，保留原作者风格', prompt: '润色这段文字：精炼表达、修正语病，保留原作者风格。' },
  ],
}

/** 新会话界面（blank 会话）：标语 + 副标语 + 快捷指令卡。点卡把指令填入 composer。 */
function NewSessionHero({ workspaceTitle, agentInfo, onPick }: {
  workspaceTitle?: string | undefined
  agentInfo?: TaskAgentInfo | undefined
  onPick: (prompt: string) => void
}) {
  const sub = workspaceTitle !== undefined && workspaceTitle !== ''
    ? `已在 ${workspaceTitle} 工作区${agentInfo?.name !== undefined && agentInfo.name !== '' ? ` · 由 ${agentInfo.name} 执行` : ''}`
    : undefined
  const commands = (agentInfo?.dimension !== undefined ? DIMENSION_QUICK_COMMANDS[agentInfo.dimension] : undefined)
    ?? GENERIC_QUICK_COMMANDS
  return (
    <div className={css.newSessionHero}>
      <div className={css.newSessionHeadline}>
        <span className={css.newSessionTitle}>输入指令，开始新的任务</span>
        {sub !== undefined && <span className={css.newSessionSub}>{sub}</span>}
      </div>
      <div className={css.quickCommands}>
        {commands.map((cmd) => {
          const Icon = cmd.icon
          return (
            <button
              key={cmd.title}
              type="button"
              className={css.quickCommand}
              onClick={() => onPick(cmd.prompt)}
            >
              <span className={css.quickCommandHead}>
                <span className={css.quickCommandIcon}><Icon size={16} /></span>
                <span className={css.quickCommandTitle}>{cmd.title}</span>
              </span>
              <span className={css.quickCommandDesc}>{cmd.desc}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps

/** localStorage key for the dragged transcript width preference (px). */
const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'
/** Floor for a dragged content width; matches the layout center-column minimum. */
const CONTENT_MIN = 640
/** Column budget the content must leave free: 88px per side keeps the width
 * handles fully placeable (24px inset + 40px strip + 24px safe zone) — a
 * larger dragged width would push its own handles off the column and leave no
 * way to drag back. */
const CONTENT_EDGE_BUDGET = 176

/** Reads the persisted width preference; durable-storage boundary, so a
 * missing or corrupt value resolves to "no preference".
 * @returns the stored width in px, or null when unset or invalid. */
function readWidthPreference(): number | null {
  const raw = localStorage.getItem(WIDTH_PREF_KEY)
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Resolves the content width the CSS axis would show for a column width.
 * @param columnWidth - the conversation column's rendered width in px.
 * @param preference - the dragged preference, or null for the adaptive clamp.
 * @returns the resolved content width in px (mirrors the CSS clamp). */
function resolveContentWidth(columnWidth: number, preference: number | null): number {
  const max = Math.max(CONTENT_MIN, columnWidth - CONTENT_EDGE_BUDGET)
  if (preference !== null) return Math.min(Math.max(preference, CONTENT_MIN), max)
  return Math.max(680, Math.min(columnWidth * 0.64, 920))
}

/** One transcript width handle: pointer capture + rAF-throttled symmetric
 * resize (both sides write the one centered width, so outward travel widens
 * by 2× the pointer distance). pointermove publishes the pointer's Y as a CSS
 * variable so the glow indicator rides it. Mirrors ui-layout AppFrame's
 * DragHandle capture model. */
function WidthHandle(props: {
  side: 'left' | 'right'
  onStart: () => number
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const outwardWidth = () => {
    const dx = latest.current - origin.current
    const outward = callbacks.current.side === 'right' ? dx : -dx
    return base.current + outward * 2
  }
  const cancelFrame = () => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
  }
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    base.current = callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--dsh-width-handle-pointer-y', `${e.clientY - box.top}px`)
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(outwardWidth())
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    cancelFrame()
    latest.current = e.clientX
    // Only a gesture with actual travel commits: a press-and-release on a
    // window-clamped width must not overwrite the wider stored preference
    // with the clamped display value.
    if (latest.current !== origin.current) callbacks.current.onCommit(outwardWidth())
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  // Releasing the button outside the window delivers pointercancel (or drops
  // the capture silently) instead of pointerup; without this the glow's
  // data-dragging state sticks on. The gesture is abandoned uncommitted —
  // onEnd republishes the stored preference. releasePointerCapture inside
  // onPointerUp also fires lostpointercapture, so this runs (idempotently)
  // after every normal drag end too; keep both paths.
  const onPointerCancel = useCallback(() => {
    cancelFrame()
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.widthHandle}
      data-side={props.side}
      data-width-handle={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onPointerCancel}
    />
  )
}

export function ConversationRoot({
  sessionId, useSession, useSessions, useSessionPendingInteraction,
  useWorkspaces, useConversation, useInput, useComposerBlock, inputActions,
  renderSlot, renderSlotChain, selectWorkspace, emptyActions, newTaskForm, polishDraft, t,
}: ConversationRootProps) {
  // 当前主题（深/浅）：空态大 logo 选图（big_brand_dark/light）。DARK_ATTRIBUTE
  // 是 corum-ui-base theme-presenter 写到 body 的标记。
  const dark = typeof document !== 'undefined' && document.body.hasAttribute(DARK_ATTRIBUTE)
  const session = useSession(s => s)
  const pendingInteraction = useSessionPendingInteraction(snapshot =>
    sessionId === undefined ? undefined : snapshot.get(sessionId))
  const conversation = useConversation(s => s)
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  const openState = session?.openState
  const inputState = useInput(s => s)
  const cwd = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.cwd)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  // 最近任务泳道（2026-08-30 空态圆桌：最近项目+任务混排列表）：sessions.list
  // 的 corum-task-*（非 subagent），按 updatedAt 倒序取前 6。
  const recentTasks = useSessions((s) => {
    const out: { id: string; title: string; updatedAt: number }[] = []
    for (const [id, sess] of Object.entries(s.byId)) {
      if (!id.startsWith('corum-task-')) continue
      if (sess.origin === 'subagent') continue
      // blank（未发过消息）的泳道显示「新会话」——官方 displayTitle 此刻回落到
      // 工作区目录名（displayTitleOf 的 workspaceTitleOf(cwd) 兜底），不是空串，
      // 所以必须按 blank 判断，不能靠 displayTitle 是否为空。
      out.push({
        id,
        title: sess.blank === true ? '新会话' : (sess.displayTitle || '未命名会话'),
        updatedAt: typeof sess.updatedAt === 'number' ? sess.updatedAt : 0,
      })
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt)
    return Object.freeze(out.slice(0, 6))
  })
  // fork（corum）：useWorkspaces 由官方 ui-workspace 提供，kkc IDE 已禁（undefined）。
  // 降级为空 stub（hero 工作区导航在 kkc 由侧栏自研，不经此），避免「not a function」。
  type WorkspaceSnapshotLike = { items: readonly { workspaceId: WorkspaceId; title: string; sessionIds: readonly SessionId[] }[]; phase: string }
  const workspaces: WorkspaceSnapshotLike = typeof useWorkspaces === 'function'
    ? (useWorkspaces as <T>(sel: (s: WorkspaceSnapshotLike) => T) => T)(s => s)
    : { items: [], phase: 'ready' }
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)

  const [pickerOpen, setPickerOpen] = useState(false)
  const [pendingWorkspaceId, setPendingWorkspaceId] = useState<WorkspaceId | undefined>()
  const pickerAnchor = useRef<HTMLButtonElement>(null)

  // Publishes the two live measurements floating View chrome reads off the
  // scroll body: the seat's height as --dsh-composer-height, so controls clear
  // the composer as it grows, and the scrollport's own height as
  // --dsh-conversation-viewport-height, so a control can sit in the band the
  // seat leaves visible. Callback ref, not an effect; stable identity prevents
  // observer churn while the first blank session fills the resident body
  // outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
      scroller.style.setProperty(
        '--dsh-conversation-viewport-height',
        `${scroller.clientHeight}px`,
      )
    })
    seatObserver.current.observe(seat)
    seatObserver.current.observe(scroller)
  }, [])

  // Publishes the column's live width as --dsh-conversation-column-width so
  // the shared width axis can adapt (see the .root CSS), and re-clamps a
  // dragged preference against the shrunken column WITHOUT rewriting the
  // stored preference — widening the window restores it (the AppFrame
  // sidebar-drag rule). Same callback-ref pattern as the seat observer.
  const rootEl = useRef<HTMLDivElement | null>(null)
  const rootObserver = useRef<ResizeObserver | null>(null)
  const publishWidths = useCallback((root: HTMLDivElement): void => {
    const column = root.offsetWidth
    root.style.setProperty('--dsh-conversation-column-width', `${column}px`)
    const preference = readWidthPreference()
    if (preference === null) {
      root.style.removeProperty('--dsh-chat-user-width')
    } else {
      root.style.setProperty('--dsh-chat-user-width', `${resolveContentWidth(column, preference)}px`)
    }
  }, [])
  const rootResizeRef = useCallback((root: HTMLDivElement | null): void => {
    rootObserver.current?.disconnect()
    rootObserver.current = null
    rootEl.current = root
    if (root === null) return
    rootObserver.current = new ResizeObserver(() => { publishWidths(root) })
    rootObserver.current.observe(root)
    publishWidths(root)
  }, [publishWidths])

  // Drag plumbing for the two width handles: onStart snapshots the resolved
  // width (grabbing a clamped column must not jump back to the raw stored
  // preference), onDrag publishes only the live clamped style, onCommit
  // persists the width of a gesture that actually travelled, and onEnd
  // republishes from storage — an uncommitted press leaves the stored
  // preference untouched.
  const onHandleStart = useCallback((): number => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return 680
    return resolveContentWidth(root.offsetWidth, readWidthPreference())
  }, [])
  const onHandleDrag = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return
    const clamped = resolveContentWidth(root.offsetWidth, width)
    root.style.setProperty('--dsh-chat-user-width', `${clamped}px`)
  }, [])
  const onHandleCommit = useCallback((width: number): void => {
    const root = rootEl.current
    /* v8 ignore next -- handles render inside the root, so the ref is always attached. */
    if (root === null) return
    localStorage.setItem(WIDTH_PREF_KEY, `${resolveContentWidth(root.offsetWidth, width)}`)
  }, [])
  const onHandleEnd = useCallback((): void => {
    const root = rootEl.current
    if (root !== null) publishWidths(root)
  }, [publishWidths])

  const sessionWorkspace = sessionId === undefined
    ? undefined
    : workspaces.items.find(workspace => workspace.sessionIds.includes(sessionId))
  const pendingWorkspace = workspaces.items.find(
    workspace => workspace.workspaceId === pendingWorkspaceId,
  )

  // Clear the pending pick once the session lands in it, or when the picked
  // workspace disappears from a ready list (deleted from the sidebar).
  useEffect(() => {
    if (pendingWorkspaceId === undefined) return
    if (sessionWorkspace?.workspaceId === pendingWorkspaceId
      || (workspaces.phase === 'ready' && pendingWorkspace === undefined)) {
      setPendingWorkspaceId(undefined)
    }
  }, [pendingWorkspaceId, sessionWorkspace?.workspaceId, workspaces.phase, pendingWorkspace])

  // While a session is still replaying (loading + blank) the hero/docked
  // choice is unknowable — render the composer hidden instead of flashing
  // the centered hero and snapping to the docked bar (or vice versa).
  // Exemption: a session the list summary already proves blank can only
  // land on the hero, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session is the hero before its open starts (`cold`) and
  // after one fails (`error`) for the same reason — there is no history.
  // A restored continuable subagent also stays settled until its eagerly
  // loaded parent catalog establishes availability. This keeps the composer
  // hidden instead of briefly rendering the parent-offline takeover.
  const parentAvailabilityPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = sessionId !== undefined && (
    (shellPhase === 'blank' && openState === 'loading' && summaryBlank !== true)
    || parentAvailabilityPending
  )
  /**
   *「已选中一个会话」（哪怕它还是 blank——没发过消息）。
   *
   * 官方 hero 条件 = `sessionId === undefined || (blank 且已 open)`——把 **blank
   * 会话也算 hero**：因为 blank 没有历史可渲染，官方此时渲染 HeroShell（工作区
   * chip + **composer 输入框**），让用户直接发第一条消息。而 corus 空态
   * EmptyStateHero 只有「大 logo + 新建卡」、**没有输入框**，若沿用 hero 判断，
   * 用户建完任务后会卡在空页、无处发第一条指令（2026-08-30 用户实测反馈）。
   *
   * 故本 fork 按「有没有选中会话」分流：
   * - `sessionId === undefined`（真的没会话）→ 空态页，无输入框；
   * - `sessionId !== undefined`（已选中，含 blank）→ 渲染 composer 输入框 +
   *   工作区/Agent chip，用户可直接发第一条消息（发完 blank 翻转、会话留存）。
   */
  const hasSession = sessionId !== undefined
  /** 是否 task 泳道会话（corum-task-*）——这类会话 Agent 创建时绑定，session 内锁定。 */
  const isTaskLane = sessionId !== undefined && String(sessionId).startsWith('corum-task-')
  /** 是否子 Agent 会话（origin=subagent）——由父 Agent 发起和管控，用户不可干涉：
   *  隐藏 composer 输入框与工作区选择，底部改「返回父会话」撑满条（设计稿 q0T81 稿②）。 */
  const sessionOrigin = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.origin)
  const isSubagentSession = sessionOrigin === 'subagent'
  /** 子 Agent 会话的父会话 id（session/list 行 parentId），供「返回父会话」寻址。 */
  const parentSessionId = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.parentId)
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  // ── 会话内提示词润色（结合最近 6 条 user/AI 最终输出，意图自动判断）──
  const [polishBusy, setPolishBusy] = useState(false)
  const doPolish = useCallback(async () => {
    const text = (inputState?.draft ?? '').trim()
    if (text === '' || sessionId === undefined || polishBusy || polishDraft === undefined) return
    setPolishBusy(true)
    try {
      const polished = await polishDraft(String(sessionId), text)
      inputActions?.setDraft(polished)
    } catch (e) {
      console.error('[conversation] polish failed', e)
    } finally {
      setPolishBusy(false)
    }
  }, [inputState?.draft, sessionId, polishBusy, polishDraft, inputActions])

  // The chip is a selector; label resolution walks the flow top-down:
  //   1. a just-picked workspace (pending) → its title;
  //   2. cold start, no session yet → placeholder ("Choose workspace");
  //   3. the blank session's workspace is in the list → its title;
  //   4. list still loading → cwd folder name bridges so the title does not
  //      flash on refresh (empty cwd → placeholder);
  //   5. list ready but no owning workspace (deleted from the sidebar) →
  //      placeholder, never the deleted folder's name via cwd.
  const chipTitle = pendingWorkspace?.title
    ?? (sessionId === undefined
      ? undefined
      : sessionWorkspace?.title
        ?? (workspaces.phase === 'ready' || cwd === undefined || cwd === ''
          ? undefined
          : workspaceLabel(cwd)))

  // task 泳道会话：工作区在建会话时已绑定、Agent 已锁定，**不渲染**
  // 「选择工作区」chip + workspace picker + 官方 agentPreset 选择器——整行不出现
  // （2026-08-31 用户走查：新会话界面顶部不该有「选择工作区」）。Agent 锁定
  // 标识挪进 composer 工具栏（见 inputBar 的 leftItems）。
  // 子 Agent 会话同样不渲染（① 用户定调：子 Agent 由父 Agent 管控，无工作区选择）。
  const heroWorkspaceRow = isTaskLane || isSubagentSession
    ? null
    : (
      <div className={css.heroWorkspaceRow}>
        <WorkspaceChip
          buttonRef={pickerAnchor}
          label={chipTitle}
          menuOpen={pickerOpen}
          onClick={() => { setPickerOpen(open => !open) }}
          t={t}
        />
        {renderSlot('conversation.hero.workspace', {
          open: pickerOpen,
          anchorRef: pickerAnchor,
          selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,
          onPick: (workspaceId) => {
            setPickerOpen(false)
            setPendingWorkspaceId(workspaceId)
            void selectWorkspace(workspaceId).catch(() => {
              setPendingWorkspaceId(current => current === workspaceId ? undefined : current)
            })
          },
          onClose: () => { setPickerOpen(false) },
        })}
        {renderSlot('conversation.hero.agentPreset', {})}
      </div>
    )

  // task 泳道会话的 Agent 名片信息（副标语「由 X 执行」+ 对话起始页专业推荐命令）：
  // 所有 task 泳道（blank 与正式会话）都查，发消息切换会话时也保持。
  const [agentInfo, setAgentInfo] = useState<TaskAgentInfo | undefined>(undefined)
  useEffect(() => {
    if (!isTaskLane || sessionId === undefined) { setAgentInfo(undefined); return }
    let alive = true
    emptyActions.getTaskAgentInfo(String(sessionId))
      .then((info) => { if (alive) setAgentInfo(info) })
      .catch(() => { /* 查询失败则不显示 Agent 名，推荐命令回退通用集 */ })
    return () => { alive = false }
  }, [isTaskLane, sessionId, emptyActions])

  // 可选 Agent chip（2026-09-02 用户定调）：task 泳道 composer 的 Agent 从只读
  // 锁定 chip 改为可选下拉——blank 泳道可换 Agent（官方 agentPresets.select blank
  // 限定；已开始会话 host 拒绝、catch 呈现）。profileId 经 listTaskAgents 拿；
  // 下拉选项经 listAgents（listProfiles 投影）。
  const [agentProfileId, setAgentProfileId] = useState('')
  const [agentOptions, setAgentOptions] = useState<readonly { id: string; name: string; title?: string; dimension?: string; source?: 'corum' | 'official'; trust?: 'system' | 'user' }[]>([])
  const [agentSwitchError, setAgentSwitchError] = useState('')
  useEffect(() => {
    if (!isTaskLane || sessionId === undefined) { setAgentProfileId(''); return }
    let alive = true
    // listTaskAgents 拿当前 profileId + listAgents 拿下拉选项（同 getTaskAgentName 通路）。
    Promise.all([
      emptyActions.listAgents(),
      emptyActions.getTaskAgentProfileId(String(sessionId)),
    ])
      .then(([options, profileId]) => {
        if (!alive) return
        setAgentOptions(options.map((o) => ({
          id: o.id,
          name: o.name,
          ...(o.title === undefined ? {} : { title: o.title }),
          ...(o.dimension === undefined ? {} : { dimension: o.dimension }),
          ...(o.source === undefined ? {} : { source: o.source }),
          ...(o.trust === undefined ? {} : { trust: o.trust }),
        })))
        setAgentProfileId(profileId ?? options[0]?.id ?? '')
      })
      .catch(() => { /* 拉取失败：下拉留空，不可切换 */ })
    return () => { alive = false }
  }, [isTaskLane, sessionId, emptyActions])
  const switchAgent = useCallback((profileId: string) => {
    if (sessionId === undefined || profileId === agentProfileId) return
    setAgentSwitchError('')
    void emptyActions.selectTaskAgent(String(sessionId), profileId)
      .then(() => {
        setAgentProfileId(profileId)
        // 名片信息同步刷新（副标语 + 专业推荐命令随新 Agent 更新）。
        const option = agentOptions.find((o) => o.id === profileId)
        if (option !== undefined) {
          setAgentInfo({
            name: option.name,
            ...(option.title === undefined ? {} : { title: option.title }),
            ...(option.dimension === undefined ? {} : { dimension: option.dimension }),
          })
        }
      })
      .catch((e) => {
        // 失败绝不静默吞（PROGRESS §4）：呈现原因，下拉回弹当前值。
        console.error('[conversation] switch task agent failed', e)
        setAgentSwitchError(e instanceof Error ? e.message : String(e))
      })
  }, [sessionId, agentProfileId, agentOptions, emptyActions])

  // The placeholder chip ("Choose workspace") and the Workspace-trigger input travel
  // together: no workspace picked yet (cold start, no session at all), or a
  // blank session whose workspace vanished (deleted from the sidebar). The
  // bar is ONE session-maybe slot rendered unconditionally — inert is a prop,
  // not a different tree, so the textarea DOM survives the transition.
  // 只有「真没选中会话」才 inert。原判定 `(hero && chipTitle === undefined)` 会在
  // 工作区列表未加载完时把**已选中会话**的输入框也禁掉——用户刚建完任务就被卡住。
  const inert = !hasSession
  // A raised block is the same inert posture with the blocker's own reason:
  // one disabled textarea, never a second tree. The no-workspace state wins
  // when both hold — picking a workspace is the earlier prerequisite.
  const blocked = !inert && composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    variant: hasSession ? 'composer' : 'hero',
    ...(inert
      ? {
        disabled: true,
        placeholder: t('placeholder.workspace'),
        workspacePickerOpen: pickerOpen,
        onRequestWorkspace: () => { setPickerOpen(true) },
      }
      : blocked
        // `blocked`, not `disabled`: the bar refuses input either way, but a
        // block keeps the model seat live because choosing a model is how the
        // user clears it.
        ? { blocked: composerBlock, placeholder: composerBlock.reason }
        : hasSession ? {} : { placeholder: t('placeholder.hero') }),
    overlay: sessionId === undefined ? undefined : renderSlot('conversation.input.overlay', {}),
    leftItems: zone === undefined ? null : (
      <>
        {/* Agent 选择放进 composer 工具栏（2026-09-02 用户定调）：task 泳道 composer
            的 Agent 从只读锁定 chip 改为可选下拉——**只在 blank（未发首条消息）时
            渲染**；一旦开始第一次对话（非 blank）整个隐藏，不允许用户更改
            （官方 agentPresets.select blank 限定，非 blank host 必拒绝）。 */}
        {isTaskLane && summaryBlank === true && (
          <span className={css.agentLockChip} data-select>
            <Bot size={12} />
            {/* 二级分组选择器（2026-09-07）：预置 25 角色后列表收敛为通用/
                Corum 内置/用户三组 + 组内展开；面板向右上浮出（chip 在 composer
                工具栏底部），切换失败仍走 agentSwitchError 提示。 */}
            <AgentTwoLevelSelect
              agents={agentOptions}
              value={agentProfileId}
              onChange={switchAgent}
              ariaLabel={agentSwitchError !== '' ? `选择执行 Agent（切换失败：${agentSwitchError}）` : '选择执行 Agent'}
              disabled={agentOptions.length === 0}
              css={{
                root: css.agentSelRoot,
                trigger: css.agentSelTrigger,
                triggerName: css.agentSelTriggerName,
                chevron: css.agentSelChevron,
                panel: css.agentSelPanel,
                searchRow: css.agentSelSearchRow,
                searchIcon: css.agentSelSearchIcon,
                searchInput: css.agentSelSearchInput,
                searchClear: css.agentSelSearchClear,
                groupHead: css.agentSelGroupHead,
                groupLabel: css.agentSelGroupLabel,
                groupCount: css.agentSelGroupCount,
                list: css.agentSelList,
                item: css.agentSelItem,
                itemCheck: css.agentSelItemCheck,
                itemHint: css.agentSelItemHint,
                empty: css.agentSelEmpty,
              }}
            />
          </span>
        )}
        {renderSlot('conversation.input.left', zone)}
        {/* 会话内提示词润色（结合最近对话上下文，意图自动判断：推进/新问题/BUG） */}
        {hasSession && (
          <button
            type="button"
            className={css.polishBtn}
            title={polishBusy ? '润色中…' : 'AI 润色（结合对话上下文优化本次提问）'}
            disabled={polishBusy || (inputState?.draft?.trim() ?? '') === ''}
            onClick={() => void doPolish()}
          >
            <Wand2 size={13} />
          </button>
        )}
      </>
    ),
    rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
    // Ambient dock under the card shares the composer's width constraint.
    footer: hasSession && zone !== undefined ? renderSlot('conversation.composer.dock', zone) : null,
  })

  // blank 会话（刚建好还没发消息）也按 hero 相位布局：让 scrollBody 垂直居中、
  // composerStack 走 .composerHero（align-self center + composer 宽度对齐），
  // 标语/快捷指令卡/输入框垂直水平居中对齐（设计稿 L4）。发第一条消息 blank 翻转
  // 后回到 active 底部停靠。
  const isNewSessionHero = hasSession && summaryBlank === true

  const composerBar = (
    <div className={clsx(css.composerStack, (!hasSession || isNewSessionHero) && css.composerHero)}>
      {!hasSession && <HeroGlow className={css.heroGlow} />}
      {/* 空态（2026-08-30 设计稿 DjFev）：大 logo + 操作卡（新建项目 / 新建任务）
          替代 fork 官方 HeroShell（品牌标语 + 工作区选择）。设计稿空态只有
          logo + 卡 + 提示。
          **只在「真的没选中会话」时渲染**：已选中会话（含 blank——刚建好还没
          发消息的泳道）必须渲染 composer 输入框，否则用户无处发第一条指令。 */}
      {!hasSession && <EmptyStateHero emptyActions={emptyActions} newTaskForm={newTaskForm} recentTasks={recentTasks} dark={dark} />}
      {/* 新会话界面（设计稿 L4）：已选中 blank 会话（刚建好还没发消息）时，
          在 composer 上方渲染标语 + 快捷指令卡。点卡把指令填入输入框待发送；
          发第一条消息后 blank 翻转、本界面消失、进入正式会话。 */}
      {hasSession && summaryBlank === true && (
        <NewSessionHero
          workspaceTitle={chipTitle ?? (cwd !== undefined && cwd !== '' ? workspaceLabel(cwd) : undefined)}
          agentInfo={agentInfo}
          onPick={(prompt) => { inputActions?.setDraft(prompt) }}
        />
      )}
      {hasSession && heroWorkspaceRow}
      {zone !== undefined && !isSubagentSession && renderSlot('conversation.input.dock', zone)}
      {/* ② 子 Agent 会话：隐藏输入框，底部改「返回父会话」撑满条（子 Agent 由父
          Agent 发起和管控，用户不可干涉；返回条宽度对齐原 composer 输入框宽度——
          走 .subagentReturnBar 与 inputBar 同 max-width 约束）。 */}
      {hasSession && !isSubagentSession && inputBar}
      {hasSession && isSubagentSession && (
        <div className={css.subagentReturnBar}>
          <button
            type="button"
            className={css.subagentReturnBtn}
            disabled={parentSessionId === undefined}
            onClick={() => {
              if (parentSessionId === undefined) return
              // openTask 内部即 sessions.open（task 泳道跳转通道）；父会话是 task
              // 泳道，可寻址。失败静默（返回条仍展示上下文）。
              void emptyActions.openTask(String(parentSessionId)).catch(() => {})
            }}
          >
            <ArrowLeft size={16} strokeWidth={2} className={css.subagentReturnIcon} />
            <span className={css.subagentReturnLabel}>{t('subagent.backToParent')}</span>
            <span className={css.subagentReturnHint}>{t('subagent.managedByParent')}</span>
          </button>
        </div>
      )}
    </div>
  )

  const phase = settling ? 'settling' : (!hasSession || isNewSessionHero) ? 'hero' : 'active'
  const composer = renderSlotChain(
    'conversation.composer',
    { sessionId, session, pendingInteraction },
    { fallback: composerBar, fallbackOnly: sessionId === undefined, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave a business-owned takeover at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  return (
    <div ref={rootResizeRef} className={css.root} data-phase={phase}>
      {sessionId === undefined ? null : renderSlot('conversation.session.header', {})}
      <div className={css.scrollBody} data-conversation-scroll="">
        {sessionId === undefined ? null : renderSlot('conversation.session', {})}
        {composerSeat}
      </div>
      {/* Width handles only while a transcript is on screen; the hero has no
          content column to size. */}
      {phase === 'active' && (['left', 'right'] as const).map(side => (
        <WidthHandle
          key={side}
          side={side}
          onStart={onHandleStart}
          onDrag={onHandleDrag}
          onCommit={onHandleCommit}
          onEnd={onHandleEnd}
        />
      ))}
    </div>
  )
}
