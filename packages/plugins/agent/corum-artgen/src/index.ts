/**
 * @corum/corum-artgen — corum 本地文生图插件（基于 stable-diffusion.cpp 引擎）。
 *
 * 纯 host 侧插件。ArtGenService 继承 TypertRemoteService，通过 @Remote
 * 装饰器暴露 /api/corumArtGen/* 端点供浏览器半调用。
 *
 * 能力：探测/管理本机 stable-diffusion.cpp 二进制（sd-cli），为 AI 文生图
 * 任务提供本地推理；支持 SD 1.5 等模型，三平台预编译二进制自动下载。
 * @module @corum/corum-artgen
 */

import type { Context } from '@deepseek-ai/cordis'
import { ArtGenService } from './artgen-service.ts'

export type { ArtGenStatus, SdModel, Txt2ImgArgs, Txt2ImgResult } from './types.ts'
export { ArtGenService } from './artgen-service.ts'

/** Cordis 插件名。 */
export const name = 'artgen'

/** 运行时依赖的服务（无外部依赖）。 */
export const inject: string[] = []

/** 挂载 ArtGenService 单例服务（幂等：重复 apply 不再注册）。 */
export function apply(ctx: Context): void {
  // 幂等：本插件的 host apply 可能被多个 loader 行触发。
  // corumArtGen 已在根 ctx 注册过则跳过，避免 cordis
  // 「service has been registered」硬错。
  if (ctx.get('corumArtGen') === undefined) {
    new ArtGenService(ctx)
  }
}
