/**
 * Root-level host for the session-log **save result** modal.
 *
 * 2026-09-16（入口搬运）：用户定调把「保存到…」从会话头部右上角搬到**会话栏
 * 会话行右键菜单**。触发入口搬到了 `corum-ide-sidebar-ui`（它经 cordis 服务
 * `sessionArchive` 拿保存能力），而**结果反馈仍归本包**（弹窗文案/locale/状态机
 * 都在这里，避免把同一套 UI 复制到侧栏）。
 *
 * 为什么挂 `shell.overlay` 而不是继续跟触发它的组件同处：
 *   - 触发点现在是**侧栏的一行右键菜单**（选中即关菜单）。弹窗若随该行渲染，
 *     行一旦因列表刷新/折叠而卸载，弹窗会**跟着消失**（保存中闪退）。
 *   - `shell.overlay` 是 corum-ide-ui 声明、AppFrame 渲染的根级 frame 内浮层
 *     （`kind: 'list'` ⇒ 可多占用），生命周期与会话列表无关。
 *   - `Modal` 自身 `createPortal` 到 body，故浮层容器不会裁剪它。
 *
 * 会话 id 的来源：本槽是 **root 作用域**（没有 framework 注入的 sessionId），
 * 而控制器状态 `bySession` 本就按 sessionId 索引 ⇒ 从快照里挑出「当前该显示哪一条」
 * （见 {@link selectOpenSaveEntry} 的「最新优先 + 逐条消解」语义）。
 */
import { type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionArchiveState } from './controller.ts'
import { NS } from './locales.ts'
import { SessionArchiveSaveDialog } from './SaveDialog.tsx'
import { selectOpenSaveSessionId } from './save-dialog-select.ts'

/** Browser state + actions injected into the root-level save-dialog host. */
export interface SessionArchiveSaveDialogInjected {
  hooks: { sessionArchive: ObservableSnapshot<SessionArchiveState> }
  dismiss: (sessionId: SessionId) => void
}

/** Full component props for the root-level save-dialog host. */
export type SessionArchiveSaveDialogHostProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionArchiveSaveDialogInjected>

/**
 * Render the save result modal from the root-level overlay slot.
 * @param props - controller state snapshot, dismiss action, and localized copy.
 * @returns the modal, or null while no save dialog is open.
 */
export function SessionArchiveSaveDialogHost({
  useSessionArchive, dismiss, t,
}: SessionArchiveSaveDialogHostProps) {
  // 选取语义与「为什么只返回原始值」见 save-dialog-select.ts（纯逻辑，已单测）。
  const sessionId = useSessionArchive(selectOpenSaveSessionId)
  const entry = useSessionArchive(state =>
    sessionId === undefined ? undefined : state.bySession[sessionId])

  if (sessionId === undefined || entry?.open !== true) return null

  // store 的键是 String(sessionId)（见 controller 的 publishSave）；SessionId 是
  // branded 类型，回填时按本仓惯例断言（同 corum-ui-conversation apply.ts:398）。
  const id = sessionId as SessionId

  return (
    <SessionArchiveSaveDialog
      open
      status={entry.status}
      path={entry.path}
      error={entry.error}
      onClose={() => { dismiss(id) }}
      t={t}
    />
  )
}
