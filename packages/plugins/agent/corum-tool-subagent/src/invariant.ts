/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent`.
 * @module @deepseek-ai/dsh-tool-subagent/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
// 空类型 import：让 `ctx.tools` 的 Context 合并生效（`ToolRuntime` 由
// @deepseek-ai/dsh-tools 声明为 cordis 的 ambient augmentation）。
// ⚠️ 这条 import **不是装饰性的**：本文件用了 `ctx.tools.schemas(agent)`，但「谁把
// dsh-tools 拉进 program」原本由**同包的邻居文件**承担 —— list-models.ts / index.ts
// 各有一行值导入 `import { defineTool } from '@deepseek-ai/dsh-tools'`，靠 tsconfig 的
// `include: ["src"]` 把增强带进来。那是**偶然**的依赖：邻居一旦不再引用（正是
// corum-agent 的 conductor-runtime.ts 在项目模式剥离后踩到的形态），本文件就会报
// `TS2339: Property 'tools' does not exist on type 'Context'`。
// 故改为**本文件自证**依赖，与仓库既有惯例一致（如 corum-api-remotes/src/corum-events.ts）。
import type {} from '@deepseek-ai/dsh-tools'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { subagentModelSelectionPolicy } from './model-selection-state.ts'

const PACKAGE_NAME = '@corum/corum-tool-subagent'

/** Cordis companion plugin name. */
export const name = 'corum-tool-subagent-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Assert that model-selectable definitions are complete and reconstructable. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const schemas = ctx.tools.schemas(agent)
    const selectable = schemas.some((schema) => {
      const properties = (schema.parameters as { properties?: Record<string, unknown> }).properties
      return properties?.['provider'] !== undefined
        && properties['model'] !== undefined
        && properties['reasoning_effort'] !== undefined
    })
    const discoverable = schemas.some(schema => schema.name === 'list_subagent_models')
    if (
      (selectable || discoverable)
      && (
        subagentModelSelectionPolicy(ctx.sessionProjections, agent.session) === undefined
        || !selectable
        || !discoverable
      )
    ) {
      fail('model-selectable subagent definitions require a durable policy, route fields, and list_subagent_models')
    }
    return next()
  }, { global: true })
}, { inject: ['tools', 'sessionProjections'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
