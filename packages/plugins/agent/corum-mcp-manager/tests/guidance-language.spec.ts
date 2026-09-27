/**
 * MCP 指引段的**语言门禁**（2026-09-27 举一反三扫出）。
 *
 * 本仓纪律：模型可见提示词一律英文（用户 2026-09-10 定调）。`prompt-language.spec.ts` 覆盖了
 * CONDUCTOR_PERSONA / 内置角色 / AGENTS.md 模板 / 润色翻译提示词 / 编排机制段，**但漏了本文件**，
 * 于是包装文本长期是中文（`## MCP 工具使用指导：…` / `本会话已接入 MCP 服务 …` / `（使用指导过长已截断）`）。
 * 包装归我们，正文归用户/服务作者（不重写、不翻译）——本组把这条边界也钉住。
 */
import { describe, expect, it } from 'vitest'
import { MCP_GUIDANCE_MAX_CHARS, mcpGuidanceSectionText } from '../src/mcp-guidance.ts'

const CJK = /[\u4e00-\u9fff]/

describe('MCP 指引段：包装英文 + 正文原样', () => {
  it('包装文本无 CJK（标题 / 接入说明 / 上手要点）', () => {
    const text = mcpGuidanceSectionText('demo', 'call `tools.demo()` with the id')
    expect(text).not.toMatch(CJK)
    expect(text).toContain('## MCP tool usage: demo')
    expect(text).toContain('mcp__demo__<tool>')
    expect(text).toContain('How to use it:')
  })

  it('截断提示也是英文，且正文按上限截断', () => {
    const long = 'x'.repeat(MCP_GUIDANCE_MAX_CHARS + 100)
    const text = mcpGuidanceSectionText('demo', long)
    expect(text).not.toMatch(CJK)
    expect(text).toContain('guidance truncated')
    expect(text).toContain('x'.repeat(MCP_GUIDANCE_MAX_CHARS))
  })

  it('正文原样引用：用户/服务作者写什么就是什么（含中文时也不翻译）', () => {
    const authored = '使用 `demo.run` 前先调用 `demo.init`。'
    const text = mcpGuidanceSectionText('demo', authored)
    expect(text).toContain(authored)
    // 正文有 CJK ⇒ 整段当然有 CJK，但那是内容不是包装：去掉正文后包装必须干净。
    const wrapper = text.replace(authored, '')
    expect(wrapper).not.toMatch(CJK)
  })

  it('空 guidance ⇒ 空串（调用方据此不注入该段）', () => {
    expect(mcpGuidanceSectionText('demo', '   ')).toBe('')
  })
})
