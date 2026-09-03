/**
 * SettingsSectionHost — 包装 section 组件为可注册的 React 组件。
 *
 * 接收 SettingsSectionOwnerProps（含 close），渲染 section 内容。
 * @module corum-ide-ui/client/settings/SettingsSectionHost
 */
import type { ReactNode } from 'react'
import type { SettingsSectionOwnerProps } from '../index.tsx'

interface SectionHostProps extends SettingsSectionOwnerProps {
  /** section 渲染函数。 */
  render: () => ReactNode
}

export function SettingsSectionHost({ render }: SectionHostProps) {
  return <>{render()}</>
}
