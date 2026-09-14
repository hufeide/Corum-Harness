import type { ReactNode } from 'react'
import { IconDownloadOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionArchiveSaveDialog, type SessionArchiveSaveDialogProps } from './SaveDialog.tsx'
import css from './HeaderAction.module.css'

/**
 * Render the Session Header "save log to…" capsule and its shared result dialog.
 * （2026-09-14 P0-2 恢复：仅「保存到…」。删除按钮不恢复——733d3b70 定调移除
 * 不可逆入口的裁决对「删除会话」仍然成立。）
 * @param props - Session runtime, save controller, and localized dialog copy.
 * @returns the persistent Header action and Session-scoped dialog.
 */
export function SessionArchiveHeaderAction(props: SessionArchiveSaveDialogProps): ReactNode {
  const { sessionId, useSessionArchive, save, t } = props
  const entry = useSessionArchive(state => state.bySession[String(sessionId)])
  const busy = entry?.status === 'saving'

  return (
    <>
      <button
        type="button"
        className={css.sessionArchiveButton}
        disabled={busy}
        aria-busy={busy}
        onClick={() => { void save(sessionId) }}
      >
        <span>{busy ? t('action.savingLabel') : t('action.saveLabel')}</span>
        <IconDownloadOutline16 size={12} />
      </button>
      <SessionArchiveSaveDialog {...props} />
    </>
  )
}
