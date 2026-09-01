// fork（corum）：子 Agent 进度卡——主 Agent 召唤子 Agent（delegation）时在消息瀑布
// 中流出的玻璃卡。对齐设计稿组件 bSZm5（subagent-card）/ O0J3e（expanded）：
//   head = avatar(bot) + meta(name+task) + chip(纯状态 Running/Done) + act-expand + act-goto
//   prog = 4px 进度条（step 驱动渐近；无 progress 时不确定动画）
//   step = loader + 「Step n · currentAction」实时行（done 收起）
//   steps（展开态）= 逐步清单（check 已完成 / loader 进行中 / circle 待执行）
// 进度由卡片自闭环轮询子会话事件窗注入（corumAgent/getChildSessionProgress）。
import { memo, useEffect, useState } from 'react'
import { ArrowRight, Bot, Check, ChevronDown, ChevronUp, Circle, Loader } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { SubagentProgressSnapshot } from '../contract/subagent.ts'
import css from './SubagentCard.module.css'

/** 跨 bundle 会话/RPC 句柄（apply.ts 在 conversation.view 挂载时写入）。 */
interface CorumChatRuntime {
  sessionId: string | undefined
  connection: { rpc: { call: (channel: string, endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> } } | undefined
}

function runtime(): CorumChatRuntime | undefined {
  return (window as { __corumChatRuntime?: CorumChatRuntime }).__corumChatRuntime
}

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

/** 轮询子会话事件窗算精确进度（2s 间隔；仅当卡片已知 childSessionId 时启用）。 */
function useChildProgress(childSessionId: string | undefined): SubagentProgressSnapshot | undefined {
  const [progress, setProgress] = useState<SubagentProgressSnapshot | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const connection = runtime()?.connection
      if (connection === undefined) {
        timer = setTimeout(poll, 2000)
        return
      }
      try {
        const result = await connection.rpc.call('/api', 'corumAgent/getChildSessionProgress', {
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

/** 展开态步骤清单行（check 完成 / loader 进行中 / circle 待执行）。 */
function StepListRow({ icon, text, dimmed, done }: {
  icon: 'check' | 'loader' | 'circle'
  text: string
  dimmed?: boolean
  done?: boolean
}) {
  return (
    <div className={css.stepListRow}>
      {icon === 'check' && <Check size={13} strokeWidth={2.5} className={css.stepListDone} />}
      {icon === 'loader' && <Loader size={13} strokeWidth={2} className={css.stepListRunning} />}
      {icon === 'circle' && <Circle size={13} strokeWidth={2} className={css.stepListTodo} />}
      <span className={dimmed === true ? css.stepListTextDimmed : done === true ? css.stepListTextDone : css.stepListText}>{text}</span>
    </div>
  )
}

/** 一个 delegation 召唤的卡片（进度由子会话事件窗轮询注入）。 */
function SubagentRow({
  description, prompt, childSessionId, t,
}: {
  description: string | undefined
  prompt: string | undefined
  childSessionId: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const progress = useChildProgress(childSessionId)
  const [expanded, setExpanded] = useState(false)
  const done = progress?.done === true
  const running = !done

  const openChild = () => {
    if (childSessionId === undefined) return
    // 跳转子会话详情：官方会话列表行（origin=subagent 不进侧栏任务列表，但
    // sessions.open 可寻址）——经官方 ctx.sessions 的 open 通道（window runtime
    // 未挂 sessions 时退化为无操作；跳转失败不阻塞卡片）。
    const bridge = (window as { __corumOpenSession?: (id: string) => void }).__corumOpenSession
    bridge?.(childSessionId)
  }

  // 展开态步骤清单：有 progress 时按 step 数推断「已完成 step-1 步 + 当前 step + 待执行」，
  // 无逐步明细数据时以 currentAction 作当前行、prompt 摘要作占位（语义对齐设计稿降级）。
  const stepRows = expanded && progress !== undefined
    ? [
      ...Array.from({ length: Math.max(0, progress.step - 1) }, (_, i) => ({
        key: `done-${i}`,
        icon: 'check' as const,
        text: t('subagent.step', { n: i + 1 }),
        done: true,
      })),
      ...(running
        ? [{
          key: 'current',
          icon: 'loader' as const,
          text: progress.currentAction ?? t('subagent.step', { n: progress.step }),
        }]
        : []),
    ]
    : []

  return (
    <div className={css.card}>
      <div className={css.head}>
        <span className={css.avatar}><Bot size={16} strokeWidth={2} className={css.avatarIcon} /></span>
        <span className={css.meta}>
          <span className={css.name}>{t('subagent.name')}</span>
          {description !== undefined && <span className={css.task}>{description}</span>}
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
        <>
          <div className={css.prog}>
            <div
              className={progress === undefined ? `${css.progBar} ${css.progBarIndeterminate}` : css.progBar}
              style={progress === undefined ? undefined : { width: `${Math.round(progressRatio(progress) * 100)}%` }}
            />
          </div>
          {!expanded && (
            <div className={css.stepRow}>
              <Loader size={15} strokeWidth={2} className={css.stepIcon} />
              <span className={css.stepText}>{runningStepText(progress, prompt, t)}</span>
            </div>
          )}
        </>
      )}
      {expanded && (
        <div className={css.stepList}>
          {stepRows.length === 0
            ? <StepListRow icon="circle" text={prompt ?? t('subagent.working')} dimmed />
            : stepRows.map(row => (
              <StepListRow key={row.key} icon={row.icon} text={row.text} done={'done' in row && row.done === true} />
            ))}
          {done && (
            <StepListRow icon="check" text={t('subagent.done')} done />
          )}
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
