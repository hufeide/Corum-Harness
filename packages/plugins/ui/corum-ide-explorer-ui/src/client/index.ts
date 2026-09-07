/**
 * @corum/corum-ide-explorer-ui client half — the IDE resource manager (design.pen ④,
 * 210px file tree). Registers the file tree into the shell's `corum.explorer`
 * slot. Data comes from the host fs RPC (`corumFs/list` Typert Remote, rooted at
 * the host project cwd — see corum-desktop/src/host/corum-fs.ts) via the official
 * ctx.connection.rpc (`call('/api', 'corumFs/list', { args: { path } })`).
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@corum/corum-ide-ui/client'
import { FileExplorer, type FsEntry } from './FileExplorer.tsx'
import type { FileExplorerInjected } from './FileExplorer.tsx'

// fork（corum）：本插件 2026-09-03 已解挂（cordis.ide.patch.yml——资源管理器并入
// corum.editor 槽内嵌 ExplorerPane，由 desktop client 接管），代码保留备查。
// `corum.explorer` 槽从未进 corum-ide-ui 的 SlotMap（壳层已无独立资源管理器槽），
// 故此处本地补声明使本备份代码自洽过类型检查；重新挂载时壳层无需再补。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 独立资源管理器区域（已退役, 备份备查——现并入 corum.editor 内嵌面板）。 */
    'corum.explorer': { kind: 'single'; scope: 'root' }
  }
}

export type { FileExplorerInjected } from './FileExplorer.tsx'

/** Required services: the slots registry + the connection rpc face + the layout face (ctx.layout.closeRegion)。 */
export const inject = ['slots', 'connection', 'layout']

/**
 * Client plugin body: register the file tree into corum.explorer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(
    () => ctx.slots.inject('corum.explorer', () => ctx.slots.register(
      {
        name: 'corum.explorer',
        inject: (): FileExplorerInjected => ({
          generation: connection.generation,
          closeRegion: () => { ctx.layout.closeRegion('corum.explorer') },
          listDir: async (path) => {
            const result = await connection.rpc.call('/api', 'corumFs/list', { args: { path } })
            return result as { ok: boolean; error?: { message?: string }; value?: { entries: FsEntry[] } }
          },
        }),
      },
      FileExplorer,
    )),
    'ide-explorer: corum.explorer file tree',
  )
}
