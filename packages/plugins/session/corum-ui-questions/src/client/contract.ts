/**
 * corum-ui-questions 契约：自实现 PendingQuestion（与官方 dsh-client-ui-user-questions
 * 的 PendingQuestion 同形），因为官方 `./client` 只 `export type`（类型）不导出运行时
 * 类，corum 无法 `new` 它。数据（questions）来自 `dsh-user-questions` 的
 * AskUserQuestionItem，应答语义（answer/cancel/delegate）与官方一致。
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

export type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

/** One structured answer batch covering every question of the request. */
export type QuestionAnswer = AskUserQuestionAnswer

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** Pending question request (corum card presentation). */
    question: PendingQuestion
  }
}

let nextQuestionKey = 0

/** Create a wire-preserved user-question rejection. */
function questionError(message: string, code: 'ASK_ABORTED' | 'ASK_CANCELLED'): Error {
  const error = new Error(message) as Error & { code: string }
  error.name = 'UserQuestionError'
  error.code = code
  return error
}

function settlePendingComposer(settle: () => void, failureMessage: string): Promise<void> {
  try {
    settle()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(failureMessage, { cause: error }))
  }
}

/** 一个可渲染的 plan-review（官方 PlanReview 同形）。 */
export interface PlanReview {
  /** 回显到答案里的问题 id。 */
  readonly id: string
  /** 卡片可及名（问题文本）。 */
  readonly question: string
  /** 待审的计划 markdown。 */
  readonly plan: string
  /** 批准该计划的选项。 */
  readonly approve: { readonly label: string; readonly description?: string }
  /** 拒绝该计划的选项（无则缺省）。 */
  readonly decline?: { readonly label: string; readonly description?: string }
}

/**
 * 把请求窄化成可渲染的 plan-review；否则返回 undefined 走通用提问流。
 * 官方 `planReviewOf` 同形移植（corum 删 PlanReviewPanel 时一并删了它——
 * todo.questions.plan-review.renderer-missing）：单问题 + 声明 plan-review intent +
 * 带 detail（计划正文）+ 单选 + 至多一个 approve 之外的选项。
 */
export function planReviewOf(questions: readonly AskUserQuestionItem[]): PlanReview | undefined {
  if (questions.length !== 1) return undefined
  const question = questions[0] as AskUserQuestionItem
  const intent = question.intent
  if (intent?.kind !== 'plan-review' || question.detail === undefined) return undefined
  if (question.multiSelect === true) return undefined
  const options = question.options ?? []
  if (options.length > 2) return undefined
  const approve = options.find(option => option.label === intent.approve)
  if (approve === undefined) return undefined
  const decline = options.find(option => option.label !== intent.approve)
  return {
    id: question.id,
    question: question.question,
    plan: question.detail,
    approve,
    ...(decline === undefined ? {} : { decline }),
  }
}

/** One answerable Client presentation of a pending Host waterfall. */
export class PendingQuestion {
  /** Presentation discriminator used by Session pending-interaction consumers. */
  readonly kind: 'question' | 'plan-review'
  /** Opaque render identity and request key for the Session-scoped draft store. */
  readonly key: string
  /** The request's question list. */
  readonly questions: readonly AskUserQuestionItem[]
  /** Result returned by the Remote Event listener to the Host waterfall. */
  readonly result: Promise<QuestionAnswer>

  readonly #resolve: (answer: QuestionAnswer) => void
  readonly #reject: (reason: unknown) => void
  readonly #signal: AbortSignal | undefined
  readonly #onAbort: (() => void) | undefined
  readonly #delegated = Symbol('pending question delegated')
  #settled = false

  constructor(
    readonly sessionId: SessionId,
    questions: readonly AskUserQuestionItem[],
    signal?: AbortSignal,
  ) {
    nextQuestionKey += 1
    this.key = `question:${String(nextQuestionKey)}`
    this.questions = questions
    this.kind = planReviewOf(questions) === undefined ? 'question' : 'plan-review'
    const completion = Promise.withResolvers<QuestionAnswer>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    this.#signal = signal
    if (signal === undefined) {
      this.#onAbort = undefined
      return
    }
    const onAbort = (): void => {
      this.abort(questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    this.#onAbort = onAbort
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  }

  /** Resolve the Host waterfall with the whole answer batch. */
  answer(answer: QuestionAnswer): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => { this.#resolve(answer) })
    }, 'pending question settlement failed')
  }

  /** Delegate an unanswered request to the next waterfall listener. */
  delegate(): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(this.#delegated) })
  }

  /** Test whether a rejection requests waterfall delegation. */
  isDelegation(reason: unknown): boolean {
    return reason === this.#delegated
  }

  /** Reject the Host waterfall because the user closed the question. */
  cancel(): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => {
        this.#reject(questionError('the user cancelled ask_user_question', 'ASK_CANCELLED'))
      })
    }, 'pending question cancellation failed')
  }

  /** End an unanswered presentation when its transport, scope, or plugin lifetime ends. */
  abort(reason: unknown): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(reason) })
  }

  private finish(settle: () => void): void {
    if (this.#settled) throw new Error(`pending question ${this.key} is already settled`)
    this.#settled = true
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort)
    }
    settle()
  }
}
