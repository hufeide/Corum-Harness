/**
 * @corum/corum-ide-panel-bottom-ui client half — the IDE terminal (design.pen ⑥). The
 * panel is now a normal grid leaf (registered into the shell's `corum.panel`
 * slot, added to defaultGrid's bottom row), so it can be resized / rearranged
 * with the other regions. The × close hides the leaf via `ctx.layout.closeRegion`
 * (reopen from the plugin manager's 视图管理); no window-event bridge remains.
 *
 * 真实终端（0.1.2 换真）：BottomPanel 的 xterm.js 经 host corumTerminal RPC
 * 驱动 node-pty 登录 shell（create/write/resize/poll/kill），数据走官方
 * ctx.connection.rpc（`call('/api', 'corumTerminal/xxx', { args: {...} })`，与
 * corumFs 同理，见 corum-desktop/src/host/corum-terminal.ts）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { type Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@corum/corum-ide-ui/client'
// 拉入 fork 装配面的 ctx.remote Context 合并 + corum 事件 $on 类型投影
// （'corum/terminal/output' listener 签名由此而来；package.json dsh.client.inject
// 已声明 @corum/corum-api-remotes，装配面在 cordis 激活序中先于本插件就绪）。
import type {} from '@corum/corum-api-remotes/client'
import { BottomPanel } from './BottomPanel.tsx'
import type { BottomPanelInjected } from './BottomPanel.tsx'

export type { BottomPanelInjected } from './BottomPanel.tsx'

/** Required services: the slots registry + the connection rpc face + the layout face (ctx.layout.closeRegion) + the Remote event face (ctx.remote.$on 终端输出推送)。 */
export const inject = ['slots', 'connection', 'layout', 'remote']

/** RPC 信封（与 BottomPanel.tsx 的 RpcEnvelope 同构；host Typert Remote 返回）。 */
interface Envelope<T> {
  ok: boolean
  value?: T
  error?: { message?: string }
}

/**
 * Client plugin body: register the real terminal into corum.panel.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(
    () => ctx.slots.inject('corum.panel', () => ctx.slots.register(
      {
        name: 'corum.panel',
        inject: (): BottomPanelInjected => ({
          closeRegion: () => { ctx.layout.closeRegion('corum.panel') },
          create: async () => {
            const result = await connection.rpc.call('/api', 'corumTerminal/create', { args: {} })
            return result as Envelope<{ id: string }>
          },
          writeTerm: async (id, data) => {
            const result = await connection.rpc.call('/api', 'corumTerminal/write', { args: { id, data } })
            return result as Envelope<{ written: boolean }>
          },
          resizeTerm: async (id, cols, rows) => {
            const result = await connection.rpc.call('/api', 'corumTerminal/resize', { args: { id, cols, rows } })
            return result as Envelope<{ resized: boolean }>
          },
          poll: async (id) => {
            const result = await connection.rpc.call('/api', 'corumTerminal/poll', { args: { id } })
            return result as Envelope<{ data: string; exited: boolean; exitCode?: number }>
          },
          // 统一事件中心一期：终端输出改走官方 forwarded-Remote-event 通道
          // （host corumTerminal 在 proc.onData 里 emit；真实推送，取代 60ms poll
          // 主路径）。$on 返回的 dispose 由组件 unmount 时调用。
          onTerminalOutput: (listener) => ctx.remote.$on('corum/terminal/output', listener),
          kill: async (id) => {
            const result = await connection.rpc.call('/api', 'corumTerminal/kill', { args: { id } })
            return result as Envelope<{ killed: boolean }>
          },
        }),
      },
      BottomPanel,
    )),
    'ide-panel-bottom: corum.panel real terminal',
  )
}
