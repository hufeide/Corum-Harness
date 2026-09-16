import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionArchiveSaveStatus } from './controller.ts'
import { NS } from './locales.ts'

/**
 * Presentational props for the session-log save result modal.
 *
 * 2026-09-16（入口搬运）：本组件从「槽组件」改为**纯展示组件**——触发点已搬到
 * 会话栏行右键菜单（corum-ide-sidebar-ui），而结果反馈改由根级 `shell.overlay`
 * 的宿主（SaveDialogHost.tsx）按控制器状态渲染。展示与接线分离后，弹窗文案/locale
 * 只有这一份，宿主只负责「从 root 作用域反查是哪个会话」。
 */
export interface SessionArchiveSaveDialogProps {
  /** Whether the modal is showing. */
  open: boolean
  /** Current save phase. */
  status: SessionArchiveSaveStatus | undefined
  /** Saved path (success phase). */
  path: string | null | undefined
  /** Failure message (error phase). */
  error: string | null | undefined
  /** Close the modal. */
  onClose: () => void
}

/**
 * Modal reporting the native save-dialog outcome for one Session. A cancelled
 * native dialog never opens this modal (the controller resolves silently).
 * @param props - open flag, save phase, path/error, close action, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionArchiveSaveDialog({
  open, status, path, error, onClose, t,
}: SessionArchiveSaveDialogProps & PropsLocale<typeof NS>) {
  const title = status === 'saving'
    ? t('dialog.savingTitle')
    : status === 'success' ? t('dialog.successTitle') : t('dialog.errorTitle')
  const description = status === 'saving'
    ? t('dialog.savingDescription')
    : status === 'success'
      ? `${t('dialog.savedTo')} ${path ?? ''}`
      : (status === 'error' ? error || t('dialog.saveFailed') : t('dialog.saveFailed'))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      closeLabel={t('dialog.close')}
      footer={<Button variant="primary" onClick={onClose}>{t('dialog.close')}</Button>}
    />
  )
}
