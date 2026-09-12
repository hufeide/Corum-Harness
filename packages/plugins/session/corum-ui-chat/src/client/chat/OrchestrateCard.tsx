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
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Check, ChevronDown, ChevronUp, Cpu, GitMerge, Layers, Loader, X } from 'lucide-react'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { OrchestrateChatData, OrchestrateTask } from '../contract/orchestrate.ts'
import { summarize } from '../contract/orchestrate.ts'
import { chatRuntimeRef, subagentChildOf, subagentChildSubscribe, subagentChildrenOf, worktreeLedgerSubscribe } from '../chat-runtime.ts'
import { useChildProgress } from './SubagentCard.tsx'
import css from './OrchestrateCard.module.css'

/** 一条分支的渲染态。 */
type BranchState = 'running' | 'done' | 'failed'

/**
 * 分支状态派生：**终态优先，实时进度兜底**。
 *
 * 工具结果（`data.outcomes`）是整批返回的，所以在并行执行过程中它是空的；旧实现据此
 * 把每个分支恒判为「运行中」，导致**某个分支自己跑完了卡片仍显示运行中，要等整批 settle
 * 才一起翻**（2026-09-12 用户实测）。现在用「该分支自己的子会话实时进度」兜底：
 * 子会话 done ⇔ 该分支已完成，逐条翻，互不牵连。
 * @param data - 本卡的折叠数据（含终态 outcomes 与 settled 位）。
 * @param index - 分支序号。
 * @param childDone - 该分支子会话的实时进度是否已结束（进度未知时 undefined）。
 * @returns 分支渲染态。
 */
function branchState(data: OrchestrateChatData, index: number, childDone?: boolean): BranchState {
  const outcome = data.outcomes.get(index)
  if (outcome !== undefined) return outcome.kind === 'done' ? 'done' : 'failed'
  // 未 settle：子会话已结束就是已完成（不再等整批）；settle 却无 outcome 仍按失败。
  if (data.settled) return childDone === true ? 'done' : 'failed'
  return childDone === true ? 'done' : 'running'
}

/** 分支副行文案（设计稿 sub：`worktree · wt-1b3dcf` / `research · 只读`）。
 *  隔离任务的 worktree 名来自台账（宿主 emit 的 `slug`，实测形如 `wt-062c9d`）；
 *  台账未到达（页面刷新后无回放帧）时降级为「worktree · 隔离运行」。 */
function branchSubtitle(
  task: OrchestrateTask,
  worktrees: readonly { readonly slug: string; readonly branch: string }[],
  slugFallback: string | undefined,
): string {
  if (task.research === true) return 'research · 只读'
  if (task.isolation === 'always') {
    // ① 实时台账（推送帧，按 spawn 顺序对齐）→ ② 结果正文里的 slug（刷新后耐久兜底）
    // → ③ 泛化文案。三层都取不到时说明该任务确实没隔离成功。
    const entry = worktrees[task.index]
    const slug = entry?.slug ?? slugFallback
    return slug === undefined ? 'worktree · 隔离运行' : `worktree · ${slug}`
  }
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

/** 子会话跳转：宿主 spawn 广播（'corum/subagent/child'）给出的精确 id。
 *
 * ⚠️ orchestrate 的 N 个任务**共享父侧同一个 callId**（宿主对每个任务都用
 * `exec.callId` 广播，只有 label 不同），故必须按 `(callId, label)` 取——旧实现
 * 按 callId 存单条，后到任务覆盖先到的，卡片上只有一个/零个 goto 按钮。
 * label 对不上时按 spawn 顺序回退（宿主广播顺序 ≈ `tasks[]` 顺序）。
 */
function useChildOfTask(
  callId: string,
  label: string,
  index: number,
  fallbackId: string | undefined,
): string | undefined {
  const resolve = (): string | undefined => {
    const all = subagentChildrenOf(callId)
    // ① label 精确（同 callId 多任务的正解）
    const byLabel = all.find(entry => entry.label === label)
    if (byLabel !== undefined) return byLabel.childSessionId
    // ② spawn 顺序对齐（宿主按 tasks[] 顺序 spawn，故下标可用）
    if (all[index] !== undefined) return all[index].childSessionId
    // ③ fold 侧的历史兜底（页面刷新后无广播帧；来自 session/list 时间就近）
    return fallbackId ?? subagentChildOf(callId)?.childSessionId
  }
  const [child, setChild] = useState<string | undefined>(resolve)
  useEffect(() => {
    setChild(resolve())
    const sub = subagentChildSubscribe((frame) => {
      if (frame.callId !== callId) return
      setChild(resolve())
    })
    return () => { sub.unsubscribe() }
  }, [callId, label, index, fallbackId])
  return child
}

/** 会话 id 的取用（本卡所在会话；供隔离台账按父会话过滤）。uSES 源契约。 */
function useCurrentSessionId(): string | undefined {
  const source = useMemo(() => chatRuntimeRef.current?.sessionIdSnapshot(), [])
  const [id, setId] = useState<string | undefined>(() => source?.getSnapshot())
  useEffect(() => {
    if (source === undefined) return undefined
    setId(source.getSnapshot())
    return source.subscribe(() => { setId(source.getSnapshot()) })
  }, [source])
  return id
}

/**
 * 隔离 worktree 台账（设计稿分支副行的 `worktree · wt-xxxxxx`）。
 *
 * 数据源 = 'corum/worktree-ledger' 推送帧（宿主 fork #10 发射，按父 sessionId 过滤）。
 * ⚠️ 与 SubagentCard 的「并行工作区」chip 同源——那个 chip 的**渲染**在 commit
 * c0e69443（P8 按次成节点）被删掉后成了孤儿（组件还在、没人 render），用户反馈
 * 「隔离分支之前有显示、现在不显示」即此。本卡把 worktree 名放回分支副行。
 * @returns 当前会话的台账条目（无台账时为空数组）。
 */
function useWorktreeLedger(): readonly { readonly slug: string; readonly branch: string; readonly status: string }[] {
  const sessionId = useCurrentSessionId()
  const [entries, setEntries] = useState<readonly { slug: string; branch: string; status: string }[]>([])
  useEffect(() => {
    if (sessionId === undefined) return undefined
    const sub = worktreeLedgerSubscribe((frame) => {
      if (frame.sessionId !== sessionId) return
      setEntries(frame.entries)
    })
    return () => { sub.unsubscribe() }
  }, [sessionId])
  return entries
}

/**
 * 子会话模型显示（读官方 session/list 行的 `modelSelection` 投影，与 SubagentCard 同源）。
 *
 * 任务级 `model` 声明优先（机制锁定，见 contract/orchestrate.ts）；没声明时子 Agent
 * 跟随实例/全局默认，只有子会话自己的投影知道最终用了哪个模型。
 * @param childSessionId - 子会话 id（未关联时 undefined）。
 * @returns 形如 `deepseek-v4-pro · high`；取不到时 undefined。
 */
function useChildModel(childSessionId: string | undefined): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (childSessionId === undefined) { setLabel(undefined); return undefined }
    let cancelled = false
    void (async () => {
      const conn = chatRuntimeRef.current?.connection
      if (conn === undefined) return
      try {
        const result = await conn.rpc.call('/api', 'session/list', { args: { _request: { limit: 200 } } })
        if (cancelled || !result.ok || result.value === undefined) return
        const value = result.value as {
          items?: ReadonlyArray<{
            sessionId?: string
            projections?: { values?: { modelSelection?: { lastUsed?: { model?: string; reasoningEffort?: string } } } }
          }>
        }
        const row = value.items?.find(item => item.sessionId === childSessionId)
        const last = row?.projections?.values?.modelSelection?.lastUsed
        if (last?.model === undefined) return
        setLabel([last.model, last.reasoningEffort].filter(part => part !== undefined && part !== '').join(' · '))
      } catch {
        // 拉取失败留空（模型行不渲染）。
      }
    })()
    return () => { cancelled = true }
  }, [childSessionId])
  return label
}

/**
 * 一条并行分支（设计稿 brX 三件套：横线 + 状态节点 + 分支卡）。
 *
 * 独立成组件而非内联 map：每条分支要用**自己的** hook 取子会话 id 与模型
 * （React 不允许在循环里调 hook）。
 * @param props - 父 callId、任务声明、派生状态。
 */
function BranchRow({ callId, task, outcomeState, onLiveDone, worktrees, fallbackChildId, slugFallback }: {
  callId: string
  task: OrchestrateTask
  /** 由工具终态派生的状态（未 settle 时多为 running）。 */
  outcomeState: BranchState
  /** 该分支的子会话刚跑完时上报一次（供卡头计数同步，见 OrchestrateCardImpl）。 */
  onLiveDone: (index: number) => void
  worktrees: readonly { readonly slug: string; readonly branch: string; readonly status: string }[]
  fallbackChildId: string | undefined
  slugFallback: string | undefined
}) {
  const child = useChildOfTask(callId, task.label, task.index, fallbackChildId)
  /**
   * **逐分支实时状态**（2026-09-12 用户实测缺陷修复）：工具结果整批返回，运行中它是空的，
   * 旧实现于是把每条分支恒判为「运行中」，某个分支自己跑完也不翻，必须等全部完成才一起翻。
   * 这里用该分支**自己子会话**的进度兜底：on done 立即升级为 done（终态=failed 时不覆盖）。
   */
  const live = useChildProgress(child)
  const state: BranchState = outcomeState === 'running' && live?.done === true ? 'done' : outcomeState
  useEffect(() => { if (live?.done === true) onLiveDone(task.index) }, [live?.done, onLiveDone, task.index])
  const chip = chipOf(state)
  // 模型：优先任务级声明（`tasks[i].model`），否则读子会话的 modelSelection 投影
  // （与 SubagentCard 同源——机制锁定的模型只有子会话自己知道）。
  const childModel = useChildModel(child)
  const model = task.model ?? childModel
  return (
    <div className={css.branchRow} data-state={state}>
      <span className={css.branchLine} data-tone={chip.tone} />
      <span className={css.branchNode} data-tone={chip.tone}>
        {state === 'done' ? <Check size={9} /> : state === 'failed' ? <X size={9} /> : <Loader size={9} />}
      </span>
      <div className={css.branchCard}>
        <span className={css.branchTx}>
          <span className={css.branchLabel}>{task.label}</span>
          <span className={css.branchSub}>{branchSubtitle(task, worktrees, slugFallback)}</span>
          {model !== undefined && (
            <span className={css.branchModel}>
              <Cpu size={11} strokeWidth={2} />
              <span className={css.branchModelText}>{model}</span>
            </span>
          )}
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
}

/**
 * 编排卡组件。
 * @param props - 槽运行时 share（node.data = 本卡的折叠结果）与 i18n。
 * @returns 设计稿 orchestrate-flow-card 的渲染。
 */
function OrchestrateCardImpl({ node }: ChatNodeViewProps<'orchestrate-call'>) {
  const data = node.data
  const [expanded, setExpanded] = useState(true)
  // 隔离台账（分支 chip 显示 worktree 名；恢复被 c0e69443 孤立的可见性）。
  const worktrees = useWorktreeLedger()
  const summary = summarize(data)
  /**
   * 逐分支实时已完成集合（子 BranchRow 上报）。工具结果是整批返回的，只用
   * `summary.done` 会让卡头计数在整批 settle 前一直停在 0/N，与分支 chip 不一致。
   */
  const [liveDone, setLiveDone] = useState<ReadonlySet<number>>(() => new Set())
  const markLiveDone = useCallback((index: number): void => {
    setLiveDone(prev => prev.has(index) ? prev : new Set(prev).add(index))
  }, [])
  const doneCount = Math.max(summary.done, Math.min(liveDone.size, summary.total))
  // 整体状态：有失败=failed；全部有终态且无失败=done；否则 running。
  const failed = summary.failed > 0 || (data.errored && !data.settled)
  const allDone = summary.failed === 0 && summary.total > 0 && doneCount === summary.total
  const overall: 'running' | 'done' | 'failed' = failed ? 'failed' : allDone ? 'done' : 'running'
  const overallText = overall === 'done'
    ? `${doneCount}/${summary.total} 完成`
    : overall === 'failed'
      ? `${doneCount}/${summary.total} · ${summary.failed} 失败`
      : `并行执行中 · ${doneCount}/${summary.total}`

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
            {data.tasks.map(task => (
              <BranchRow
                key={task.index}
                callId={data.callId}
                task={task}
                outcomeState={branchState(data, task.index)}
                onLiveDone={markLiveDone}
                worktrees={worktrees}
                fallbackChildId={data.childSessionIds?.[task.index]}
                slugFallback={data.worktreeSlugs?.get(task.index)}
              />
            ))}
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
