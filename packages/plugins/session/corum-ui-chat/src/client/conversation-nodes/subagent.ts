import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
} from '@corum/corum-ui-conversation/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { isSubagentDelegationTool } from '../contract/turn-process.ts'
import {
  decodeSubagentTurn, encodeSubagentTurn, subagentDelegationFields,
  type SubagentInvocation, type SubagentTurnSignature,
} from '../contract/subagent.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Delegated subagent invocations of one Turn, rendered as progress cards. */
    'subagent-call': import('../contract/subagent.ts').SubagentChatData
  }
}

declare module '@corum/corum-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Encoded subagent invocation list for this Turn. */
    'subagent-progress': SubagentTurnSignature
  }
}

interface SubagentTurnState {
  readonly turn: number
  readonly invocations: readonly SubagentInvocation[]
  /** Whether this Context saw a delegation tool/call in the live feed. */
  readonly sawDelegation: boolean
}

type ConversationEvent = Parameters<ConversationNodeDefinition['match']>[0]

function eventTurn(event: ConversationEvent): number | undefined {
  const data = event.data as unknown as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : undefined
}

/**
 * Best-effort correlation of one delegation call to its child Session:
 * durable `origin: 'subagent'` + direct parent lineage + nearest summary row
 * that arrived no earlier than the call (a reused continuable child row
 * predates its later calls; its identity resolves via its already-cached
 * `childSessionId` once matched). The parent id is recovered from each
 * candidate child row itself, so the Definition stays registration-global.
 * Unmatched calls degrade to summary-only cards driven by the delegation
 * lifecycle itself.
 */
function correlateChild(
  candidates: readonly SessionSummary[],
  callTime: number,
): string | undefined {
  const later = candidates
    .map((summary, index) => ({ summary, index, arrivedAt: summary.updatedAt }))
    .filter(entry => entry.arrivedAt >= callTime)
    .sort((left, right) => left.arrivedAt - right.arrivedAt || left.index - right.index)
  return later[0]?.summary.id
}

function refreshCorrelation(
  invocations: readonly SubagentInvocation[],
  summaries: Readonly<Record<string, SessionSummary>>,
): readonly SubagentInvocation[] {
  const children = Object.values(summaries).filter(summary => summary.origin === 'subagent')
  return invocations.map((invocation) => {
    if (invocation.childSessionId !== undefined) return invocation
    const childSessionId = correlateChild(children, invocation.time)
    return childSessionId === undefined ? invocation : { ...invocation, childSessionId }
  })
}

function withInvocation(
  state: SubagentTurnState,
  invocation: SubagentInvocation,
): SubagentTurnState {
  const index = state.invocations.findIndex(candidate => candidate.callId === invocation.callId)
  return index < 0
    ? { ...state, invocations: [...state.invocations, invocation] }
    : { ...state, invocations: state.invocations.map((candidate, at) => at === index ? invocation : candidate) }
}

function startInvocation(match: ConversationMatch): SubagentInvocation {
  if (match.event.type !== 'tool/call') throw new Error('subagent start requires tool/call')
  const fields = subagentDelegationFields(match.event.data.arguments)
  return {
    callId: String(match.event.data.callId),
    turn: match.event.data.turn,
    anchorSeq: match.event.seq,
    time: match.event.time,
    ...fields.description === undefined ? {} : { description: fields.description },
    ...fields.prompt === undefined ? {} : { prompt: fields.prompt },
  }
}

function fallbackState(context: ConversationNodeContext<SubagentTurnState>): SubagentTurnState | undefined {
  const turn = context.matches.map(match => eventTurn(match.event)).find(candidate => candidate !== undefined)
  if (turn === undefined) return undefined
  let state: SubagentTurnState = { turn, invocations: [], sawDelegation: false }
  for (const match of context.matches) {
    if (match.event.type === 'tool/call' && isSubagentDelegationTool(match.event.data.name)) {
      state = { ...withInvocation(state, startInvocation(match)), sawDelegation: true }
    }
  }
  return state
}

/** Latest invocation list of one turn, correlated against the live session list. */
function currentInvocations(
  context: ConversationNodeContext<SubagentTurnState>,
  summaries: Readonly<Record<string, SessionSummary>>,
): readonly SubagentInvocation[] {
  const state = context.state ?? fallbackState(context)
  if (state === undefined) return []
  return refreshCorrelation(state.invocations, summaries)
}

/** Decode rows of one encoded turn, re-attaching its turn coordinate. */
function decodeSubagentTurnRows(
  signature: SubagentTurnSignature,
  turn: number,
): readonly SubagentInvocation[] {
  return decodeSubagentTurn(signature).map(invocation => ({ ...invocation, turn }))
}

/**
 * Build the Turn-scoped subagent Definition bound to the sessions service for
 * summary-based child correlation at Location-data evaluation time.
 * @param sessions - sessions service face exposing the live summary list.
 * @returns subagent progress-card Definition.
 */
export function subagentTurnDefinition(
  sessions: ISessions,
): ConversationNodeDefinition<SubagentTurnState> {
  return {
    kind: 'subagent-progress',
    target: 'chat',
    match: (event) => {
      // Anchor each Turn Context on its durable `turn/start` (the engine folds
      // any earlier same-id updates into a replay of matches[0] = start).
      // Everything else is an update — pre-start leftovers replay through
      // start(), live events fold through update().
      if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
      const turn = eventTurn(event)
      if (turn === undefined) return null
      return { id: String(turn), role: 'update' }
    },
    start: (context, match) => {
      if (match.event.type !== 'turn/start') throw new Error('subagent start requires turn/start')
      // Replay every pre-start update folded into this Context (the turn's
      // delegation tool/call may precede its projected `turn/start` in cold
      // feeds, and matches[0] must be the start Match — same anchor
      // discipline as turn-process / turn-error).
      const base: SubagentTurnState = { turn: match.event.data.turn, invocations: [], sawDelegation: false }
      return context.matches.slice(1).reduce<SubagentTurnState>((state, entry) => {
        if (entry.event.type === 'tool/call' && isSubagentDelegationTool(entry.event.data.name)) {
          return { ...withInvocation(state, startInvocation(entry)), sawDelegation: true }
        }
        return state
      }, base)
    },
    update: (context, match) => {
      if (match.event.type === 'tool/call' && isSubagentDelegationTool(match.event.data.name)) {
        return { ...withInvocation(context.state, startInvocation(match)), sawDelegation: true }
      }
      return context.state
    },
    buildLocationData: (context, scope) => {
      if (scope !== 'turn') return null
      const location = context.start?.location ?? context.matches.at(-1)?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const invocations = currentInvocations(context, sessions.list.getSnapshot().byId)
      if (invocations.length === 0) return null
      return {
        kind: 'turn',
        turn: location.turn.turn,
        key: 'subagent-progress',
        value: encodeSubagentTurn(invocations),
      }
    },
    buildViewNode: (context) => {
      const location = context.start?.location ?? context.matches.at(-1)?.location
      if (location?.kind !== 'turn' && location?.kind !== 'step') return null
      const signature = location.turn.data.get('subagent-progress')
      if (signature === undefined) return null
      const invocations = decodeSubagentTurnRows(signature, location.turn.turn)
      if (invocations.length === 0) return null
      const anchor = Math.min(...invocations.map(invocation => invocation.anchorSeq))
      return chatNode(context, 'subagent-call', anchor, { invocations })
    },
  }
}

/**
 * Register the subagent progress-card Definition against the live sessions service.
 * @param ctx - owning UI Conversation context.
 */
export function registerSubagentConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(subagentTurnDefinition(ctx.sessions))
}
