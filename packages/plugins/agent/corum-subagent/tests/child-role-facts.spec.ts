/**
 * 子 Agent 的**自我事实**（模型 + 工作目录）必须真的渲染出来。
 *
 * ## 缺陷现场（2026-09-21 用户实测）
 *
 * 用户让两个子 Agent 自报模型，两者都答「You are an AI agent powered by DeepSeek Harness」
 * ——**报不出模型名**。实测确认根因**不是**占位符替换失败（子提示词里未插值的 `{{…}}` 数量为
 * **0**），而是那段含 `{{model}}` 的模板**根本没进子 Agent 的组装**：
 * 含它的是 `corum-agent/compile.ts` 的角色预设 persona，而子 Agent 不注入父的 persona
 * （它挂 `child-roles.ts` 的三份契约，此前一个占位符都没有）。
 *
 * ## 这个文件钉住两条
 *
 * ① **契约里有这一行**（`{{model}}` + `{{cwd}}`）——否则测试/用户都无法判定子 Agent 跑在哪个模型上；
 * ② **它真的能渲染**：用假 assembly 走一遍官方 `renderPrompt` 的严格插值，断言渲染结果含具体值。
 *
 * ② 不是多余的：官方对「注册了但求值为 `undefined`」**直接抛错**
 * （`prompt variable "{{x}}" has no value for this assembly`），而抛错会把**整次组装**打挂。
 * 所以「子 scope 里 model/cwd 恒有值」是这个改动的前提，必须可断言而不是靠假设。
 *
 * ⚠️ 真实值来源（实测，见 child-roles.ts 的 SELF_FACTS 注释）：
 *   · `{{cwd}}`  ← `context.agent.session.header.cwd` = 隔离时**精确到 worktree 根**
 *     （隔离 provider 在 `isolated/index.ts:148` 强制 `cwd: child.path`）；
 *   · `{{model}}` ← `context.agent.options.model` = 该子 Agent 的 `agentOptions`
 *     （= 预设的 `subagentModel` / `researchModel`）。
 *
 * @module @corum/corum-subagent/tests/child-role-facts
 */

import { describe, expect, it } from 'vitest'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { CHILD_WORK_STYLE, CHILD_WORKER_ROLE, RESEARCHER_ROLE } from '../src/child-roles.ts'

/** 两份角色契约（不含风格——风格段由 child-agent 单独叠加）。 */
const CONTRACTS: Array<[string, string]> = [
  ['worker', CHILD_WORKER_ROLE],
  ['researcher', RESEARCHER_ROLE],
]

/**
 * 走一遍官方严格插值。
 *
 * @param text - 段文本（含 `{{变量}}`）。
 * @param variables - assembly 的变量表。
 * @returns 渲染后的文本。
 */
function render(text: string, variables: Record<string, string>): Promise<string> {
  return renderPrompt({
    sections: [{ name: 'child-role', text }],
    contexts: [],
    variables,
    tools: [],
  } as never)
}

describe('子 Agent 角色契约：自我事实（model / cwd）', () => {
  it('★ 两份契约都含 SELF_FACTS 行（{{model}} + {{cwd}}）', () => {
    for (const [label, text] of CONTRACTS) {
      expect(text, `${label}: 缺 {{model}} ⇒ 子 Agent 无法自报模型`).toContain('{{model}}')
      expect(text, `${label}: 缺 {{cwd}} ⇒ 子 Agent 拿不到自己的绝对工作目录`).toContain('{{cwd}}')
    }
  })

  it('★ 真的能渲染出具体模型名与工作目录（严格插值，不抛错）', async () => {
    const vars = { model: 'glm-5.2', cwd: '/Users/kukucai/work/ai-lib/.corum-worktrees/wt-1e6b30' }
    for (const [label, text] of CONTRACTS) {
      const out = await render(text, vars)
      expect(out, `${label}: 渲染结果缺模型名`).toContain('glm-5.2')
      expect(out, `${label}: 渲染结果缺工作目录`).toContain('wt-1e6b30')
      // 渲染完不该残留任何未插值占位符
      expect(out).not.toMatch(/\{\{[^}]*\}\}/)
    }
  })

  it('★ 变量缺失时**必须抛错**（证明这条断言不是空转）', () => {
    // 官方严格插值：注册了但求值为 undefined ⇒ **同步抛**（实测：不是 reject，
    // 所以这里用 toThrow 而不是 rejects——用错会得到「测试失败但其实实现是对的」）。
    // 这条同时证明上面的「能渲染」是真的在求值，而不是那段文本被原样跳过。
    expect(() => render(CHILD_WORKER_ROLE, { model: undefined as never, cwd: '/tmp/x' }))
      .toThrow(/prompt variable "\{\{model\}\}" has no value/)
  })

  it('契约里除 model/cwd 外不得引用别的未注册变量', () => {
    for (const [label, text] of CONTRACTS) {
      const refs = [...text.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map(m => m[1])
      expect(new Set(refs), `${label}: 只允许引用 model / cwd（其余变量在子 scope 未必注册）`)
        .toEqual(new Set(['model', 'cwd']))
    }
  })

  it('风格段不含占位符（它叠加在角色契约之后，不承担事实陈述）', () => {
    expect(CHILD_WORK_STYLE).not.toMatch(/\{\{/)
  })

  it('这一行是**事实陈述**，不得复述隔离机制（那由 corumIsolationNotice 负责）', () => {
    for (const [label, text] of CONTRACTS) {
      const line = text.split('\n').find(l => l.includes('{{model}}'))
      expect(line, `${label}: 找不到该行`).toBeDefined()
      // 不许出现「隔离 / worktree / 相对路径」这类机制措辞——那是隔离通知的职责，
      // 两处都写会在非隔离场景下说谎（非隔离时根本没有 worktree）。
      expect(line).not.toMatch(/isolat|worktree|relative path|branch/i)
    }
  })
})
