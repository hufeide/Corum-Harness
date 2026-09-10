// fork（corum）：orchestrate 编排卡——主 Agent 调 `orchestrate` fan-out 多个子
// Agent 时，在消息瀑布中流出的**流程图卡**（设计稿 `orchestrate-flow-card`，fNng3）。
//
// 对齐设计稿结构：
//   head  = avatar(layers) + meta(标题「编排工作流 · N 任务并行」/ 副标题
//           「fan-out 并发 → fan-in 汇合」) + 状态 chip(计数) + 折叠按钮
//   flow  = 起始节点 → 虚线主干 → 汇合节点 → 逐分支(横线 + 节点 + 分支卡) →
//           集成者卡（声明了 merge 时）
//   分支卡 = label / 副行(isolation · worktree 或 research · 只读) + 状态 chip + goto
//
// 状态色（设计稿两态实测）：
//   running #FFB45C（warn）· done #3EE6B0（success）· failed #FF5C7A（error）
//   集成：integrated=done 色「已集成」/ pending=dim「未启动」。
//
// 数据源 = 本卡自己的 node data（orchestrate.ts 从 tool/call arguments + 结果正文
// 折叠），无新宿主通路。子会话跳转复用 subagent 卡同一套 runtime 桥。
import { memo, useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronUp, GitMerge, Layers, Loader, X } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { OrchestrateChatData, OrchestrateTask } from '../contract/orchestrate.ts'
import { summarize } from '../contract/orchestrate.ts'
import { chatRuntimeRef, subagentChildSubscribe, subagentChildOf, worktreeLedgerSubscribe } from '../chat-runtime.ts'
import css from './OrchestrateCard.module.css'

/** 一条分支的渲染态。 */
type BranchState = 'running' | 'done' | 'failed'

/** 分支状态派生：工具未返回=运行中；有终态=按终态。 */
function branchState(data: OrchestrateChatData, index: number): BranchState {
  const outcome = data.outcomes.get(index)
  if (outcome === undefined) return data.settled ? 'failed' : 'running'
  return outcome.kind === 'done' ? 'done' : 'failed'
}

/** 分支副行文案（设计稿 sub：`worktree · wt-1b3dcf` / `research · 只读`）。 */
function branchSubtitle(task: OrchestrateTask): string {
  if (task.research === true) return 'research · 只读'
  if (task.isolation === 'always') return 'worktree · 隔离运行'
  if (task.isolation === 'write-tasks') return '并发写时隔离'
  if (task.background === true) return 'background · 后台'
  return 'foreground · 父树直跑'
}

/** 状态 chip 文案 + 语义色键。 */
function chipOf(state: BranchState): { text: string; tone: 'running' | 'done' | 'failed' } {
  if (state === 'done') return { text: '已完成', tone: 'done' }
  if (state === 'failed') return { text: '失败', tone: 'failed' }
  return { text: '运行中', tone: 'running' }
}

/** 子会话跳转：宿主 spawn 广播（'corum/subagent/child'）给出的精确 id。 */
function useChildOf(callId: string): string | undefined {
  const [child, setChild] = useState<string | undefined>(() => subagentChildOf(callId)?.childSessionId)
  useEffect(() => {
    setChild(subagentChildOf(callId)?.childSessionId)
    const sub = subagentChildSubscribe((frame) => {
      if (frame.callId !== callId) return
      setChild(frame.childSessionId)
    })
    return () => { sub.unsubscribe() }
  }, [callId])
  return child
}

/**
 * 编排卡组件。
 * @param props - 槽运行时 share（node.data = 本卡的折叠结果）与 i18n。
 * @returns 设计稿 orchestrate-flow-card 的渲染。
 */
function OrchestrateCardImpl({ node }: ChatNodeViewProps<'orchestrate-call'>) {
  const data = node.data
  const [expanded, setExpanded] = useState(true)
  const child = useChildOf(data.callId)
  const summary = summarize(data)
  // 整体状态：有失败=failed；全部有终态且无失败=done；否则 running。
  const failed = summary.failed > 0 || (data.errored && !data.settled)
  const allDone = data.settled && summary.failed === 0 && summary.done === summary.total && summary.total > 0
  const overall: 'running' | 'done' | 'failed' = failed ? 'failed' : allDone ? 'done' : 'running'
  const overallText = overall === 'done'
    ? `${summary.done}/${summary.total} 完成`
    : overall === 'failed'
      ? `${summary.done}/${summary.total} · ${summary.failed} 失败`
      : `并行执行中 · ${summary.done}/${summary.total}`

  return (
    <div className={css.card} data-state={overall} data-errored={data.errored || undefined}>
      <div className={css.head}>
        <span className={css.avatar}><Layers size={14} className={css.avatarIcon} /></span>
        <span className={css.meta}>
          <span className={css.name}>{summary.title}</span>
          <span className={css.subtitle}>{summary.subtitle}</span>
        </span>
        <span className={css.chip} data-tone={overall}>
          {overall === 'running'
            ? <Loader size={11} className={css.chipSpin} />
            : overall === 'done' ? <Check size={11} /> : <X size={11} />}
          <span className={css.chipText}>{overallText}</span>
        </span>
        <button
          type="button"
          className={css.actBtn}
          aria-expanded={expanded}
          aria-label={expanded ? '收起编排详情' : '展开编排详情'}
          onClick={() => { setExpanded(open => !open) }}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {expanded && (
        <div className={css.flow}>
          {/* 起始节点（设计稿 node-start：双环 + 实心点）。 */}
          <div className={css.rail}>
            <span className={css.startNode}><span className={css.startDot} /></span>
            <span className={css.trunk} />
          </div>
          <div className={css.branches}>
            {data.tasks.length === 0 && (
              <div className={css.branchRow}>
                <span className={css.branchLine} data-tone="running" />
                <span className={css.branchNode} data-tone="running"><Loader size={9} /></span>
                <div className={css.branchCard}>
                  <span className={css.branchTx}>
                    <span className={css.branchLabel}>{data.scriptName ?? '脚本编排'}</span>
                    <span className={css.branchSub}>scripted · 逐阶段推进</span>
                  </span>
                </div>
              </div>
            )}
            {data.tasks.map(task => {
              const state = branchState(data, task.index)
              const chip = chipOf(state)
              return (
                <div key={task.index} className={css.branchRow} data-state={state}>
                  <span className={css.branchLine} data-tone={chip.tone} />
                  <span className={css.branchNode} data-tone={chip.tone}>
                    {state === 'done' ? <Check size={9} /> : state === 'failed' ? <X size={9} /> : <Loader size={9} />}
                  </span>
                  <div className={css.branchCard}>
                    <span className={css.branchTx}>
                      <span className={css.branchLabel}>{task.label}</span>
                      <span className={css.branchSub}>{branchSubtitle(task)}</span>
                    </span>
                    <span className={css.branchChip} data-tone={chip.tone}>{chip.text}</span>
                    {child !== undefined && (
                      <button
                        type="button"
                        className={css.gotoBtn}
                        aria-label={`进入子会话 ${task.label}`}
                        title={`进入子会话 ${child}`}
                        onClick={() => { chatRuntimeRef.current?.openSession?.(child) }}
                      >
                        <ArrowRight size={14} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            {data.hasMerge && (
              <div className={css.branchRow} data-state={data.integration?.kind === 'integrated' ? 'done' : 'idle'}>
                <span className={css.branchLine} data-tone={data.integration?.kind === 'integrated' ? 'done' : 'idle'} />
                <span className={css.branchNode} data-tone={data.integration?.kind === 'integrated' ? 'done' : 'idle'}>
                  <GitMerge size={9} />
                </span>
                <div className={css.branchCard} data-integrator>
                  <span className={css.branchTx}>
                    <span className={css.branchLabel}>集成者 · 合并 + 验证 + 提交</span>
                    <span className={css.branchSub}>
                      {data.integration === undefined
                        ? '全部并行任务完成后 · 串行启动'
                        : data.integration.kind === 'integrated'
                          ? '已串行完成合并与提交'
                          : data.integration.reason}
                    </span>
                  </span>
                  <span className={css.branchChip} data-tone={data.integration?.kind === 'integrated' ? 'done' : 'idle'}>
                    {data.integration?.kind === 'integrated' ? '已集成' : '未启动'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export const OrchestrateCard = memo(OrchestrateCardImpl)
