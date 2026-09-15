/**
 * fence-split.ts 纯模块测试（2026-09-15）。
 *
 * 测的是 fork（corum）在顶层代码围栏处拆分助手 markdown 的纯函数 splitFences。
 * 设计契约：只有顶层 code 节点走 CodeCard；任何会让脚注/引用/表格/html/math
 * 或嵌套 code 跨段断裂的情况 → bail-out（整段走官方 MarkdownText）。
 * 用真正的 mdast 解析（不是行正则），所以波浪围栏、>3 反引号围栏、缩进代码块、
 * 围栏内含三反引号等边界都要正确处理。
 */
import { describe, expect, it } from 'vitest'
import { splitFences } from '../src/client/chat/fence-split.ts'

describe('splitFences — 无围栏 / bail-out', () => {
  it('无围栏 → plain', () => {
    const result = splitFences('hello world\n\nno code here')
    expect(result.kind).toBe('plain')
  })

  it('纯文本（含行内 code）→ plain', () => {
    const result = splitFences('this is `inline` code')
    expect(result.kind).toBe('plain')
  })

  it('列表项中的 code → plain（嵌套 code bail-out）', () => {
    const md = '- item\n\n  ```bash\n  echo x\n  ```\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('引用块中的 code → plain（嵌套 code bail-out）', () => {
    const md = '> ```bash\n> echo x\n> ```\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('```math 围栏 → plain', () => {
    const md = '```math\nx^2 + y^2\n```\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('脚注引用 → plain', () => {
    const md = 'text with footnote[^1]\n\n[^1]: footnote def\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('脚注定义 → plain', () => {
    const md = 'text\n\n[^1]: footnote def\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('引用式链接定义 → plain', () => {
    const md = '[ref]: https://example.com\n\ntext\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('表格 → plain', () => {
    const md = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    expect(splitFences(md).kind).toBe('plain')
  })

  it('html 节点 → plain', () => {
    const md = '<div>raw html</div>\n'
    expect(splitFences(md).kind).toBe('plain')
  })
})

describe('splitFences — 正常拆分', () => {
  it('单个简单围栏 → split，code body 和 lang 正确', () => {
    const md = '```bash\necho hello\n```'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    expect(result.segments).toHaveLength(1)
    const seg = result.segments[0]
    expect(seg?.kind).toBe('code')
    if (seg?.kind !== 'code') return
    expect(seg.code).toBe('echo hello')
    expect(seg.lang).toBe('bash')
  })

  it('无语言的围栏 → split，lang = undefined', () => {
    const md = '```\nplain code\n```'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    const seg = result.segments[0]
    expect(seg?.kind).toBe('code')
    if (seg?.kind !== 'code') return
    expect(seg.code).toBe('plain code')
    expect(seg.lang).toBeUndefined()
  })

  it('波浪围栏 → split', () => {
    const md = '~~~bash\necho tilde\n~~~'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    const seg = result.segments[0]
    expect(seg?.kind).toBe('code')
    if (seg?.kind !== 'code') return
    expect(seg.code).toBe('echo tilde')
    expect(seg.lang).toBe('bash')
  })

  it('四反引号围栏内含三反引号 → 一个 code 段，内部反引号完好', () => {
    const inner = '```\nnested\n```'
    const md = '````bash\n' + inner + '\n````'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    expect(result.segments).toHaveLength(1)
    const seg = result.segments[0]
    expect(seg?.kind).toBe('code')
    if (seg?.kind !== 'code') return
    expect(seg.code).toBe(inner)
    expect(seg.lang).toBe('bash')
  })

  it('缩进代码块 → split，lang = undefined', () => {
    const md = '    indented code\n'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    const seg = result.segments[0]
    expect(seg?.kind).toBe('code')
    if (seg?.kind !== 'code') return
    expect(seg.lang).toBeUndefined()
  })

  it('围栏前有文本 → 第一个段是 markdown', () => {
    const md = 'before text\n\n```bash\necho x\n```'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]?.kind).toBe('markdown')
  })

  it('围栏后有文本 → 最后一个段是 markdown', () => {
    const md = '```bash\necho x\n```\n\nafter text'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    const last = result.segments[result.segments.length - 1]
    expect(last?.kind).toBe('markdown')
  })

  it('围栏前后都有文本 → 恰好 3 段，顺序 markdown/code/markdown', () => {
    const md = 'before\n\n```bash\necho x\n```\n\nafter'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    expect(result.segments).toHaveLength(3)
    expect(result.segments[0]?.kind).toBe('markdown')
    expect(result.segments[1]?.kind).toBe('code')
    expect(result.segments[2]?.kind).toBe('markdown')
  })

  it('多行代码体的行数正确', () => {
    const md = '```bash\nline1\nline2\nline3\n```'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    const seg = result.segments[0]
    expect(seg?.kind).toBe('code')
    if (seg?.kind !== 'code') return
    expect(seg.code.split('\n')).toHaveLength(3)
  })

  it('不丢源文本：markdown 段原文完整 + code 段 value 在原文中', () => {
    const md = 'before\n\n```bash\necho x\n```\n\nmiddle\n\n```python\nprint("y")\n```\n\nafter'
    const result = splitFences(md)
    expect(result.kind).toBe('split')
    if (result.kind !== 'split') return
    // 非代码段（markdown）的 text 是从原文切片，内容必须逐字存在于原文。
    const mdSegs = result.segments.filter(s => s.kind === 'markdown')
    for (const seg of mdSegs) {
      if (seg.kind === 'markdown') {
        expect(md).toContain(seg.text)
      }
    }
    // 代码段的 code（= node.value）必须逐字存在于原文。
    const codeSegs = result.segments.filter(s => s.kind === 'code')
    for (const seg of codeSegs) {
      if (seg.kind === 'code') {
        expect(md).toContain(seg.code)
      }
    }
    // 段序：markdown, code, markdown, code, markdown
    expect(result.segments).toHaveLength(5)
    expect(result.segments.map(s => s.kind)).toEqual(['markdown', 'code', 'markdown', 'code', 'markdown'])
  })
})
