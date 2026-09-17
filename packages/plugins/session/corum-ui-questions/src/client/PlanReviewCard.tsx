/**
 * PlanReviewCard — 「计划待审」决定卡（todo.questions.plan-review.renderer-missing）。
 *
 * 背景：corum 重写 questions 包时把官方 `PlanReviewPanel` 连同 `planReviewOf`
 * 一并删了，于是 plan-mode 的「计划待审」请求 kind 被错标为 'question'、
 * approve/decline 变成普通 radio 选项，而**计划正文（detail）根本不显示**——
 * 用户看不到要审的计划，只能盲选。本卡补回这一面：
 *
 *   - strip「计划待审」+ MarkdownText 渲染 `review.plan`（计划正文）；
 *   - 三键：讨论（`pending.cancel()`）/ 拒绝（decline，有则）/ 批准（approve）。
 *
 * 数据来自 `planReviewOf(pending.questions)` 的窄化（contract.ts 已从官方移植）。
 * 壳结构对齐 QuestionCard（corum/dsw 设计 token + head/actions 骨架），挂 dock 不遮盖。
 * @module corum-ui-questions/client/PlanReviewCard
 */
import { useMemo, useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { Check, ClipboardList, PenLine, X } from 'lucide-react'
import type { PendingQuestion, PlanReview } from './contract.ts'
import css from './PlanReviewCard.module.css'

/**
 * 渲染一个 plan-review 为决定卡。
 * @param props - pending（会话域面）+ review（窄化后的待审计划）。
 * @returns 计划待审决定卡。
 */
export function PlanReviewCard({ pending, review }: { pending: PendingQuestion; review: PlanReview }) {
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: '复制', copiedLabel: '已复制' },
    footnotes: '脚注',
  }), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** 提交一个决定（busy 防重，失败回显并复 enable）。 */
  const settle = (send: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setError(null)
    void send().catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }
  /** 批准 / 拒绝：回带该选项 label 作为答案。 */
  const decide = (label: string): void => {
    settle(() => pending.answer({ answers: [{ id: review.id, selected: [label] }] }))
  }
  const decline = review.decline

  return (
    <div className={css.card} data-plan-review-key={pending.key}>
      {/* strip：题型图标 + 「计划待审」 + 组名 */}
      <div className={css.head}>
        <span className={css.qIcon}><ClipboardList size={17} /></span>
        <span className={css.headTx}>
          <span className={css.qGroup}>计划待审</span>
          <span className={css.qTitle}>{review.question}</span>
        </span>
      </div>

      {/* 计划正文（markdown，可滚动） */}
      <div className={css.body} data-plan-review-scroll>
        <MarkdownText text={review.plan} labels={markdownLabels} />
      </div>

      {/* 操作行：讨论（放弃）/ 拒绝 / 批准 */}
      <div className={css.footer}>
        {error !== null && <span className={css.feedback} role="status">{error}</span>}
        <div className={css.actions}>
          <button
            type="button"
            className={css.btnGhost}
            disabled={busy}
            onClick={() => { settle(() => pending.cancel()) }}
          >
            <PenLine size={13} />讨论
          </button>
          {decline !== undefined && (
            <button
              type="button"
              className={css.btnOutline}
              {...decline.description === undefined ? {} : { title: decline.description }}
              disabled={busy}
              onClick={() => { decide(decline.label) }}
            >
              <X size={13} />{decline.label}
            </button>
          )}
          <button
            type="button"
            className={css.btnPrimary}
            {...review.approve.description === undefined ? {} : { title: review.approve.description }}
            disabled={busy}
            onClick={() => { decide(review.approve.label) }}
          >
            <Check size={13} />{review.approve.label}
          </button>
        </div>
      </div>
    </div>
  )
}
