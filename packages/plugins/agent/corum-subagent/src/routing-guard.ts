/**
 * fork（corum）P1：**脚本模式的模型路由剥离**（2026-09-27，用户裁定方案 A「剥离 + 告知」）。
 *
 * ## 为什么需要
 *
 * `orchestrate` 的 script 模式里，模型写的脚本可以 `agent(prompt, { provider, model })`。
 * 运行时引擎**确实接受**这两个选项 —— 证据（运行时产物，不是 `/Users/kukucai/dsh` 检出）：
 * `node_modules/.pnpm/@deepseek-ai+dsh-base@0.1.3-alpha.1_<hash>/node_modules/@deepseek-ai/
 * dsh-workflow-worker-thread/lib/worker.cjs` 里
 * `SUPPORTED_AGENT_OPTIONS = new Set(["label", "phase", "schema", "provider", "model"])`，
 * `agent()` 经 `readAgentOptions()` 放行后进入 `ChildStart` 请求。
 *
 * 而 `resolveChildAgentOptions`（`child-agent.ts`）把 `...requested` 放在**最后** ⇒ 不剥离就会
 * **覆盖父路由**。工具路径那道「模型不得选择路由」的门禁（schema 剔除 +
 * `assertAllowedModelSelection`）**不覆盖脚本模式**。
 *
 * 用户口径（2026-09-18）：「orchestrate 也不能豁免」——路由只能由机制/用户配置决定。
 * 故在 corum 侧的 spawn 接缝（`driver/index.ts` 调 `agents.create` 处）剥离，并告知模型。
 *
 * 设计稿：`docs/PLAN-2026-09-27-script-mode-model-routing.md`。
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** 被机制忽略的路由选项（脚本曾试图自己选模型）。 */
export interface RoutingOverrideIgnored {
  readonly provider?: string
  readonly model?: string
}

/**
 * 机制通知的归属（`form: 'notice'` ⇒ 会话里一条不可展开的提示行）。
 *
 * 与 `agent-message`（发送方自己写的内容）和 `subagent-settled`（管理方对子会话结局的陈述）
 * **刻意区分**：这条是管理方对**派发参数被裁剪**这一机制的陈述，不是任何 Agent 说的话。
 */
export interface MechanismNoticeSource {
  readonly kind: 'mechanism-notice'
  /** 运行时提示行（`notice` 形态）。 */
  readonly form: 'notice'
  /** 一行摘要。 */
  readonly summary: string
  /** 与之相关的子会话 id（可选：剥离发生在派发前）。 */
  readonly senderSessionId?: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'mechanism-notice': MechanismNoticeSource
  }
}

/** `corumStripRoutingOptions` 的结果。 */
export interface StrippedRoutingOptions {
  /** 可以安全交给 `resolveChildAgentOptions` 的选项（已去掉 `provider`/`model`）。 */
  readonly options: AgentOptions | undefined
  /** 被剥离的内容；未剥离时为 `undefined`。 */
  readonly ignored: RoutingOverrideIgnored | undefined
}

/**
 * 剥掉脚本传进来的 `provider`/`model`（其余选项原样保留）。
 *
 * 纯函数，便于单测；调用方负责把 `ignored` 变成机制通知。
 *
 * @param requested - 来自引擎 `ChildStart` 请求的 agentOptions。
 * @returns 剥离后的选项与被剥离的内容。
 */
export function corumStripRoutingOptions(requested: AgentOptions | undefined): StrippedRoutingOptions {
  if (requested === undefined) return { options: undefined, ignored: undefined }
  const { provider, model, ...rest } = requested as AgentOptions & { readonly provider?: string; readonly model?: string }
  if (provider === undefined && model === undefined) return { options: requested, ignored: undefined }
  const ignored: RoutingOverrideIgnored = {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
  }
  return {
    options: Object.keys(rest).length === 0 ? undefined : rest as AgentOptions,
    ignored,
  }
}

/**
 * 机制通知正文（英文，机制口吻，一行内说清「你试了什么 / 机制做了什么 / 实际跑了哪条」）。
 *
 * @param ignored - 被剥离的选项。
 * @param effective - 该子会话实际生效的路由（机制自己的决定）。
 * @returns 通知文本。
 */
export function corumRoutingIgnoredNoticeText(
  ignored: RoutingOverrideIgnored,
  effective: { readonly provider?: string; readonly model?: string },
): string {
  const asked = [
    ignored.provider === undefined ? undefined : `provider=${ignored.provider}`,
    ignored.model === undefined ? undefined : `model=${ignored.model}`,
  ].filter((part): part is string => part !== undefined).join(', ')
  const ran = [
    effective.provider === undefined ? undefined : `provider=${effective.provider}`,
    effective.model === undefined ? undefined : `model=${effective.model}`,
  ].filter((part): part is string => part !== undefined).join(', ')
  return `Script-provided routing options were ignored (${asked}). The mechanism owns child routing: `
    + `this child ran on ${ran === '' ? "your session's own route" : ran}. Do not pass \`provider\`/ \`model\` from a script.`
}
