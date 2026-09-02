/**
 * corum-desktop client half: framework-level surfaces for the desktop shell.
 * The transport is the official web stack (the renderer loads the host's
 * loopback webserver directly), so this plugin carries no connection glue —
 * only the notification store/host and the resident editor column. Dev HMR is
 * served by the official `dsh-client-hmr` row (webserver SSE), enabled by the
 * desktop overlay.
 * @module corum-desktop/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createNotificationStore, type NotificationStore } from './notifications.ts'
import { mountNotificationHost } from './mount-notifications.tsx'
// Type-only: pulls the `ctx.slots` Context merge (declared by dsh-client-ui-renderer).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the `corum.editor` SlotMap row (declared by @corum/corum-ide-ui).
import type {} from '@corum/corum-ide-ui/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { EditorColumn } from './editor/EditorColumn.tsx'
import type { EditorColumnInjected } from './editor/EditorColumn.tsx'
import type { FsEntry } from './editor/ExplorerPane.tsx'

/** Required services: none — this is the wire root; the code-editor view registers lazily below. */
export const inject: string[] = []

// Context merge: the framework notification store is injectable by any plugin.
declare module '@deepseek-ai/cordis' {
  interface Context {
    notifications: NotificationStore
  }
}

/**
 * Client plugin body: framework surfaces over the desktop IPC carrier.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  // Framework notifications (design.pen「row-通知框」): a framework-level
  // capability any combo can use — HMR failure is just the first consumer.
  // The store is provided as `ctx.notifications`; the host renders the toast
  // stack into a body-rooted portal (decoupled from any combo's slot system).
  const notifications = createNotificationStore()
  ctx.provide('notifications', notifications)
  const notificationHost = mountNotificationHost(notifications)
  ctx.effect(() => () => { notificationHost.dispose() }, 'corum-desktop: notification host')
  // Debug/console surface: lets CDP and the devtools console emit a notification
  // without a fiber reference (plugins should inject `ctx.notifications` instead).
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __corumNotify?: NotificationStore['notify'] }).__corumNotify = notifications.notify
  }

  // The resident Monaco editor (design.pen ③ 编辑器区合并卡，2026-09-03 改版：
  // 编辑器 + 资源管理器合一张卡): registered into the shell's `corum.editor`
  // slot (declared by @corum/corum-ide-ui, IDE mode only). Monaco's worker/
  // protocol infrastructure lives in this client bundle, so the editor column
  // registers here rather than in a separate plugin (which would have to
  // re-bundle Monaco + re-plumb the worker protocol).
  // inject 面 closeRegion 直通 ctx.layout.closeRegion（原 CLOSE_REGION_EVENT
  // 窗口事件桥已退役）；explorer 面（listDir + generation）内嵌资源管理器
  // 子面板的数据源——原独立插件 @corum/corum-ide-explorer-ui 已并入本卡。
  ctx.inject(['slots', 'layout', 'connection'], (editorCtx) => {
    const connection = editorCtx.get('connection') as ConnectionHandle
    const dispose = editorCtx.slots.inject('corum.editor', () => editorCtx.slots.register(
      {
        name: 'corum.editor',
        inject: (): EditorColumnInjected => ({
          closeRegion: () => { editorCtx.layout.closeRegion('corum.editor') },
          showEditor: () => { editorCtx.layout.setRegionHidden('corum.editor', false) },
          explorer: {
            generation: connection.generation,
            listDir: async (path) => {
              const result = await connection.rpc.call('/api', 'corumFs/list', { args: { path } })
              return result as { ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }
            },
          },
          readFile: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/read', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { content: string; language: string } }
          },
          writeFile: async (path, content) => {
            const result = await connection.rpc.call('/api', 'corumFs/write', { args: { path, content } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          mkdirp: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/mkdir', { args: { path } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          deletePath: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/delete', { args: { path } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          renamePath: async (from, to) => {
            const result = await connection.rpc.call('/api', 'corumFs/rename', { args: { from, to } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          absolutePath: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/absolutePath', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { absolutePath: string } }
          },
          revealPath: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/reveal', { args: { path } })
            return result as { ok: boolean; error?: { message?: string } }
          },
          startWatch: async () => {
            const result = await connection.rpc.call('/api', 'corumFs/watch', { args: {} })
            return result as { ok: boolean; error?: { message?: string } }
          },
          pollChanges: async () => {
            const result = await connection.rpc.call('/api', 'corumFs/pollChanges', { args: {} })
            return result as { ok: boolean; error?: { message?: string }; value?: { changes: { path: string; kind: 'rename' | 'change' }[] } }
          },
        }),
      },
      EditorColumn,
    ))
    return () => { dispose() }
  })
}
