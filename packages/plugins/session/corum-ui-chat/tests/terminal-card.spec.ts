/**
 * 终端卡纯派生测试（2026-09-15）。
 *
 * 数据契约：vendored `terminal-card.ts` 复刻官方 `terminal-card-model.ts` 语义。
 * 覆盖：settled clean exit → model；non-zero exit → failure；signal kill → signal
 * 优先；running → running 无 output；terminal_send；background bash → null；
 * 非法/空 command → null；exit-marker 三变体；行分类器（设计五例）；行数统计。
 *
 * 警告（本仓曾踩）：无效的 Chai 断言（如 `expect(x).startsWith(...)`）会导致
 * 整个测试文件加载失败、静默跑零条断言。此处只用 toBe / toEqual / toMatchObject /
 * toBeUndefined / toHaveLength / toContain。
 */
import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '../src/client/contract/snapshot.ts'
import {
  classifyLines, countLines, deriveShellName, stripAnsi, terminalCardModel, terminalFailed,
} from '../src/client/toolviews/terminal-card.ts'

// ── fixture builders ───────────────────────────────────────────────────

function runningBash(command: string, description = 'test'): ToolCallBlock {
  return {
    callId: 'call-1',
    name: 'bash',
    argsRaw: JSON.stringify({ command, description }),
    turn: 1,
    step: 1,
    time: 0,
    subCalls: [],
  }
}

function settledBash(command: string, output: string, isError = false, description = 'test'): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'call-1',
    call: { name: 'bash', argsRaw: JSON.stringify({ command, description }) },
    callTime: null,
    content: [{ type: 'text', text: output }],
    isError,
    subCalls: [],
  }
}

function settledTerminalSend(text: string, output: string, sessionId = 'pty-1'): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 0,
    callId: 'call-2',
    call: { name: 'terminal_send', argsRaw: JSON.stringify({ sessionId, text }) },
    callTime: null,
    content: [{ type: 'text', text: output }],
    isError: false,
    subCalls: [],
  }
}

// ── terminalCardModel ──────────────────────────────────────────────────

describe('terminalCardModel — settled bash', () => {
  it('clean exit → model 含正确的 command/output/exitCode=0', () => {
    const block = settledBash('echo hello', 'hello\n[exit code: 0]')
    const model = terminalCardModel(block, '/workspace')
    expect(model).not.toBeNull()
    expect(model?.command).toBe('echo hello')
    expect(model?.output).toBe('hello')
    expect(model?.exitCode).toBe(0)
    expect(model?.signal).toBeUndefined()
    expect(model?.running).toBe(false)
    expect(model?.isTerminalSend).toBe(false)
  })

  it('non-zero exit → failure（exitCode=1）', () => {
    const block = settledBash('false', 'some output\n[exit code: 1]')
    const model = terminalCardModel(block, '/workspace')
    expect(model).not.toBeNull()
    expect(model?.exitCode).toBe(1)
    expect(model?.output).toBe('some output')
    expect(terminalFailed(model!)).toBe(true)
  })

  it('signal kill → signal 字段优先于 exitCode', () => {
    const block = settledBash('sleep 999', 'partial output\n[killed by signal: SIGTERM]')
    const model = terminalCardModel(block, '/workspace')
    expect(model).not.toBeNull()
    expect(model?.signal).toBe('SIGTERM')
    expect(model?.exitCode).toBeUndefined()
    expect(terminalFailed(model!)).toBe(true)
  })
})

describe('terminalCardModel — running', () => {
  it('running block → running=true，output=undefined', () => {
    const block = runningBash('sleep 5')
    const model = terminalCardModel(block, '/workspace')
    expect(model).not.toBeNull()
    expect(model?.running).toBe(true)
    expect(model?.output).toBeUndefined()
    expect(model?.exitCode).toBeUndefined()
    expect(model?.signal).toBeUndefined()
  })
})

describe('terminalCardModel — terminal_send', () => {
  it('terminal_send 块 → model 含 text 作 command、isTerminalSend=true', () => {
    const block = settledTerminalSend('echo hi', 'hi\n')
    const model = terminalCardModel(block, '/workspace')
    expect(model).not.toBeNull()
    expect(model?.command).toBe('echo hi')
    expect(model?.isTerminalSend).toBe(true)
    expect(model?.sessionId).toBe('pty-1')
    expect(model?.output).toBe('hi\n')
    // terminal_send 不解析 exit marker
    expect(model?.exitCode).toBeUndefined()
  })
})

describe('terminalCardModel — null 路径', () => {
  it('background bash → null', () => {
    const block = settledBash('sleep 100', 'background started\n[exit code: 0]')
    // 改 argsRaw 加 run_in_background
    const blockBg: ToolCallBlock = {
      ...block,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'sleep 100', description: 'bg', run_in_background: true }) },
    }
    expect(terminalCardModel(blockBg, '/workspace')).toBeNull()
  })

  it('空 command → null', () => {
    const block = settledBash('', '\n[exit code: 0]')
    expect(terminalCardModel(block, '/workspace')).toBeNull()
  })

  it('非 bash/pwsh/terminal_send 工具 → null', () => {
    const block: ToolCallBlock = {
      kind: 'tool-result',
      seq: 1,
      time: 0,
      callId: 'call-3',
      call: { name: 'grep', argsRaw: JSON.stringify({ pattern: 'x' }) },
      callTime: null,
      content: [{ type: 'text', text: 'result' }],
      isError: false,
      subCalls: [],
    }
    expect(terminalCardModel(block)).toBeNull()
  })

  it('isError=true → null', () => {
    const block = settledBash('bad', 'error text', true)
    expect(terminalCardModel(block, '/workspace')).toBeNull()
  })

  it('子派发（parentCallId 存在）→ null', () => {
    const block = settledBash('echo x', 'x\n[exit code: 0]')
    const childBlock: ToolCallBlock = { ...block, parentCallId: 'parent-1' }
    expect(terminalCardModel(childBlock, '/workspace')).toBeNull()
  })
})

describe('exit-marker 解析三变体', () => {
  it('exit code 标记 → 正确提取 exitCode', () => {
    const block = settledBash('true', 'done\n[exit code: 42]')
    const model = terminalCardModel(block)
    expect(model?.exitCode).toBe(42)
    expect(model?.output).toBe('done')
  })

  it('signal 标记 → 正确提取 signal', () => {
    const block = settledBash('kill $$', 'going down\n[killed by signal: SIGKILL]')
    const model = terminalCardModel(block)
    expect(model?.signal).toBe('SIGKILL')
    expect(model?.output).toBe('going down')
  })

  it('无标记 → 默认 exitCode=0', () => {
    const block = settledBash('echo hi', 'hi')
    const model = terminalCardModel(block)
    expect(model?.exitCode).toBe(0)
    expect(model?.signal).toBeUndefined()
    expect(model?.output).toBe('hi')
  })
})

// ── classifyLines ──────────────────────────────────────────────────────

describe('classifyLines — 设计五例', () => {
  it('command 行（$ 前缀）→ command', () => {
    const lines = classifyLines('$ pnpm build')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.role).toBe('command')
    expect(lines[0]?.text).toBe('$ pnpm build')
  })

  it('success 行（✓ 前缀）→ success', () => {
    const lines = classifyLines('  ✓ build succeeded')
    expect(lines[0]?.role).toBe('success')
  })

  it('dim/progress 行（▲ 前缀）→ dim', () => {
    const lines = classifyLines('  ▲ building client bundle…')
    expect(lines[0]?.role).toBe('dim')
  })

  it('plain 行 → plain', () => {
    const lines = classifyLines('  some regular output')
    expect(lines[0]?.role).toBe('plain')
  })

  it('failure 行（✗ 前缀）→ failure', () => {
    const lines = classifyLines('  ✗ test failed')
    expect(lines[0]?.role).toBe('failure')
  })
})

// ── countLines ─────────────────────────────────────────────────────────

describe('countLines — chip 行数统计', () => {
  it('单行 shell 命令 → commands=1', () => {
    const result = countLines({ command: 'pnpm build', output: undefined, isTerminalSend: false })
    expect(result.commands).toBe(1)
    expect(result.outputLines).toBe(0)
  })

  it('含字面 \\n 的 shell 命令（两物理行）→ commands=2', () => {
    const cmd = 'echo a\necho b'
    const result = countLines({ command: cmd, output: 'a\nb', isTerminalSend: false })
    expect(result.commands).toBe(2)
    expect(result.outputLines).toBe(2)
  })

  it('空/undefined 命令 → commands=0（不崩）', () => {
    expect(countLines({ command: undefined, output: 'x\ny', isTerminalSend: false })).toEqual({ commands: 0, outputLines: 2 })
    expect(countLines({ command: '', output: 'x\ny', isTerminalSend: false })).toEqual({ commands: 0, outputLines: 2 })
  })

  it('output 行数 = 非命令非终止符行（含空行），与今天一致', () => {
    const output = 'line1\n\nline3'
    const result = countLines({ command: 'x', output, isTerminalSend: false })
    expect(result.commands).toBe(1)
    expect(result.outputLines).toBe(3)
  })

  it('两命令 + 三输出行（terminal_send $ 前缀启发式仍有效）→ commands=2, outputLines=3', () => {
    const output = '$ pnpm build\n  ▲ building…\n  ✓ done\n$ pnpm test\n  ✓ tests pass'
    const result = countLines({ command: 'irrelevant', output, isTerminalSend: true })
    expect(result.commands).toBe(2)
    expect(result.outputLines).toBe(3)
  })

  it('空 output（terminal_send）→ commands=0, outputLines=0', () => {
    const result = countLines({ command: undefined, output: undefined, isTerminalSend: true })
    expect(result.commands).toBe(0)
    expect(result.outputLines).toBe(0)
  })

  it('仅命令无输出（terminal_send）→ outputLines=0', () => {
    const result = countLines({ command: undefined, output: '$ echo hi', isTerminalSend: true })
    expect(result.commands).toBe(1)
    expect(result.outputLines).toBe(0)
  })
})

// ── stripAnsi ──────────────────────────────────────────────────────────

describe('stripAnsi — ANSI 转义剥离', () => {
  it('干净字符串 → 原样返回（identity）', () => {
    expect(stripAnsi('hello world\nsecond line')).toBe('hello world\nsecond line')
  })

  it('SGR 绿色前缀 → 剥离后行仍按 success 分类', () => {
    const raw = '\x1b[32m  ✓ build succeeded\x1b[0m'
    const lines = classifyLines(raw)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.role).toBe('success')
    expect(lines[0]?.text).toBe('  ✓ build succeeded')
  })

  it('OSC title sequence → 被移除', () => {
    const raw = '\x1b]0;window title\x07actual output'
    expect(stripAnsi(raw)).toBe('actual output')
  })

  it('OSC title with ESC backslash terminator → 被移除', () => {
    const raw = '\x1b]0;title\x1b\\actual output'
    expect(stripAnsi(raw)).toBe('actual output')
  })

  it('\\r progress rewrite → 保留最后一段', () => {
    const raw = 'loading...\rOK'
    expect(stripAnsi(raw)).toBe('OK')
  })

  it('\\r with nothing after (CRLF) → 保留 before', () => {
    const raw = 'line1\r\nline2'
    expect(stripAnsi(raw)).toBe('line1\nline2')
  })

  it('\\n 和 \\t 保留', () => {
    const raw = 'col1\tcol2\nrow2\tcol2'
    expect(stripAnsi(raw)).toBe('col1\tcol2\nrow2\tcol2')
  })

  it('CSI 序列（光标移动、SGR）被剥离', () => {
    const raw = '\x1b[2K\x1b[1;31merror\x1b[0m'
    expect(stripAnsi(raw)).toBe('error')
  })

  it('多行带 ANSI → 每行都剥离', () => {
    const raw = '\x1b[32m✓ ok\x1b[0m\n\x1b[31m✗ fail\x1b[0m'
    const lines = classifyLines(raw)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.role).toBe('success')
    expect(lines[0]?.text).toBe('✓ ok')
    expect(lines[1]?.role).toBe('failure')
    expect(lines[1]?.text).toBe('✗ fail')
  })

  it('inert control characters（除 \\n \\t）被删除', () => {
    const raw = 'a\x00b\x07c\x0bd'
    expect(stripAnsi(raw)).toBe('abcd')
  })
})

// ── classifyLines with ANSI ─────────────────────────────────────────────

describe('classifyLines — ANSI 剥离后分类', () => {
  it('SGR 前缀的 command 行 → command', () => {
    const lines = classifyLines('\x1b[36m$ pnpm build\x1b[0m')
    expect(lines[0]?.role).toBe('command')
    expect(lines[0]?.text).toBe('$ pnpm build')
  })

  it('OSC title + SGR 的 success 行 → success', () => {
    const raw = '\x1b]0;build\x07\x1b[32m  ✓ done\x1b[0m'
    const lines = classifyLines(raw)
    expect(lines[0]?.role).toBe('success')
    expect(lines[0]?.text).toBe('  ✓ done')
  })
})

// ── normalizeSegments (via terminalCardModel cwd) ──────────────────────

describe('resolveTerminalCwd — 路径规范化', () => {
  it('workdir 含 ../ → 折叠到正确目录', () => {
    const base = settledBash('echo x', 'x\n[exit code: 0]')
    const block: ToolCallBlock = {
      ...base,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo x', description: 'test', workdir: '/w/app/..' }) },
    }
    const model = terminalCardModel(block, '/w/app')
    expect(model?.cwd).toBe('/w')
  })

  it('workdir 含 ./ → 折叠', () => {
    const base = settledBash('echo x', 'x\n[exit code: 0]')
    const block: ToolCallBlock = {
      ...base,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo x', description: 'test', workdir: './sub' }) },
    }
    const model = terminalCardModel(block, '/w/app')
    expect(model?.cwd).toBe('/w/app/sub')
  })

  it('绝对 workdir 含 session cwd → 正确 normalize', () => {
    const base = settledBash('echo x', 'x\n[exit code: 0]')
    const block: ToolCallBlock = {
      ...base,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo x', description: 'test', workdir: '/w/app/..' }) },
    }
    const model = terminalCardModel(block, '/w/app')
    expect(model?.cwd).toBe('/w')
  })

  it('相对 workdir 相对 session cwd 解析', () => {
    const base = settledBash('echo x', 'x\n[exit code: 0]')
    const block: ToolCallBlock = {
      ...base,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo x', description: 'test', workdir: 'sub' }) },
    }
    const model = terminalCardModel(block, '/w/app')
    expect(model?.cwd).toBe('/w/app/sub')
  })

  it('workdir 为空 → sessionCwd', () => {
    const base = settledBash('echo x', 'x\n[exit code: 0]')
    const block: ToolCallBlock = {
      ...base,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo x', description: 'test', workdir: '' }) },
    }
    const model = terminalCardModel(block, '/w/app')
    expect(model?.cwd).toBe('/w/app')
  })

  it('workdir undefined → sessionCwd', () => {
    const block = settledBash('echo x', 'x\n[exit code: 0]')
    const model = terminalCardModel(block, '/w/app')
    expect(model?.cwd).toBe('/w/app')
  })

  it('workdir 有但 sessionCwd 无 → normalizeSegments(workdir)', () => {
    const base = settledBash('echo x', 'x\n[exit code: 0]')
    const block: ToolCallBlock = {
      ...base,
      call: { name: 'bash', argsRaw: JSON.stringify({ command: 'echo x', description: 'test', workdir: '/w/app/..' }) },
    }
    const model = terminalCardModel(block, undefined)
    expect(model?.cwd).toBe('/w')
  })
})

// ── deriveShellName ─────────────────────────────────────────────────────

describe('deriveShellName — shell 名派生', () => {
  it('普通命令 → bash（不是 zsh）', () => {
    expect(deriveShellName('echo hello')).toBe('bash')
  })

  it('bash -c 显式前缀 → bash', () => {
    expect(deriveShellName("bash -c 'echo x'")).toBe('bash')
  })

  it('zsh -c 显式前缀 → zsh', () => {
    expect(deriveShellName("zsh -c 'echo x'")).toBe('zsh')
  })

  it('sh -c 显式前缀 → sh', () => {
    expect(deriveShellName("sh -c 'echo x'")).toBe('sh')
  })

  it('pnpm build → bash（回退）', () => {
    expect(deriveShellName('pnpm build')).toBe('bash')
  })

  it('空命令 → bash（回退）', () => {
    expect(deriveShellName('')).toBe('bash')
  })
})
