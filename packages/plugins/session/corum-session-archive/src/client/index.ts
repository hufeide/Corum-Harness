/** Browser plugin owning session-archive save/import state over the desktop native bridge. */

import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import { type SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SessionArchiveController } from './controller.ts'
import { SessionArchiveHeaderAction } from './HeaderAction.tsx'
import type { SessionArchiveSaveInjected } from './SaveDialog.tsx'
import { SessionArchiveImportRow, type SessionArchiveImportInjected } from './ImportRow.tsx'
import { en, NS, zh, type SessionArchiveKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionArchive: SessionArchiveController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-archive': SessionArchiveKey
  }
}

export type {
  SessionArchiveDeleteEntry,
  SessionArchiveImportEntry,
  SessionArchiveSaveEntry,
  SessionArchiveState,
} from './controller.ts'

export const inject = ['slots', 'locale']

/**
 * Provide the archive controller and mount the Session Header save action
 * plus the General-settings import row.
 *
 * P0-2（2026-09-14）恢复范围（用户裁决）：
 * - 恢复「保存到…」：挂 `conversation.session.header.utilities`（会话插件声明、
 *   有渲染点的 list 子槽，corum-ide-ui 的轨迹按钮同槽）。
 * - 恢复「导入会话日志」：挂 `settings.general.item`（P0-5 修好渲染点后从
 *   `settings.section` 临时形态迁回，见下方注册处的标记）。
 * - 不恢复「删除会话」按钮：733d3b70 定调移除不可逆入口的裁决对它仍成立；
 *   controller.deleteSession 保留为程序化 API。
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const controller = new SessionArchiveController()
  ctx.provide('sessionArchive', controller)
  ctx.effect(() => async () => { await controller.dispose() }, 'session-archive: bridge operation lifecycle')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-archive: dictionaries')

  const saveInjected = (): SessionArchiveSaveInjected => ({
    hooks: { sessionArchive: controller.store },
    save: (sessionId: SessionId) => controller.save(sessionId),
    dismiss: (sessionId: SessionId) => { controller.dismissSave(sessionId) },
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-archive-save',
    locale: NS,
    inject: saveInjected,
  }, SessionArchiveHeaderAction))

  const importInjected = (): SessionArchiveImportInjected => ({
    hooks: { sessionArchive: controller.store },
    desktopAvailable: () => controller.desktopAvailable,
    requestImport: () => controller.import(),
    dismissImport: () => { controller.dismissImport() },
  })

  // P0-5（2026-09-14）迁回：settings.general.item 渲染点已修好
  // （corum-ide-ui GeneralSection renderSlot 该槽），导入行恢复注册进该槽。
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'session-archive-import',
    order: 30,
    locale: NS,
    inject: importInjected,
  }, SessionArchiveImportRow))
}

export type { SessionArchiveSaveInjected, SessionArchiveSaveDialogProps } from './SaveDialog.tsx'
export type { SessionArchiveImportInjected, SessionArchiveImportRowProps } from './ImportRow.tsx'
