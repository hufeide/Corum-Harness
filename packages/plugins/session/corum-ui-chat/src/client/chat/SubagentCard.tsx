// fork（corum）：子 Agent 进度卡——主 Agent 召唤子 Agent（delegation）时在消息瀑布
// 中流出的玻璃卡。对齐设计稿「子Agent卡 交互改动稿（4 项）」（q0T81）：
//   head = avatar(bot) + meta(name 16 / task 14 / 模型行 13) + chip(纯状态 Running/Done)
//          + act-expand(∨/∧ 展开任务详情) + act-goto(→ 跳子会话)
//   prog = 4px 进度条（step 驱动渐近；无 progress 时不确定动画）——常驻
//   step = loader + 「Step n · currentAction」实时行——**常驻**（不收进下拉）
//   任务详情（展开区）= 父 Agent 注入的提示词全文（host getSubagentSessionMeta 提取
//   子会话首条 user/message）——仅展开时显示
// 进度由卡片自闭环轮询子会话事件窗注入（corumAgent/getChildSessionProgress）；
// 模型行读官方 session/list 行的 modelSelection 投影。
// 跨 bundle 句柄（当前会话 id + RPC connection + 跳子会话桥）经 chatRuntime
// cordis 服务消费（统一事件中心二期 window 全局迁移；同 bundle 模块级
// chatRuntimeRef 拿服务实例，见 ../chat-runtime.ts）。
import { memo, useEffect, useState } from 'react'
import { ArrowRight, Bot, Check, ChevronDown, ChevronUp, Cpu, FileText, Loader } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { SubagentProgressSnapshot } from '../contract/subagent.ts'
import { chatRuntimeRef } from '../chat-runtime.ts'
import css from './SubagentCard.module.css'

/** 子会话进度 RPC 返回形（与 host getChildSessionProgress 对齐）。 */
interface ChildProgressValue {
  progress?: {
    turn: number
    step: number
    currentAction?: string
    done: boolean
    lastActive: number
  }
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
        // 单次失败留空（下轮重试）。
      }
    }
    void read()
    // 模型在会话生命周期内可变（用户切换）；挂个轻量轮询跟 session/list 更新。
    const timer = setInterval(() => { void read() }, 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [childSessionId])
  return label
}

/** 轮询子会话事件窗算精确进度（2s 间隔；仅当卡片已知 childSessionId 时启用）。 */
function useChildProgress(childSessionId: string | undefined): SubagentProgressSnapshot | undefined {
  const [progress, setProgress] = useState<SubagentProgressSnapshot | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) {
        timer = setTimeout(poll, 2000)
        return
      }
      try {
        const result = await conn.rpc.call('/api', 'corumAgent/getChildSessionProgress', {
          args: { sessionId: childSessionId },
        })
        if (cancelled) return
        if (result.ok && result.value !== undefined) {
          const value = result.value as ChildProgressValue
          if (value.progress !== undefined) {
            const p = value.progress
            setProgress({
              turn: p.turn,
              step: p.step,
              ...p.currentAction === undefined ? {} : { currentAction: p.currentAction },
              done: p.done,
            })
          }
        }
      } catch {
        // 单次轮询失败静默（下轮重试）；会话不存在时 host 返回 {}，progress 维持 undefined。
      }
      if (!cancelled) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
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
  if (progress.done) return 1
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

/** 一个 delegation 召唤的卡片（进度由子会话事件窗轮询注入）。 */
function SubagentRow({
  description, prompt: delegationPrompt, childSessionId, t,
}: {
  description: string | undefined
  prompt: string | undefined
  childSessionId: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const progress = useChildProgress(childSessionId)
  const model = useChildModel(childSessionId)
  const [expanded, setExpanded] = useState(false)
  const detailPrompt = useSubagentPrompt(childSessionId, expanded)
  const done = progress?.done === true
  const running = !done

  const openChild = () => {
    if (childSessionId === undefined) return
    // chatRuntime 服务的跳子会话桥（替代 __corumOpenSession window 全局）。
    chatRuntimeRef.current?.openSession(childSessionId)
  }

  return (
    <div className={css.card}>
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
        </span>
        <span className={running ? css.runChip : css.doneChip}>
          {running
            ? <><span className={css.runDot} />{t('subagent.running')}</>
            : <><Check size={12} strokeWidth={2.5} />{t('subagent.done')}</>}
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
          description={invocation.description}
          prompt={invocation.prompt}
          childSessionId={invocation.childSessionId}
          t={t}
        />
      ))}
    </>
  )
})
