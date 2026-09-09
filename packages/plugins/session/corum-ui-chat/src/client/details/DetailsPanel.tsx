import { Fragment } from 'react'
import type { ComponentProps } from 'react'
import { CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import { shallowEqual } from '@deepseek-ai/dsh-client-store'
// fork（corum）：轨迹视图（fork #12 包）——组件值 import 内联进本 bundle（组件
// 无模块级可变状态、只读 props，安全）；抽屉视图状态由壳经 inject 下发。
import { TrajectoryView } from '@corum/corum-ui-trajectory/view'
import type { DetailsSlotProps } from '../contract/slots.ts'
import type { ChatSnapshot, RunningToolCall, ToolCallBlock, ToolResultNode } from '../contract/snapshot.ts'
import { findToolCall } from './tool-node-reader.ts'
import css from './DetailsPanel.module.css'

export type DetailsPanelProps = DetailsSlotProps

/** The snapshot-owned block reference must remain stable across unrelated frames. */
interface CallMaterial {
  name: string
  argsRaw: string | null
  block: ToolCallBlock
}

function settledMaterial(node: ToolResultNode, callId: string): CallMaterial {
  return { name: node.call?.name ?? callId, argsRaw: node.call?.argsRaw ?? null, block: node }
}

function runningMaterial(call: RunningToolCall): CallMaterial {
  return { name: call.name, argsRaw: call.argsRaw, block: call }
}

function materialFor(s: ChatSnapshot, callId: string): CallMaterial | null {
  const found = findToolCall(s, callId)
  if (found === undefined) return null
  return 'kind' in found ? settledMaterial(found, callId) : runningMaterial(found)
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** Flatten a settled result for the no-ui-tool fallback. */
function rawResultText(block: ToolCallBlock): string {
  if (!('kind' in block)) return ''
  const parts = block.content.map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
  if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
  return parts.join('\n')
}

export function DetailsPanel({
  useChat, useSessions, sessionId, useStore, renderSlot, closeDetails, t,
  useSession, useProjection, useTrajectory, useDuration, useDetailsView,
  loadOlder, loadImage, setActualDuration, trajectoryT, showTool, showTrajectory,
}: DetailsPanelProps) {
  const selection = useStore(s => s.selection)
  // Session workspace root: a card model resolves omitted or relative
  // tool paths against it without reading Session services.
  const sessionCwd = useSessions(list => list.byId[sessionId]?.cwd)
  const callId = selection?.callId
  // materialFor builds a fresh wrapper; shallowEqual short-circuits on its
  // stable members (result node reference rides the snapshot's structural sharing).
  const material = useChat(
    s => (callId === undefined ? null : materialFor(s, callId)),
    (a, b) => shallowEqual(a, b))
  // fork（corum）：工具详情 ⟷ 轨迹视图（fork #12）。视图状态归壳
  // （ctx.trajectoryDetails），经 details 槽 inject 的 hooks.detailsView 绑定成
  // useDetailsView 选择器；两个切换动作同 inject 面下发。
  const detailsView = useDetailsView(v => v)
  // 官方 TrajectoryView 的 props 面（ConvViewProps & PropsRenderSlots & InjectFace
  // & PropsLocale）：details 槽能提供的部分逐项装配；viewRequest/completeViewRequest
  // 属对话区 view 的 focus/inspect 面，抽屉形态没有对应入参，传 undefined。
  // 断言收窄的原因：官方组件的 props 交叉类型包含 conversation.view 的 owner 面，
  // 与 details 槽的 owner 面不同源（红线 3：跨包类型用本地装配面收窄，不反向改官方）。
  const trajectoryViewProps = {
    sessionId, useSession, useProjection, useSessions,
    useTrajectory, useDuration, loadOlder, loadImage, setActualDuration,
    renderSlot, t: trajectoryT,
    viewRequest: undefined, completeViewRequest: undefined,
  } as unknown as ComponentProps<typeof TrajectoryView>
  return (
    <div className={css.root}>
      <div className={css.header}>
        {/* fork（corum）：视图切换（工具详情 ⟷ 轨迹，fork #12）。轨迹态由右上角
            轨迹按钮经 trajectoryDetails.openTrajectory() 进入，此处也可手动切回。 */}
        <div className={css.tabs} role="tablist">
          <button
            type="button" role="tab" className={css.tab}
            data-active={detailsView === 'tool' || undefined}
            aria-selected={detailsView === 'tool'}
            onClick={() => { showTool() }}
          >
            {t('details.tabTool')}
          </button>
          <button
            type="button" role="tab" className={css.tab}
            data-active={detailsView === 'trajectory' || undefined}
            aria-selected={detailsView === 'trajectory'}
            onClick={() => { showTrajectory() }}
          >
            {t('details.tabTrajectory')}
          </button>
        </div>
        <div className={css.title}>
          {detailsView === 'trajectory'
            ? t('details.tabTrajectory')
            : selection === null
              ? t('details.title')
              : material?.name ?? selection.toolName ?? t('details.title')}
        </div>
        <button
          type="button" className={css.close} aria-label={t('details.close')}
          onClick={() => { closeDetails() }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={css.body} data-view={detailsView}>
        {detailsView === 'trajectory'
          ? <TrajectoryView {...trajectoryViewProps} />
          : selection === null || callId === undefined
            ? <div className={css.empty}>{t('details.empty')}</div>
            : material === null
              ? <div className={css.empty}>{t('details.notInWindow')}</div>
              : (
                <>
                  {material.argsRaw !== null && (
                    <section className={css.section}>
                      <div className={css.sectionLabel}>{t('details.input')}</div>
                      <CodeBlock code={pretty(material.argsRaw)} lang="json" copyLabel={t('copy')} copiedLabel={t('copied')} />
                    </section>
                  )}
                  <section className={css.section}>
                    <div className={css.sectionLabel}>{t('details.output')}</div>
                    {/* Keyed by the selected call: the body owns per-call view
                        state (the terminal card's expand and copy), which React
                        would otherwise carry into the next selection because the
                        panel does not unmount between calls. */}
                    <Fragment key={callId}>
                      {renderSlot('conversation.details.tool', { block: material.block, cwd: sessionCwd }, {
                        fallback: 'kind' in material.block
                          ? (
                            <pre className={css.code} data-error={material.block.isError || undefined}>
                              {rawResultText(material.block)}
                            </pre>
                          )
                          : <div className={css.empty}>{t('details.running')}</div>,
                      })}
                    </Fragment>
                  </section>
                </>
              )}
      </div>
    </div>
  )
}
