/**
 * fork（corum）：edit 工具 keyed toolview 的注册壳（2026-09-13）。
 *
 * 从 EditNotFoundCard 拆出的薄壳：把 chatRuntime 服务的 openFileAtLine 桥
 * 接成卡片 prop（卡片本体保持纯组件、不感知 cordis/服务——与 SubagentCard
 * 经 chatRuntimeRef 消费的同款模式，同 bundle 模块级引用合法）。
 *
 * t 形参：框架按注册 locale 注入 PropsLocale<'chat'> 的窄化 TranslateNS；
 * 卡片内部只用 editMiss.* 键，故这里以框架注入形直传（不重新声明）。
 */
import { memo, useCallback, type ComponentProps } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { chatRuntimeRef } from '../chat-runtime.ts'
import { EditNotFoundCard } from './EditNotFoundCard.tsx'

/** 卡片 props（含框架注入的 t）。 */
type CardProps = ComponentProps<typeof EditNotFoundCard>

/** edit 工具 toolview（locale 由 slot 注册注入 t）。 */
export const EditToolView = memo(function EditToolView(props: ToolCallViewProps & Pick<CardProps, 't'>) {
  const openLineAt = useCallback<NonNullable<CardProps['openLineAt']>>((path, line) => {
    if (path === undefined) return
    void chatRuntimeRef.current?.openFileAtLine?.(path, line).then((result) => {
      if (result !== undefined && !result.ok) {
        console.warn('[ui-chat] editMiss openFileAtLine failed:', result.error, { path, line })
      }
    })
  }, [])
  return <EditNotFoundCard {...props} openLineAt={openLineAt} />
})
