// fork（corum）：子 Agent 进度卡——主 Agent 召唤子 Agent（delegation）时在消息瀑布
// 中流出的玻璃卡。对齐设计稿「子Agent卡 交互改动稿（4 项）」（q0T81）：
//   head = avatar(bot) + meta(name 16 / task 14 / 模型行 13) + chip(纯状态 Running/Done)
//          + act-expand(∨/∧ 展开任务详情) + act-goto(→ 跳子会话)
//   prog = 4px 进度条（step 驱动渐近；无 progress 时不确定动画）——常驻
//   step = loader + 「Step n · currentAction」实时行——**常驻**（不收进下拉）
//   任务详情（展开区）= 父 Agent 注入的提示词全文（host getSubagentSessionMeta 提取
//   子会话首条 user/message）——仅展开时显示
// 进度数据源（统一事件中心三-3，轮询 → 推送）：
//   主路径 = 'corum/subagent/progress' $on 推送帧（host corumAgent 在
//   session/event 追加点 O(1) 增量折叠并 emit，帧即最终进度，client 零 RPC）；
//   冷启动基线 = 挂载时一次性 RPC getChildSessionProgress（回填推送开始前
//   的历史）；降级兜底 = 订阅宽限期内零推送帧（旧 host 不 emit）回退 2s 轮询。
// 模型行读官方 session/list 行的 modelSelection 投影（挂载时读一次——模型在
// 会话生命周期内基本不变，原 4s 轮询已删）。
// 跨 bundle 句柄（当前会话 id + RPC connection + 跳子会话桥）经 chatRuntime
// cordis 服务消费（统一事件中心二期 window 全局迁移；同 bundle 模块级
// chatRuntimeRef 拿服务实例，见 ../chat-runtime.ts）。
import { memo, useEffect, useState } from 'react'
import { ArrowRight, Ban, Bot, Check, ChevronDown, ChevronUp, Cpu, FileText, GitBranch, Loader, X } from 'lucide-react'
import { subagentOutcomeOf, subagentOutcomeChipTone } from '@corum/corum-api-remotes/corum-events'
import type { SubagentStopReason } from '@corum/corum-api-remotes/corum-events'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { SubagentProgressSnapshot } from '../contract/subagent.ts'
import { chatRuntimeRef, subagentChildOf, subagentChildSubscribe, subagentProgressSubscribe } from '../chat-runtime.ts'
import css from './SubagentCard.module.css'
import { SubagentChanges } from './SubagentChanges.tsx'

/** 子会话进度 RPC 返回形（与 host getChildSessionProgress 对齐）。 */
interface ChildProgressValue {
  progress?: {
    turn: number
    step: number
    currentAction?: string
    done: boolean
    stopReason?: string
    lastActive: number
  }
}

/** 合法化跨包 JSON 面的 stopReason（不认识的字符串不当成功）。 */
const VALID_STOP_REASONS = new Set(['completed', 'aborted', 'error', 'max-tokens', 'refusal'])

function normalizeStopReason(raw: string | undefined): SubagentStopReason | undefined {
  if (raw === undefined) return undefined
  return VALID_STOP_REASONS.has(raw) ? raw as SubagentStopReason : undefined
}

/** 子会话 meta RPC 返回形（与 host getSubagentSessionMeta 对齐）。 */
interface SubagentMetaValue {
  meta?: { prompt?: string }
}

/** session/list 行 projections.values.modelSelection 的窄化形。 */
interface ModelSelectionProjection {
  lastUsed?: { provider?: string; model?: string; reasoningEffort?: string }
}

/** 已知 provider/model 段的官方显示名（kebab 段的非常规大小写映射）。 */
const MODEL_SEGMENT_DISPLAY: Readonly<Record<string, string>> = {
  deepseek: 'DeepSeek',
}

/** 模型显示文案：「DeepSeek-V4-Flash · High」——model 字段 kebab 段映射显示名。 */
function modelLabel(projection: ModelSelectionProjection | undefined): string | undefined {
  const m = projection?.lastUsed
  if (m?.model === undefined || m.model === '') return undefined
  const name = m.model
    .split('-')
    .map(part => MODEL_SEGMENT_DISPLAY[part]
      ?? (part === 'v' || /^\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('-')
  const effort = m.reasoningEffort === undefined || m.reasoningEffort === ''
    ? undefined
    : m.reasoningEffort.charAt(0).toUpperCase() + m.reasoningEffort.slice(1)
  return effort === undefined ? name : `${name} · ${effort}`
}

/** 读子会话模型显示（官方 session/list RPC 行的 projectionValues.modelSelection 投影）。 */
function useChildModel(childSessionId: string | undefined): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) { setLabel(undefined); return undefined }
    let cancelled = false
    const read = async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'session/list', { args: { _request: { limit: 200 } } })
        if (cancelled) return
        if (!result.ok || result.value === undefined) return
        const value = result.value as { items?: ReadonlyArray<{ sessionId?: string; projections?: { values?: { modelSelection?: ModelSelectionProjection } } }> }
        const row = (value.items ?? []).find(item => item.sessionId === childSessionId)
        setLabel(modelLabel(row?.projections?.values?.modelSelection))
      } catch {
        // 单次失败留空（模型行缺省不显示）。
      }
    }
    // 统一事件中心三-3：模型在会话生命周期内基本不变（缺省随父 profile
    // 编译期注入），原 4s setInterval 轮询已删——挂载时读一次即可。
    void read()
    return () => { cancelled = true }
  }, [childSessionId])
  return label
}

/** 推送通道宽限期（ms）：$on 订阅建立后这么久仍零推送帧 → 判定推送未生效（旧 host 不 emit），回退轮询。 */
const PROGRESS_PUSH_GRACE_MS = 2500
/** 降级兜底轮询周期（ms）：推送未生效时的拉取节奏（与迁移前一致）。 */
const PROGRESS_FALLBACK_POLL_MS = 2000

/**
 * 子会话精确进度（统一事件中心三-3：推送主路径 + 冷启动基线 + 降级轮询）。
 *
 * 主路径：$on('corum/subagent/progress') 帧直收（host 已按同口径折叠好，
 * 零 RPC）；挂载时一次性 RPC 基线回填推送开始前已发生的历史；宽限期内零
 * 推送帧（旧 host 不 emit）回退 2s RPC 轮询，一旦有帧到达轮询永不起动。
 */
/**
 * 子会话精确进度（推送主路径 + 冷启动基线 + 降级轮询）。
 *
 * **导出给编排卡复用**（2026-09-12）：`orchestrate` 的每个分支也要按自己子会话的实时
 * 进度翻状态，否则并行任务各自完成后仍显示「运行中」，要等整批 settle 才一起翻。
 */
export function useChildProgress(childSessionId: string | undefined): SubagentProgressSnapshot | undefined {
  const [progress, setProgress] = useState<SubagentProgressSnapshot | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) return undefined
    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let graceTimer: ReturnType<typeof setTimeout> | undefined

    /** RPC 拉一次基线/兜底进度（host getChildSessionProgress 全量折叠）。 */
    const fetchOnce = async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'corumAgent/getChildSessionProgress', {
          args: { sessionId: childSessionId },
        })
        if (cancelled) return
        if (result.ok && result.value !== undefined) {
          const value = result.value as ChildProgressValue
          if (value.progress !== undefined) {
            const p = value.progress
            const sr = normalizeStopReason(p.stopReason)
            setProgress({
              turn: p.turn,
              step: p.step,
              ...p.currentAction === undefined ? {} : { currentAction: p.currentAction },
              done: p.done,
              ...sr === undefined ? {} : { stopReason: sr },
            })
          }
        }
      } catch {
        // 单次拉取失败静默；会话不存在时 host 返回 {}，progress 维持 undefined。
      }
    }

    // 冷启动基线：推送只覆盖订阅建立之后的事件——卡片晚开（子会话已在跑/
    // 已完成）时历史进度靠这一次全量折叠回填。
    void fetchOnce()

    // 主路径：推送帧直收（帧即最终进度，按 sessionId 过滤本卡子会话）。
    const sub = subagentProgressSubscribe((frame) => {
      if (cancelled || frame.sessionId !== childSessionId) return
      const sr = normalizeStopReason(frame.stopReason as string | undefined)
      setProgress({
        turn: frame.turn,
        step: frame.step,
        ...frame.currentAction === undefined ? {} : { currentAction: frame.currentAction },
        done: frame.done,
        ...sr === undefined ? {} : { stopReason: sr },
      })
    })

    // 降级兜底：宽限期内任何会话的推送帧都没到（旧 host 不 emit / 通道未
    // 生效）→ 回退 2s 轮询（自循环 setTimeout，拉取失败下轮重试）。
    graceTimer = setTimeout(() => {
      graceTimer = undefined
      if (cancelled || sub.framesSeen() > 0) return
      const poll = async () => {
        await fetchOnce()
        if (!cancelled) pollTimer = setTimeout(() => { void poll() }, PROGRESS_FALLBACK_POLL_MS)
      }
      void poll()
    }, PROGRESS_PUSH_GRACE_MS)

    return () => {
      cancelled = true
      sub.unsubscribe()
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
    }
  }, [childSessionId])
  return progress
}

/** 拉取父 Agent 注入的提示词（任务详情展开区数据源，仅展开时拉一次）。 */
function useSubagentPrompt(childSessionId: string | undefined, expanded: boolean): string | undefined {
  const [prompt, setPrompt] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined || !expanded || prompt !== undefined) return undefined
    let cancelled = false
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'corumAgent/getSubagentSessionMeta', {
          args: { sessionId: childSessionId },
        })
        if (cancelled) return
        if (result.ok && result.value !== undefined) {
          const value = result.value as SubagentMetaValue
          if (value.meta?.prompt !== undefined) setPrompt(value.meta.prompt)
        }
      } catch {
        // 拉取失败留空（展开区降级为「无任务详情」）。
      }
    })()
    return () => { cancelled = true }
  }, [childSessionId, expanded, prompt])
  return prompt
}

/** 进度条填充比例：以 step 步数为最小步进（无总步数，单调爬升渐近 100%）。 */
function progressRatio(progress: SubagentProgressSnapshot): number {
  if (subagentOutcomeOf(progress.stopReason) !== undefined) return 1
  return Math.min(0.1 + progress.step * 0.18, 0.9)
}

/** 底部 step 行文案：「Step n · action」/「Step n」/ prompt 摘要 / 默认 working。 */
function runningStepText(
  progress: SubagentProgressSnapshot | undefined,
  prompt: string | undefined,
  t: ChatNodeViewProps<'subagent-call'>['t'],
): string {
  if (progress === undefined) return prompt ?? t('subagent.working')
  const stepLabel = t('subagent.step', { n: progress.step })
  return progress.currentAction === undefined
    ? stepLabel
    : `${stepLabel} · ${progress.currentAction}`
}

/**
 * 子会话身份（id + 前台/后台模式）的实时解析（2026-09-09）。
 *
 * 顺序：宿主 spawn 广播（'corum/subagent/child'，精确 id + 权威 mode）> 本进程
 * 已观测缓存 > fold 出的历史匹配（summary 时间就近给 id、工具参数给 mode，仅页面
 * 刷新后兜底）。广播到达即触发重渲染，于是 goto 按钮、进度订阅与模式徽标在运行期
 * 第一帧就可用，不必等子会话结束。
 * @param callId - 父侧 tool/call id（卡片身份）。
 * @param fallbackId - conversation fold 给出的兜底 id（可能 undefined）。
 * @param fallbackMode - conversation fold 从工具参数推出的兜底模式（可能 undefined）。
 * @returns 当前可用的子会话 id 与模式。
 */
function useLiveChildIdentity(
  callId: string,
  fallbackId: string | undefined,
  fallbackMode: 'foreground' | 'background' | undefined,
): {
  readonly childSessionId: string | undefined
  readonly mode: 'foreground' | 'background' | undefined
  readonly worktree: { readonly slug: string; readonly branch: string } | undefined
} {
  const [live, setLive] = useState(() => subagentChildOf(callId))
  useEffect(() => {
    setLive(subagentChildOf(callId))
    const sub = subagentChildSubscribe((frame) => {
      if (frame.callId !== callId) return
      setLive({
        childSessionId: frame.childSessionId,
        mode: frame.mode,
        ...frame.worktree === undefined ? {} : { worktree: frame.worktree },
      })
    })
    return () => { sub.unsubscribe() }
  }, [callId])
  return {
    childSessionId: live?.childSessionId ?? fallbackId,
    mode: live?.mode ?? fallbackMode,
    worktree: live?.worktree,
  }
}

/** 一个 delegation 召唤的卡片（进度由 'corum/subagent/progress' 推送注入，见 useChildProgress）。 */
function SubagentRow({
  callId, description, prompt: delegationPrompt, childSessionId: foldedChildSessionId,
  mode: foldedMode, t,
}: {
  callId: string
  description: string | undefined
  prompt: string | undefined
  childSessionId: string | undefined
  mode: 'foreground' | 'background' | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  // hooks 顺序恒定（React #310）：必须在任何 early return 之前。
  const { childSessionId, mode, worktree } = useLiveChildIdentity(callId, foldedChildSessionId, foldedMode)
  const progress = useChildProgress(childSessionId)
  const model = useChildModel(childSessionId)
  const [expanded, setExpanded] = useState(false)
  const detailPrompt = useSubagentPrompt(childSessionId, expanded)
  const outcome = subagentOutcomeOf(progress?.stopReason)
  const running = outcome === undefined
  const chipTone = subagentOutcomeChipTone(outcome)

  const openChild = () => {
    if (childSessionId === undefined) return
    // chatRuntime 服务的跳子会话桥（替代 __corumOpenSession window 全局）。
    chatRuntimeRef.current?.openSession(childSessionId)
  }

  return (
    <div
      className={css.card}
      data-child-session-id={childSessionId || undefined}
    >
      <div className={css.head}>
        <span className={css.avatar}><Bot size={16} strokeWidth={2} className={css.avatarIcon} /></span>
        <span className={css.meta}>
          <span className={css.name}>{t('subagent.name')}{description !== undefined ? ` · ${description}` : ''}</span>
          {model !== undefined && (
            <span className={css.modelRow}>
              <Cpu size={13} strokeWidth={2} className={css.modelIcon} />
              <span className={css.modelText}>{model}</span>
            </span>
          )}
          {/* 隔离 worktree 行（设计稿 sub：`worktree · wt-1b3dcf`）。
              数据源 = 本卡自己那次 spawn 的 'corum/subagent/child' 广播帧
              （携带 worktree 三件套）——**每卡自己的子会话**，故不会像会话级
              台账 chip 那样随节点数重复 N 份（那正是 c0e69443 移除它的原因）。 */}
          {worktree !== undefined && (
            <span className={css.modelRow} title={t('subagent.worktreeTitle')}>
              <GitBranch size={13} strokeWidth={2} className={css.modelIcon} />
              <span className={css.modelText}>{worktree.slug}</span>
            </span>
          )}
        </span>
        {mode !== undefined && (
          <span
            className={mode === 'background' ? css.modeChipBg : css.modeChipFg}
            title={t(mode === 'background' ? 'subagent.mode.backgroundTitle' : 'subagent.mode.foregroundTitle')}
          >
            {t(mode === 'background' ? 'subagent.mode.background' : 'subagent.mode.foreground')}
          </span>
        )}
        <span
          className={chipTone === 'running' ? css.runChip : chipTone === 'done' ? css.doneChip : chipTone === 'aborted' ? css.stopChip : css.failChip}
          data-outcome={outcome ?? 'running'}
        >
          {chipTone === 'running'
            ? <><span className={css.runDot} />{t('subagent.running')}</>
            : chipTone === 'done'
              ? <><Check size={12} strokeWidth={2.5} />{t('subagent.done')}</>
              : chipTone === 'aborted'
                ? <><Ban size={12} strokeWidth={2.5} />{t('subagent.stopped')}</>
                : <><X size={12} strokeWidth={2.5} />{t('subagent.failed')}</>}
        </span>
        <button
          type="button"
          className={css.actBtn}
          title={expanded ? t('subagent.collapse') : t('subagent.expand')}
          aria-label={expanded ? t('subagent.collapse') : t('subagent.expand')}
          aria-expanded={expanded}
          onClick={() => { setExpanded(open => !open) }}
        >
          {expanded
            ? <ChevronUp size={17} strokeWidth={2} className={css.actIconMuted} />
            : <ChevronDown size={17} strokeWidth={2} className={css.actIconMuted} />}
        </button>
        <button
          type="button"
          className={css.actBtn}
          title={t('subagent.goto')}
          aria-label={t('subagent.goto')}
          disabled={childSessionId === undefined}
          onClick={openChild}
        >
          <ArrowRight size={17} strokeWidth={2} className={css.actIconBrand} />
        </button>
      </div>
      {running && (
        <div className={css.prog}>
          <div
            className={progress === undefined ? `${css.progBar} ${css.progBarIndeterminate}` : css.progBar}
            style={progress === undefined ? undefined : { width: `${Math.round(progressRatio(progress) * 100)}%` }}
          />
        </div>
      )}
      {/* ④ step 行常驻（不收进下拉）：展开/收起两态都显示，运行中实时刷新。 */}
      {running && (
        <div className={css.stepRow}>
          <Loader size={15} strokeWidth={2} className={css.stepIcon} />
          <span className={css.stepText}>{runningStepText(progress, delegationPrompt, t)}</span>
        </div>
      )}
      {/* ③ 任务详情（展开区）：父 Agent 注入的提示词全文，仅展开时显示。 */}
      {expanded && (
        <div className={css.detail}>
          <div className={css.detailHead}>
            <FileText size={14} strokeWidth={2} className={css.detailIcon} />
            <span className={css.detailTitle}>{t('subagent.taskDetail')}</span>
          </div>
          <div className={css.detailBody}>
            {detailPrompt ?? delegationPrompt ?? t('subagent.working')}
          </div>
        </div>
      )}
      {/* ④ 改动（展开区）：子会话终态时列出改动文件 ±N + diff + 撤销。
          数据源 = host 终态帧 corum/subagent/progress.changeSummary
          （corumReview.snapshot(childSessionId) + 台账状态）。子 Agent 还在跑
          时 changeSummary 缺省 → 组件返回 null，不占展开区空间。 */}
      {expanded && (
        <SubagentChanges
          childSessionId={childSessionId}
          worktree={worktree}
          t={t}
        />
      )}
    </div>
  )
}

/** 子 Agent 进度卡（一个 Turn 的 delegation 召唤们，各自一张卡）。 */
export const SubagentCard = memo(function SubagentCard({ node, t }: ChatNodeViewProps<'subagent-call'>) {
  const invocations = node.data.invocations
  if (invocations.length === 0) return null
  return (
    <>
      {invocations.map(invocation => (
        <SubagentRow
          key={invocation.callId}
          callId={invocation.callId}
          description={invocation.description}
          prompt={invocation.prompt}
          childSessionId={invocation.childSessionId}
          mode={invocation.mode}
          t={t}
        />
      ))}
      {/* 台账 chip 已移出卡片（2026-09-10 P8）：每次委托一个节点后，卡内渲染会
          随节点数重复 N 份；「并行工作区」改由会话条/统计浮层承载（下一轮）。 */}
    </>
  )
})
