/** Web-only plugin: the integrations pages carry no Host-side contributions. */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'ide-integrations-pages'

/** Required services (none — every contribution lives in the browser half). */
export const inject: string[] = []

/**
 * No-op Host half; kept so the package graph entry stays a valid plugin.
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {
  // 集成中心内容页（MCP / 技能）是浏览器半的事（PR6）。
}
