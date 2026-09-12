// fork（corum）：子 Agent 卡展开区的紧凑计划段（任务列表投影）。
// 子会话没有自己的 dock，只在父侧 SubagentCard 的展开区里内联渲染一份
// 紧凑摘要：`N 项` 标题 + 每项状态图标 + 文案，当前 in_progress 项高亮。
// 无计划时不渲染（不占空块）。
import { memo } from 'react'
import { Check, Circle, CircleDot, ListTodo } from 'lucide-react'
import type { SubagentTodoItem } from '@corum/corum-api-remotes/corum-events'
import css from './SubagentPlan.module.css'

/** 计划项状态 → 图标 + 行样式。 */
function itemTone(status: SubagentTodoItem['status']): 'pending' | 'active' | 'done' {
  switch (status) {
    case 'completed': return 'done'
    case 'in_progress': return 'active'
    default: return 'pending'
  }
}

/** 子 Agent 的紧凑计划段（展开区内联，无计划时返回 null）。 */
export const SubagentPlan = memo(function SubagentPlan({ todos }: { todos: readonly SubagentTodoItem[] }) {
  if (todos.length === 0) return null
  return (
    <div className={css.plan}>
      <div className={css.planHead}>
        <ListTodo size={14} strokeWidth={2} className={css.planIcon} />
        <span className={css.planTitle}>{todos.length} 项</span>
      </div>
      <ul className={css.planList}>
        {todos.map((item, i) => {
          const tone = itemTone(item.status)
          return (
            <li key={i} className={css.planItem} data-tone={tone}>
              {tone === 'done'
                ? <Check size={13} strokeWidth={2.5} className={css.itemIcon} />
                : tone === 'active'
                  ? <CircleDot size={13} strokeWidth={2} className={css.itemIconActive} />
                  : <Circle size={13} strokeWidth={2} className={css.itemIcon} />}
              <span className={tone === 'active' ? css.itemTextActive : css.itemText}>{item.content}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
})
