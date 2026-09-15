/**
 * 语法高亮单测（2026-09-15 用户裁定「把官方那套抄过来」后新增）。
 *
 * 钉住三件事，防止将来被「顺手简化」改坏：
 *   ① **按行接口**：`highlightLines` 返回的数组长度必须与源码行数一致
 *      （CodeCard 是逐行渲染带行号的，多/少一行都会错位）；
 *   ② **门禁**：`supportsHighlighting` 只认白名单里的语言，其余语言返回 false、
 *      `highlightLines` 返回 undefined ⇒ 卡片回落纯文本（**仍等宽、不报错**）；
 *   ③ **颜色走主题变量**：span 的 color 是 `var(--shiki-token-*)`，
 *      不在本模块里写死 hex（颜色归主题表管，深/浅主题才都能翻转）。
 */
import { describe, expect, it } from 'vitest'
import { highlightLines, supportsHighlighting } from '../src/client/chat/highlight.ts'

describe('supportsHighlighting — 高亮门禁', () => {
  it('内建三语法及其别名 ⇒ true', () => {
    for (const lang of ['typescript', 'ts', 'tsx', 'javascript', 'js', 'jsx', 'shellscript', 'bash', 'sh', 'shell', 'zsh', 'json', 'jsonc']) {
      expect(supportsHighlighting(lang), `${lang} 应支持`).toBe(true)
    }
  })

  it('懒加载语法（首调才 import）也算支持', () => {
    for (const lang of ['python', 'py', 'rust', 'rs', 'go', 'yaml', 'yml', 'sql', 'lua']) {
      expect(supportsHighlighting(lang), `${lang} 应支持`).toBe(true)
    }
  })

  it('大小写不敏感（围栏 info string 由模型书写，大小写不定）', () => {
    expect(supportsHighlighting('TS')).toBe(true)
    expect(supportsHighlighting('Bash')).toBe(true)
  })

  it('**白名单外的语言 ⇒ false**（回落纯文本，不是报错）', () => {
    for (const lang of ['haskell', 'zig', 'elixir', 'dart', 'scala', 'perl', 'fortran', 'brainfuck']) {
      expect(supportsHighlighting(lang), `${lang} 不应支持`).toBe(false)
    }
  })

  it('无语言 / 空串 ⇒ false', () => {
    expect(supportsHighlighting(undefined)).toBe(false)
    expect(supportsHighlighting('')).toBe(false)
  })

  it('继承属性名不得被误判（围栏 info string 是模型写的，可含 constructor/__proto__）', () => {
    expect(supportsHighlighting('constructor')).toBe(false)
    expect(supportsHighlighting('__proto__')).toBe(false)
    expect(supportsHighlighting('toString')).toBe(false)
  })
})

describe('highlightLines — 按行 span（CodeCard 逐行渲染的契约）', () => {
  it('行数与源码一致（无尾随空行时不多出一行）', () => {
    const code = 'const a = 1\nconst b = 2\nconst c = 3'
    const lines = highlightLines(code, 'ts')
    expect(lines).toBeDefined()
    expect(lines).toHaveLength(3)
  })

  it('单行源码 ⇒ 一行（shiki 的尾随空行被丢弃）', () => {
    expect(highlightLines('const a = 1', 'ts')).toHaveLength(1)
  })

  it('每行的 span 文本拼接 == 该行原文（高亮不吞字符）', () => {
    const code = 'interface S {\n  readonly ok: boolean\n}'
    const lines = highlightLines(code, 'ts')
    expect(lines).toBeDefined()
    const rendered = (lines ?? []).map(line => line.map(s => s.text).join(''))
    expect(rendered).toEqual(code.split('\n'))
  })

  it('确实着色：同一行出现多种 token 颜色', () => {
    const lines = highlightLines('const n: number = 42', 'ts')
    const colors = new Set((lines?.[0] ?? []).map(s => s.style.color))
    expect(colors.size).toBeGreaterThan(1)
  })

  it('**颜色是主题变量**，不是写死的 hex（深浅主题才能翻转）', () => {
    const lines = highlightLines('const n: number = 42', 'ts')
    for (const span of lines?.[0] ?? []) {
      expect(String(span.style.color)).toMatch(/^var\(--shiki-/)
    }
  })

  it('bash / json 同样可用', () => {
    expect(highlightLines('pnpm build', 'bash')).toHaveLength(1)
    expect(highlightLines('{"a":1}', 'json')).toHaveLength(1)
  })

  it('**不支持的语言 ⇒ undefined**（调用方据此回落纯文本）', () => {
    expect(highlightLines('main = putStrLn "hi"', 'haskell')).toBeUndefined()
  })

  it('无语言 ⇒ undefined', () => {
    expect(highlightLines('whatever', undefined)).toBeUndefined()
  })
})
