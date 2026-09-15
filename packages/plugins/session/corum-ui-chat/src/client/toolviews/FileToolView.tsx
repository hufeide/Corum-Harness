/**
 * fork（corum）：read / edit / write 三个 keyed toolview 的共享注册壳（2026-09-14）。
 *
 * 薄壳的职责只有一件事：把 chatRuntime 服务的 `openFileAtLine` 桥接成卡片 prop
 * （`openLineAt`），使卡片本体保持**纯组件**、不感知 cordis / 服务——与
 * SubagentCard 经 chatRuntimeRef 消费的同款模式
 * （同 bundle 模块级引用合法）。
 *
 * t 形参：框架按注册 locale 注入 PropsLocale<'chat'> 的窄化 TranslateNS；
 * 卡片内部只用 fileCard.* / editMiss.* 键，故这里以框架注入形直传（不重新声明）。
 */
import { memo, useCallback, type ComponentProps } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { chatRuntimeRef } from '../chat-runtime.ts'
import { FileToolCard } from './FileToolCard.tsx'

/** 卡片 props（含框架注入的 t）。 */
type CardProps = ComponentProps<typeof FileToolCard>

/**
 * 三个文件工具共用的 toolview（locale 由 slot 注册注入 t）。
 * 卡内按 props.toolName 分流，所以一个组件挂三个 key。
 */
export const FileToolView = memo(function FileToolView(props: ToolCallViewProps & Pick<CardProps, 't'>) {
  const openLineAt = useCallback<NonNullable<CardProps['openLineAt']>>((path, line) => {
    if (path === undefined) return
    void chatRuntimeRef.current?.openFileAtLine?.(path, line).then((result) => {
      if (result !== undefined && !result.ok) {
        console.warn('[ui-chat] fileCard openFileAtLine failed:', result.error, { path, line })
      }
    })
  }, [])
  return <FileToolCard {...props} openLineAt={openLineAt} />
})
