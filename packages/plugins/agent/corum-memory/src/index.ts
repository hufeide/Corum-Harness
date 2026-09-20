/**
 * @corum/corum-memory — corum 通用记忆底座插件（host 半）。
 *
 * 提供 cordis 服务 `memory`（MemoryService，TypertRemoteService），承载事实级
 * 记忆的「组织形式」：写入（重要性门槛 + recency-wins 合并）、读时降权检索、
 * 人工修剪三动作（失效标记/重要性调整/硬删除）。存储复用官方 dsh-storage-domain。
 *
 * 本插件**不绑定任何记忆来源**——「记忆从哪儿来、如何用」由后续使用者决定，
 * 底座只提供能力面（ctx.memory + /api/memory/* RPC）。
 *
 * @module @corum/corum-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { MemoryService } from './memory-service.ts'

export { MemoryService } from './memory-service.ts'
export type { PutFactInput, PutFactResult, SearchFactsInput } from './memory-service.ts'
export { memoryDomainSpec, memoryFactSchema } from './memory-entities.ts'
export type { MemoryFact, MemoryFactView, MemoryScope, MemoryTier } from './memory-entities.ts'
export { tierFor, effectiveScoreFor, isActive, toView, conflictsToInvalidate } from './memory-policy.ts'

/** Cordis 插件名。 */
export const name = 'corum-memory'

/** 运行时依赖：storageDomain（事实持久化）。 */
export const inject: string[] = ['storageDomain']

/** 挂载 MemoryService 单例服务（幂等：重复 apply 不再注册）。 */
export function apply(ctx: Context): void {
  // 幂等：与 corum-ollama 同款守卫，避免重复 loader 行触发 cordis
  // 「service has been registered」硬错。
  if (ctx.get('memory') === undefined) {
    new MemoryService(ctx)
  }
}
