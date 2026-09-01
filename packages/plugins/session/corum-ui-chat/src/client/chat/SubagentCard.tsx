// fork（corum）：子 Agent 进度卡——主 Agent 召唤子 Agent（delegation）时在消息瀑布
// 中流出的玻璃卡。avatar(bot) + 任务描述 + run-chip（Running/已完成）+ 进度条 +
// Step n · currentAction 实时行。进度由 renderer 侧轮询子会话事件窗注入
// （corumAgent/getChildSessionProgress），无 progress 时降级为「运行中 + prompt 摘要」。
import { memo, useEffect, useState } from 'react'
import { Bot, Check, Loader } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { SubagentProgressSnapshot } from '../contract/subagent.ts'
import css from './SubagentCard.module.css'

/** 跨 bundle 会话/RPC 句柄（apply.ts 在 conversation.view 挂载时写入）。 */
interface CorumChatRuntime {
  sessionId: string | undefined
  connection: { rpc: { call: (channel: string, endpoint: string, payload: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> } } | undefined
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
      const runtime = (window as { __corumChatRuntime?: CorumChatRuntime }).__corumChatRuntime
      const connection = runtime?.connection
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
  // step 0 也给 10% 起步（视觉反馈「已启动」），每步 +18% 渐近 90%。
  return Math.min(0.1 + progress.step * 0.18, 0.9)
}

/** 运行中的 step 行文案：「Step n · action」/「Step n」/ prompt 摘要 / 默认 working。 */
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
  description, prompt, childSessionId, t,
}: {
  description: string | undefined
  prompt: string | undefined
  childSessionId: string | undefined
  t: ChatNodeViewProps<'subagent-call'>['t']
}) {
  const progress = useChildProgress(childSessionId)
  const done = progress?.done === true
  const running = !done
  return (
    <div className={css.card}>
      <div className={css.head}>
        <span className={css.avatar}><Bot size={12} strokeWidth={2} className={css.avatarIcon} /></span>
        <span className={css.meta}>
          <span className={css.name}>{t('subagent.name')}</span>
          {description !== undefined && <span className={css.task}>{description}</span>}
        </span>
        <span className={running ? css.runChip : css.doneChip}>
          {running
            ? <><span className={css.runDot} />{t('subagent.running')}</>
            : <><Check size={12} strokeWidth={2.5} />{t('subagent.done')}</>}
        </span>
      </div>
      {running && (
        <>
          <div className={css.prog}>
            <div
              className={progress === undefined ? `${css.progBar} ${css.progBarIndeterminate}` : css.progBar}
              style={progress === undefined ? undefined : { width: `${Math.round(progressRatio(progress) * 100)}%` }}
            />
          </div>
          <div className={css.stepRow}>
            <Loader size={13} strokeWidth={2} className={css.stepIcon} />
            <span className={css.stepText}>{runningStepText(progress, prompt, t)}</span>
          </div>
        </>
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
