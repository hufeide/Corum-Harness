/**
 * `corumMcpPool` cordis 服务：把 {@link McpPool} 挂成**宿主单例**（红线 1：跨 bundle 共享状态
 * 只能是 cordis 服务，禁 module 级/window 单例——`@corum/*` 会被内联进每个消费方 bundle，
 * 模块级单例在每个 bundle 里各一份、永不合并）。
 *
 * 消费方（preset 代理行 `./proxy`）按红线 4 用 **`inject: ['corumMcpPool']`** 取用，
 * 不用 `ctx.get` 赌装配顺序。
 *
 * 本类**直接继承** {@link McpPool} 而不是再包一层转发：转发面会和池的 API 两处漂移，
 * 而这里需要的只是"给它接上 cordis 的 logger 与释放钩子"。
 *
 * @module @corum/corum-mcp-manager/mcp-pool-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { McpPool, type McpPoolOptions } from './pool.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** MCP 宿主级连接池（宿主单例；见 {@link McpPoolService}）。 */
    corumMcpPool: McpPoolService
  }
}

/** 宿主级池服务。 */
export class McpPoolService extends McpPool {
  constructor(ctx: Context, options: McpPoolOptions = {}) {
    super({
      ...options,
      log: options.log ?? ((level, message) => {
        if (level === 'warn') ctx.logger.warn(message)
        else ctx.logger.info(message)
      }),
    })
    // 宿主退出时把 server 进程一起收掉（否则会留孤儿进程）。
    // 用 `ctx.effect`（本仓卸载钩子的统一惯例：artgen / memory / sandbox-local 都这么写）；
    // `ctx.on('dispose')` 在这个 cordis 版本里不在 Events 类型面上。
    ctx.effect(() => () => this.disposeAll(), 'corumMcpPool.disposeAll')
  }
}
