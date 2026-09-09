/**
 * fork（corum）：右侧「轨迹」区域的 occupant 组件（`corum.trajectory` 槽）。
 *
 * 2026-09-09 用户定调：抽屉形态（details）不好用 → 改为与编辑器/终端同构的**独立
 * 区域**，右上角轨迹按钮点亮（`layout.showRegion(['corum.trajectory'])`）。区域由壳
 * 声明（corum-ide-ui 的 SlotMap + 网格叶子），occupant 由本包注册（本包持有官方轨迹
 * 视图源码，故组件不经跨包内联、直接在自身 bundle 内渲染）。
 *
 * @module @corum/corum-ui-trajectory/TrajectoryRegion
 */
import type { ComponentProps, ReactNode } from 'react'
// Type-only: the 'corum.trajectory' SlotMap row + root slot declarations.
import type {} from '@corum/corum-ide-ui/client'
import type {
  InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MessageImageLoader } from '@corum/corum-ui-conversation/client'
import { TrajectoryView } from './TrajectoryView.tsx'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import css from './TrajectoryRegion.module.css'

/** 区域 occupant 的注入面（duration store 由插件 apply 建；轨迹源按会话解析）。 */
export interface TrajectoryRegionInjected {
  hooks: {
    /** 官方 `uiConversation.binding(sessionId).target('trajectory')` 快照源。 */
    trajectory: { getSnapshot: () => TrajectorySnapshot; subscribe: (listener: () => void) => () => void }
    /** 官方 duration store（「实际耗时 / 预估」切换）。 */
    duration: SnapshotStore<boolean>
  }
  loadOlder: () => Promise<boolean>
  loadImage: MessageImageLoader
  setActualDuration: (actualDuration: boolean) => void
}

/** 区域 occupant 的完整 props（壳声明槽 + 本包 inject 面 + 轨迹字典）。 */
export type TrajectoryRegionProps =
  PropsRuntime<'corum.trajectory'>
  & PropsRenderSlots<'conversation.trajectory.images'>
  & InjectFace<TrajectoryRegionInjected>
  & PropsLocale<'trajectory'>

/** 右侧轨迹区域：无当前会话时给空态，否则渲染官方轨迹视图。 */
export function TrajectoryRegion({
  sessionId, useSession, useProjection, useSessions,
  useTrajectory, useDuration, loadOlder, loadImage, setActualDuration, renderSlot, t,
}: TrajectoryRegionProps): ReactNode {
  if (sessionId === undefined) {
    return <div className={css.empty}>{t('region.empty')}</div>
  }
  // 官方 TrajectoryView 的 props 面（ConvViewProps & PropsRenderSlots & InjectFace
  // & PropsLocale）：区域槽能提供的逐项装配；viewRequest/completeViewRequest 属
  // conversation.view 的 focus/inspect 面，区域形态没有对应入参 → undefined。
  // 断言收窄的理由：官方组件的 props 交叉类型包含 conversation.view 的 owner 面，
  // 与本区域的 owner 面不同源（红线 3：跨包类型用本地装配面收窄，不反向改官方）。
  const viewProps = {
    sessionId, useSession, useProjection, useSessions,
    useTrajectory, useDuration, loadOlder, loadImage, setActualDuration,
    renderSlot, t, viewRequest: undefined, completeViewRequest: undefined,
  } as unknown as ComponentProps<typeof TrajectoryView>
  return (
    <div className={css.region}>
      <TrajectoryView {...viewProps} />
    </div>
  )
}
