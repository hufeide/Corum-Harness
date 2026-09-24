/**
 * 提问卡的**组件身份**守卫（与 corum-ui-model-ask 的「应用中…」卡死同源）。
 *
 * `QuestionDock` 直接渲染 `<QuestionCard pending={pending} />`（plan-review 分流到
 * `<PlanReviewCard>`）。**没有 key 时**，同一位置的后一次提问会被 React 按「同类型同
 * 位置」复用前一个实例的组件 state：
 *   - `QuestionCard`：`index`（当前题号）、`drafts`（已填未提交的草稿）、`busy`、
 *     `collapsed` —— 新提问会停在上一题的题号上、带着无关草稿；`busy` 为真时按钮
 *     点不动。
 *   - `PlanReviewCard`：`busy` / `error` —— 同样会让新卡片一出生就「处理中」。
 *
 * 这类缺陷**构建与 typecheck 都发现不了**，且只在「同一会话出现第二次提问」的时序下
 * 暴露。姊妹插件 corum-ui-model-ask 已在实机上复现过它的极端形态（面板永久卡在
 * disabled 的「应用中…」，而重跑早已结束）——那边也是同一个根因，已按同一手法修复。
 *
 * 既有正确对照：corum-ui-approval 的 `ApprovalPanel.tsx` 用的是
 * `<ApprovalFlow key={approval.key} ... />`；官方 `ui-user-questions` 的
 * `QuestionComposer.tsx` 对 `PlanReviewPanel` 也是 `key={question.key}`。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(join(import.meta.dirname, '../src/client/index.tsx'), 'utf8')

/** 剥掉注释（`/* … *​/` 与行内 `//`），避免说明性文字被当成代码判据。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('提问卡的组件身份', () => {
  const code = stripComments(INDEX)

  it('QuestionCard 按 pending 身份绑定 key', () => {
    expect(code).toMatch(/<QuestionCard\s+key=\{pending\.key\}\s+pending=\{pending\}/)
  })

  it('PlanReviewCard 按 pending 身份绑定 key', () => {
    expect(code).toMatch(/<PlanReviewCard\s+key=\{pending\.key\}\s+pending=\{pending\}/)
  })

  it('两张卡都没有无 key 的渲染形态（防回退）', () => {
    expect(code).not.toMatch(/<QuestionCard\s+pending=\{pending\}\s*\/>/)
    expect(code).not.toMatch(/<PlanReviewCard\s+pending=\{pending\}/)
  })
})
