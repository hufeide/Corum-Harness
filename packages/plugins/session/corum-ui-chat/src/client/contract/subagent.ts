/** Subagent progress-card payload shared between the Chat Node and its renderer. */

import type { SubagentStopReason } from '@corum/corum-api-remotes/corum-events'

/** Turn-local subagent invocation encoded as a reference-stable Location-data scalar. */
export type SubagentTurnSignature = string

/** Live progress snapshot of one matched child Session (polled by the renderer). */
export interface SubagentProgressSnapshot {
  /** Latest turn opened in the child's event window (0 = none yet). */
  readonly turn: number
  /** Steps closed in the current turn. */
  readonly step: number
  /** Latest tool-call name when the child is mid-action. */
  readonly currentAction?: string
  /** The child's latest turn closed (`turn/end`). */
  readonly done: boolean
  /** 终局原因；仅在该 turn 闭合时给出（undefined = 运行中/未结束）。 */
  readonly stopReason?: SubagentStopReason
}

/** Static identity of one delegated subagent invocation, folded from the parent log. */
export interface SubagentInvocation {
  /** Parent-side `tool/call` identity of the delegation. */
  readonly callId: string
  /** Parent turn that issued the delegation. */
  readonly turn: number
  /** Parent event seq anchoring the card in the waterfall. */
  readonly anchorSeq: number
  /** Parent event time of the delegation call. */
  readonly time: number
  /** Delegation `description` (or recovered child label); may be absent on history cuts. */
  readonly description?: string
  /** Leading excerpt of the delegated `prompt`; absent when not in the loaded window. */
  readonly prompt?: string
  /** Matched child Session id (`origin: 'subagent'` + parent lineage + nearest start time). */
  readonly childSessionId?: string
  /**
   * 前台一次性（父等结果）还是后台 agent（父继续干活、可续接）。
   * 首选宿主 `corum/subagent/child` 广播的权威值；页面刷新后由工具参数
   * `run_in_background` 兜底（缺省参数时未知——实例默认由机制决定）。
   */
  readonly mode?: 'foreground' | 'background'
  /** Renderer-polled child progress (not folded by the Definition). */
  readonly progress?: SubagentProgressSnapshot
}

/** One matched child Session's latest observed progress, folded from its event window. */
export interface SubagentProgress {
  /** Direct child Session id. */
  readonly sessionId: string
  /** Durable descriptor label when the child published one. */
  readonly label?: string
  /** Live activity of the child; absent until its own event window resolves. */
  readonly running?: boolean
  /** Latest turn opened in the child's loaded window. */
  readonly turn: number
  /** Steps closed in the current turn. */
  readonly step: number
  /** Free-form current action: latest tool call or open assistant generation. */
  readonly currentAction?: string
  /** Whether the child's event window was still cold at snapshot time. */
  readonly windowCold: boolean
}

/** Card payload keyed by parent delegation call. */
export interface SubagentChatData {
  readonly invocations: readonly SubagentInvocation[]
}

/** Leading-prompt excerpt length in Unicode code points. */
const PROMPT_EXCERPT_MAX = 120

/** Read one string field off a structurally narrowed payload. */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Extract the delegation display fields from one raw `tool/call` arguments JSON.
 * @param argsRaw - raw arguments string exactly as the model produced it.
 * @returns short description and a leading prompt excerpt, when present.
 */
export function subagentDelegationFields(argsRaw: string): {
  readonly description?: string
  readonly prompt?: string
  readonly mode?: 'foreground' | 'background'
} {
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Readonly<Record<string, unknown>>
    const description = textOf(record.description)
    const promptValue = textOf(record.prompt)
    const prompt = promptValue === undefined
      ? undefined
      : [...promptValue].slice(0, PROMPT_EXCERPT_MAX).join('')
    // run_in_background 缺省时实例默认（worker=continuable→后台，research=one-shot
    // →前台）由机制决定，工具参数面看不出——留给宿主广播补权威值。
    const mode = record.run_in_background === true
      ? 'background' as const
      : record.run_in_background === false
        ? 'foreground' as const
        : undefined
    return {
      ...description === undefined ? {} : { description },
      ...prompt === undefined ? {} : { prompt },
      ...mode === undefined ? {} : { mode },
    }
  } catch {
    return {}
  }
}

/**
 * Encode one turn's subagent invocations as a primitive Location-data value.
 * @param invocations - folded invocation list of one turn.
 * @returns reference-stable scalar for equal payloads.
 */
export function encodeSubagentTurn(invocations: readonly SubagentInvocation[]): SubagentTurnSignature {
  return invocations.map(invocation => [
    invocation.callId,
    invocation.anchorSeq,
    invocation.time,
    invocation.description ?? '',
    invocation.prompt ?? '',
    invocation.childSessionId ?? '',
    invocation.mode ?? '',
    invocation.progress === undefined ? '' : [
      invocation.progress.turn,
      invocation.progress.step,
      invocation.progress.currentAction ?? '',
      invocation.progress.done ? 1 : 0,
      invocation.progress.stopReason ?? '',
    ].join(','),
  ].join('~')).join('|')
}

function decodeProgress(raw: string | undefined): SubagentProgressSnapshot | undefined {
  if (raw === undefined || raw === '') return undefined
  const [turn, step, action, done, stopReason] = raw.split(',')
  return {
    turn: Number(turn),
    step: Number(step),
    ...action === '' ? {} : { currentAction: action },
    done: done === '1',
    ...stopReason === undefined || stopReason === '' ? {} : { stopReason: stopReason as SubagentStopReason },
  }
}

/**
 * Decode a same-process signature produced by {@link encodeSubagentTurn}.
 * @param signature - encoded turn value.
 * @returns decoded invocation list (turn is re-attached by the reader).
 */
export function decodeSubagentTurn(signature: SubagentTurnSignature): readonly SubagentInvocation[] {
  if (signature === '') return []
  return signature.split('|').map((entry) => {
    const [callId, anchorSeq, time, description, prompt, childSessionId, mode, progressRaw] = entry.split('~')
    const progress = decodeProgress(progressRaw)
    return {
      callId,
      turn: 0,
      anchorSeq: Number(anchorSeq),
      time: Number(time),
      ...description === '' ? {} : { description },
      ...prompt === '' ? {} : { prompt },
      ...childSessionId === '' ? {} : { childSessionId },
      ...mode === 'foreground' || mode === 'background' ? { mode } : {},
      ...progress === undefined ? {} : { progress },
    }
  })
}
