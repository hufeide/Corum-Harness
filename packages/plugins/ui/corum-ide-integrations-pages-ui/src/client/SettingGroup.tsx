/**
 * SettingGroup — 设置组卡片容器（1:1 复刻 design.pen group frame）。
 *
 * 设计稿 group frame：
 * - fill: $glass-1, cornerRadius: 16, stroke: $glass-border 1px
 * - layout: vertical, padding: [6,16,10,16]
 * - children: gt(标题) + rows + dividers
 *
 * PR6 起由本包自持一份副本（自 @corum/corum-ide-ui 的 settings/SettingGroup 迁入）：
 * 两个包是各自独立的 client bundle，不能跨包 import 组件与 CSS module。
 * @module corum-ide-integrations-pages-ui/client/SettingGroup
 */
import type { ReactNode } from 'react'
import css from './SettingGroup.module.css'

interface SettingGroupProps {
  /** 组标题（设计稿 gt: Inter 12px 600, label-secondary）。 */
  title: string
  /** 行内容（每行应使用 SettingRow 组件）。 */
  children: ReactNode
}

/**
 * Render a settings group card with title and rows.
 * @param props - title and children.
 * @returns the group card element.
 */
export function SettingGroup({ title, children }: SettingGroupProps) {
  return (
    <div className={css.group}>
      <div className={css.groupTitle}>{title}</div>
      {children}
    </div>
  )
}
