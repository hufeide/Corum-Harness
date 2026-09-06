/**
 * ConfirmDialog —— 统一确认提示框（corum 各域「确认/取消」场景复用）。
 *
 * 两种形态：
 * - placement="center"：全屏遮罩 + 居中玻璃对话框（默认，适合打断性确认，如更换模型）。
 * - placement="inline"：内联气泡弹窗（适合就地二次确认，对应设计稿 DKRwC confirm-pop；
 *   调用方负责定位容器 position:relative）。
 *
 * 视觉 token 全部走设计变量，深浅主题随 body[data-ds-dark-theme] 自动翻转。
 * 自绘 14px 描边 × 图标（不引 lucide，保持本包零业务依赖）。
 * @module corum-ui-base/client/ConfirmDialog
 */
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './ConfirmDialog.module.css'

export interface ConfirmDialogProps {
  /** 标题（如「更换模型」「删除技能」）。 */
  title: string
  /** 主文案（确认问题）。 */
  message: ReactNode
  /** 警示补充（如「建议在新任务中更换模型」；可选）。 */
  warning?: ReactNode
  /** 内联错误信息（确认动作失败时展示；可选）。 */
  error?: string | null
  /** 主操作文案（默认「确认」）。 */
  confirmLabel?: ReactNode
  /** 次操作文案（默认「取消」）。 */
  cancelLabel?: ReactNode
  /** 主操作色调：danger=危险（删除等），primary=主操作（默认 danger）。 */
  tone?: 'danger' | 'primary'
  /** 形态：center=居中模态（默认） / inline=内联气泡。 */
  placement?: 'center' | 'inline'
  /** 主操作进行中（禁用按钮并显示 busy 文案）。 */
  busy?: boolean
  /** busy 时主操作文案（默认沿用 confirmLabel）。 */
  busyLabel?: ReactNode
  /** 主操作额外禁用条件。 */
  confirmDisabled?: boolean
  /**
   * 形态：confirm=双键确认（默认） / info=单键告知（替原生 alert，只有主操作键，
   * 点主键/遮罩/× 都走 onCancel 关闭）。
   */
  kind?: 'confirm' | 'info'
  /** 点主操作。kind=info 时可为空（仅关闭）。 */
  onConfirm?: () => void
  /** 点次操作 / 遮罩 / ×；kind=info 时主键也走这里关闭。 */
  onCancel: () => void
}

/** 14px 描边 ×（关闭）图标，stroke=currentColor。 */
function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M3 3L11 11M11 3L3 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function ConfirmDialog({
  title,
  message,
  warning,
  error,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'danger',
  placement = 'center',
  busy = false,
  busyLabel,
  confirmDisabled = false,
  kind = 'confirm',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmText = confirmLabel ?? (kind === 'info' ? '知道了' : '确认')
  const body = (
    <>
      <div className={css.title}>{title}</div>
      <div className={css.message}>{message}</div>
      {warning !== undefined && <div className={css.warning}>{warning}</div>}
      {error !== undefined && error !== null && error !== '' && <div className={css.warning}>{error}</div>}
      <div className={css.row}>
        {kind === 'confirm' && (
          <button type="button" className={css.cancelBtn} onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        )}
        <button
          type="button"
          className={tone === 'primary' ? css.confirmBtnPrimary : css.confirmBtnDanger}
          onClick={kind === 'info' ? onCancel : onConfirm}
          disabled={busy || confirmDisabled}
        >{busy ? (busyLabel ?? confirmText) : confirmText}</button>
      </div>
    </>
  )

  if (placement === 'inline') {
    return <div className={css.inlinePop}>{body}</div>
  }

  return createPortal(
    <div className={css.overlay} onClick={onCancel}>
      <div className={css.dialog} onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <button type="button" className={css.closeBtn} onClick={onCancel} aria-label="关闭"><IconClose /></button>
        {body}
      </div>
    </div>,
    document.body,
  )
}
