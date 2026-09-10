import type { Context } from '@deepseek-ai/cordis'
import { registerAssistantConversationNode } from './assistant.ts'
import { registerChatConversationView } from './chat-snapshot-builder.ts'
import { registerCommandConversationNode } from './command.ts'
import { registerCompactionConversationNode } from './compaction.ts'
import { registerUnknownConversationFallback } from './fallback.ts'
import { registerInboxConversationNodes } from './inbox.ts'
import { registerMessageConversationNode } from './message.ts'
import { registerOrchestrateConversationNode } from './orchestrate.ts'
import { registerRequestPromptConversationNode } from './request-prompt.ts'
import { registerRetryConversationNode } from './retry.ts'
import { registerSubagentConversationNode } from './subagent.ts'
import { registerToolConversationNode } from './tool.ts'
import { registerTurnErrorConversationNode } from './turn-error.ts'
import { registerTurnMaxTokensConversationNode } from './turn-max-tokens.ts'
import { registerTurnProcess } from './turn-process.ts'
import { registerTurnTailConversationNode } from './turn-tail.ts'

/**
 * Register the Chat business Definitions and target builder contributed by this package.
 * @param ctx - owning UI Conversation context.
 */
export function registerConversationNodes(ctx: Context): void {
  registerInboxConversationNodes(ctx)
  registerMessageConversationNode(ctx)
  registerRequestPromptConversationNode(ctx)
  registerAssistantConversationNode(ctx)
  registerTurnProcess(ctx)
  registerToolConversationNode(ctx)
  registerCommandConversationNode(ctx)
  registerCompactionConversationNode(ctx)
  registerRetryConversationNode(ctx)
  registerTurnErrorConversationNode(ctx)
  registerTurnMaxTokensConversationNode(ctx)
  registerTurnTailConversationNode(ctx)
  // fork（corum）：子 Agent 进度卡（delegation 召唤 → 子会话匹配 → 瀑布流卡片）。
  registerSubagentConversationNode(ctx)
  // fork（corum）：orchestrate 编排卡（fan-out 任务清单 → 逐任务状态 → 集成阶段）。
  // 必须在 tool 之后注册：官方 toolDefinition 也 match 全部 tool/call，两者各建
  // 自己的 Context（key 含 definition.kind），互不冲突；orchestrate 调用**同时**
  // 保留通用工具行会重复，故本定义只负责卡片，通用行由 tool.ts 的既有逻辑决定。
  registerOrchestrateConversationNode(ctx)
  registerUnknownConversationFallback(ctx)
  registerChatConversationView(ctx)
}
