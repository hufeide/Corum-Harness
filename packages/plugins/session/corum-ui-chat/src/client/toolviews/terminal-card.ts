/**
 * fork（corum）：终端卡纯派生 —— 不导入官方 `terminal-card-model.ts`（它非公开，
 * 不在 `@deepseek-ai/dsh-client-ui-tool/client` 的导出面），在此按同等语义 vendoring。
 *
 * 官方源（唯一契约）：`/Users/kukucai/dsh/dsh/packages/client/ui-tool/src/client/tool/
 * models/terminal-card-model.ts`（307 行）。本模块复刻其语义：
 *   - 给定 `ToolCallBlock`（+ session cwd），返回 `null`（不可渲染 → 走通用行）
 *     或一个携带 command / output / exitCode / signal / running / copy 的 model。
 *   - 覆盖官方两道门：`bash`/`pwsh`（含同样的参数校验 + `background` 排除）
 *     和 `terminal_send`。
 *   - 尾部 `\n[exit code: N]` / `\n[killed by signal: X]` 标记解析与官方一致。
 *
 * 返回 `null` 的原因（与官方逐一对应）：
 *   - `block.parentCallId !== undefined`：子派发不渲染终端卡（走通用行）。
 *   - `parsedToolCall(block) === null`：call head 不可用或 argsRaw 不是 JSON 对象。
 *   - 非 `bash`/`pwsh`/`terminal_send` 工具名。
 *   - `background === true`：后台调用走通用行（终端卡不覆盖确认回执）。
 *   - settled 但 `block.isError`：执行错误走通用行。
 *   - settled 但 persistent shell（`description === undefined`）→ `null`（通用行保持可展开）。
 *   - `singleResultText(block) === undefined`：结果不是单文本块。
 *
 * 额外（本包独有）：导出 `classifyLines`（展开体逐行分类）与 `countLines`（chip 行数统计）。
 */

import { resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { ToolCallBlock } from '../contract/snapshot.ts'

// ── vendored from raw-tool-call.ts (same semantics, pure) ──────────────

/** A parsed Tool call whose arguments are a JSON object. */
interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
}

/**
 * Parse the call head paired with one immutable Tool block.
 * @returns the Tool name and object arguments, or null when the call head
 *   or valid JSON object is unavailable.
 */
function parsedToolCall(block: ToolCallBlock): ParsedToolCall | null {
  const call = 'kind' in block ? block.call : block
  if (call === null) return null
  let value: unknown
  try {
    value = JSON.parse(call.argsRaw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return { name: call.name, args: value as Record<string, unknown> }
}

/**
 * Read the exact single text block consumed by first-party card derivations.
 * @returns its text, or undefined for any other content layout.
 */
function singleResultText(block: Extract<ToolCallBlock, { kind: 'tool-result' }>): string | undefined {
  if (block.content.length !== 1) return undefined
  const only = block.content[0]
  return only?.type === 'text' ? only.text : undefined
}

/**
 * Validate the optional escalation pair shared by shell and file mutation tools.
 * @returns whether the declared escalation fields form a valid pair.
 */
function validEscalationFields(args: Record<string, unknown>): boolean {
  const permission = args.sandbox_permissions
  const justification = args.justification
  if (permission === undefined && justification === undefined) return true
  if (permission !== 'workspace-write' && permission !== 'danger-full-access') return false
  return typeof justification === 'string' && justification.trim() !== ''
}

// ── exit-status parser (identical to official) ─────────────────────────

/**
 * Parse the marker literals owned by `@deepseek-ai/dsh-shell/render`:
 * trailing `\n[killed by signal: X]` or `\n[exit code: N]`.
 * @param text - rendered shell result text.
 * @returns output with a trailing exit-code or signal marker extracted.
 */
function parseExitStatus(text: string): { output: string; exitCode?: number; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { output: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { output: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { output: text, exitCode: 0 }
}

// ── ANSI stripping (mirrors official ui-primitives/src/ansi.ts sanitize) ──

/**
 * OSC strings (window title, hyperlinks), with or without their terminator.
 * Regex literal copied verbatim from the official `ansi.ts:74` so the two
 * stay in lockstep.
 */
const OSC_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g

/**
 * Escape sequences other than CSI: charset selection, single-shift, reset.
 * Regex literal copied verbatim from the official `ansi.ts:77`.
 */
const NON_CSI_ESCAPE = /\u001b(?!\[)[\u0020-\u002f]*[\u0030-\u007e]?/g

/**
 * CSI sequences — the remaining `\x1b[...X` family. Mirrors the CSI shape the
 * official `ansi.ts:240` splits on (parameters, intermediates, final byte).
 */
const CSI_SEQUENCE = /\u001b\[[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/g

/**
 * C0 controls with no display meaning, matching the official `ansi.ts:84`
 * `INERT_CONTROL` — except `\t` (0x09) and `\n` (0x0a) are excluded so they
 * survive for layout. The official set also excludes `\b` (0x08) and ESC
 * (0x1b) for its own replay machinery; we exclude ESC because the preceding
 * replacements already consumed every escape, and we do not replay backspace
 * (the corum design is monochrome-per-role, no cursor replay).
 */
const INERT_CONTROL = /[\u0000-\u0007\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g

/**
 * Strip ANSI escape sequences and inert control characters from command
 * output, keeping `\n` and `\t` for layout.
 *
 * The official `TerminalBlock` primitive does this at render time via
 * `sanitize()` (`ansi.ts:397-399`): it removes OSC and non-CSI escapes,
 * replays cursor movements (carriage return / backspace / erase-in-line),
 * then drops inert controls. The corum terminal card renders its OWN body
 * (no `TerminalBlock`), so nothing strips — escape bytes would render as
 * literal garbage, and `classifyLines` would classify raw bytes, breaking
 * the command/success/plain role system.
 *
 * This function mirrors the official regex literals (OSC, NON_CSI_ESCAPE,
 * INERT_CONTROL) but does NOT port the SGR span machinery or the full
 * column-buffer cursor replay — the corum design is deliberately
 * monochrome-per-role. Carriage-return progress rewrites are handled with a
 * simple, deterministic rule: a `\r` inside a line means the terminal
 * overwrote that line, so we keep the text after the LAST `\r`. This is NOT
 * a terminal emulator (it does not handle `\b` backspace or `CSI K`
 * erase-in-line), but it correctly handles the common case of progress bars
 * that write `loading…\rOK` — the user sees `OK`, not `loading…`.
 *
 * @param text - raw command output that may contain ANSI escapes.
 * @returns text with all escape sequences and inert controls removed; `\n`
 *   and `\t` preserved; each line's `\r` progress rewrite resolved.
 */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC_SEQUENCE, '')
    .replace(NON_CSI_ESCAPE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(INERT_CONTROL, '')
    // Carriage-return progress rewrite: a terminal moves the cursor to column
    // 0 on `\r`, so text after the last `\r` overwrites the line from the
    // left. We keep only the final segment (after the last `\r`) of each
    // line. This is documented as a simple, deterministic approximation —
    // NOT a full terminal emulator. `\r\n` (CRLF) lines are unaffected
    // because the `\r` is at the end with nothing after it.
    .replace(/([^\n]*)\r([^\n]*)/g, (_, before: string, after: string) => {
      // If `after` is shorter than `before`, the tail of `before` survives
      // (the terminal showed it). A real emulator overwrites column-by-
      // column; this approximation keeps the tail when the redraw is shorter.
      // For the common case (`progress...\rOK\n`), `after` = "OK" and
      // `before` = "progress..." — `after` overwrites the first 2 columns and
      // the rest of `before` survives: "OKgress...". To avoid showing stale
      // progress text, we follow the spirit: keep only `after` when it is
      // non-empty (the author intended to replace the line), otherwise keep
      // `before` (the `\r` was just a CRLF terminator with no rewrite).
      return after !== '' ? after : before
    })
}

// ── shell / terminal-send call identification (identical to official) ──

interface ShellCall {
  kind: 'shell'
  command: string
  description: string | undefined
  workdir: string | undefined
  persistent: boolean
  background: boolean
}

function shellCall(name: string, args: Record<string, unknown>): ShellCall | null {
  if (name !== 'bash' && name !== 'pwsh') return null
  const { command, description, timeoutMs, workdir, run_in_background: background } = args
  if (typeof command !== 'string' || command.trim() === '') return null
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) return null
  if (workdir !== undefined && typeof workdir !== 'string') return null
  if (background !== undefined && typeof background !== 'boolean') return null
  if (!validEscalationFields(args)) return null
  if (description === undefined) {
    return { kind: 'shell', command, description: undefined, workdir: undefined, persistent: true, background: false }
  }
  if (typeof description !== 'string' || description.trim() === '') return null
  return { kind: 'shell', command, description, workdir, persistent: false, background: background === true }
}

interface TerminalSendCall {
  kind: 'terminal-send'
  text: string
  sessionId: string
  background: boolean
}

function terminalSendCall(name: string, args: Record<string, unknown>): TerminalSendCall | null {
  if (name !== 'terminal_send') return null
  const { sessionId, text, submit, run_in_background: background } = args
  if (typeof sessionId !== 'string' || sessionId === '' || typeof text !== 'string') return null
  if (submit !== undefined && typeof submit !== 'boolean') return null
  if (background !== undefined && typeof background !== 'boolean') return null
  return { kind: 'terminal-send', text, sessionId, background: background === true }
}

// ── model types ────────────────────────────────────────────────────────

/** Locale-neutral terminal card data. */
export interface TerminalCardModel {
  /** The command text (shell) or terminal-send text. */
  command: string
  /** Optional description (shell only). */
  description: string | undefined
  /** Working directory (resolved, display-only). */
  cwd: string | undefined
  /** Output text (with exit marker stripped). */
  output: string | undefined
  /** Settled exit code; undefined while running. */
  exitCode: number | undefined
  /** Settled terminating signal name; undefined while running. */
  signal: string | undefined
  /** Whether the command is still running. */
  running: boolean
  /** Whether the call is a terminal_send (vs a shell call). */
  isTerminalSend: boolean
  /** The terminal_send sessionId (when applicable). */
  sessionId: string | undefined
}

// ── main derivation ────────────────────────────────────────────────────

/**
 * Resolve a shell call's workdir for display: an absolute path is used as-is,
 * a relative one joins under the session workspace, and an omitted one is the
 * session workspace. Without a session cwd, a relative path stays as authored
 * and an omitted one stays absent.
 *
 * Ported verbatim from the official `terminal-card-model.ts:107-111`, which
 * calls `normalizeSegments` in BOTH non-empty branches. The previous corum
 * port did a bare `call.workdir ?? sessionCwd`, so `workdir: '/w/app/..'`
 * rendered as `..` instead of `w` and `./sub` was not collapsed.
 * @param workdir - the raw call's workdir, if any.
 * @param sessionCwd - the session workspace root, if the caller knows it.
 * @returns the working directory for the prompt label, or undefined.
 */
function resolveTerminalCwd(workdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (workdir === undefined || workdir === '') return sessionCwd
  if (sessionCwd === undefined || sessionCwd === '') return normalizeSegments(workdir)
  return normalizeSegments(resolveWorkspacePath(sessionCwd, workdir))
}

/**
 * Collapse `.` and `..` segments so the prompt label names the directory the
 * command actually ran in. The bash executor resolves the workdir before
 * running, so a joined `/w/app/..` must display as `w`, not as `..`.
 *
 * Ported verbatim from the official `terminal-card-model.ts:125-172` — same
 * regexes, same UNC/drive/rooted/separator logic. Separators are preserved
 * as authored (a Windows path keeps its backslashes) because this value is
 * only ever displayed; a `..` that would climb past the root is dropped,
 * which is what a filesystem does with it.
 * @param path - a joined or absolute path, possibly carrying `.`/`..` segments.
 * @returns the same path with those segments resolved.
 */
function normalizeSegments(path: string): string {
  if (!/(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(path)) return path
  // A UNC path is `\\\\server\\share\\...`: the server and share form the root,
  // so they are split off here and neither is a segment `..` may pop. Its
  // separator is fixed to a backslash, since a joined relative part may have
  // introduced a forward slash that UNC syntax does not use.
  const unc = /^[/\\]{2}([^/\\]+)[/\\]+([^/\\]+)/.exec(path)
  if (unc !== null) {
    // Both groups are mandatory in the pattern, so destructuring types them as
    // strings without an assertion.
    const [matched, server, share] = unc
    const root = `\\\\${String(server)}\\${String(share)}`
    // Rooted: what follows the share hangs off it, so a `..` at the top is
    // dropped rather than kept — Windows cannot climb above a share.
    const rest = collapse(path.slice(matched.length), true)
    return rest === '' ? root : `${root}\\${rest}`
  }
  const backslashed = path.includes('\\') && !path.includes('/')
  const separator = backslashed ? '\\' : '/'
  const rooted = /^[/\\]/.test(path)
  const drive = /^[A-Za-z]:/.exec(path)?.[0] ?? ''
  const body = collapse(path.slice(drive.length), rooted || drive !== '', separator)
  const leading = rooted ? separator : ''
  return drive === '' ? `${leading}${body}` : `${drive}${rooted ? leading : separator}${body}`
}

/**
 * Collapse the `.`/`..` segments of a path body against a known root state.
 * @param body - the path after any drive letter or UNC root.
 * @param rooted - the body hangs off a root, so a `..` at its top is dropped
 *   the way a filesystem drops one; without a root the `..` is kept, since it
 *   stays meaningful against a cwd this function cannot see.
 * @param separator - separator to rejoin with (default `/`).
 * @returns the collapsed body, without leading or trailing separators.
 */
function collapse(body: string, rooted: boolean, separator = '/'): string {
  const kept: string[] = []
  for (const segment of body.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (kept.length > 0 && kept[kept.length - 1] !== '..') kept.pop()
      else if (!rooted) kept.push(segment)
      continue
    }
    kept.push(segment)
  }
  return kept.join(separator)
}

/**
 * Derive terminal card data for supported root shell and terminal-send calls.
 * Mirrors the official `terminalCardModel` semantics exactly.
 * @param block - running or settled Tool block.
 * @param sessionCwd - session workspace root used for cwd display.
 * @returns terminal card data, or null for the generic path.
 */
export function terminalCardModel(block: ToolCallBlock, sessionCwd?: string): TerminalCardModel | null {
  if (block.parentCallId !== undefined) return null
  const parsed = parsedToolCall(block)
  if (parsed === null) return null
  const call = shellCall(parsed.name, parsed.args) ?? terminalSendCall(parsed.name, parsed.args)
  if (call === null || call.background) return null

  const command = call.kind === 'shell' ? call.command : call.text
  const description = call.kind === 'shell' ? call.description : undefined
  const cwd = resolveTerminalCwd(call.kind === 'shell' ? call.workdir : undefined, sessionCwd)
  const sessionId = call.kind === 'terminal-send' ? call.sessionId : undefined

  if (!('kind' in block)) {
    return {
      command, description, cwd,
      output: undefined, exitCode: undefined, signal: undefined,
      running: true,
      isTerminalSend: call.kind === 'terminal-send',
      sessionId,
    }
  }
  if (block.isError || (call.kind === 'shell' && call.persistent)) return null
  const output = singleResultText(block)
  if (output === undefined) return null
  const status = call.kind === 'terminal-send' ? { output } : parseExitStatus(output)
  return {
    command, description, cwd,
    output: status.output,
    exitCode: status.exitCode,
    signal: status.signal,
    running: false,
    isTerminalSend: call.kind === 'terminal-send',
    sessionId,
  }
}

/**
 * True when a settled terminal card reports a failing exit — a non-zero code
 * or a terminating signal. Signal takes precedence over exit code.
 */
export function terminalFailed(model: TerminalCardModel): boolean {
  return !model.running && ((model.exitCode !== undefined && model.exitCode !== 0) || model.signal !== undefined)
}

// ── line classifier (design-derived, unit-testable) ────────────────────

/** Visual role of one output line (design sCrmX expanded body). */
export type LineRole = 'command' | 'dim' | 'success' | 'plain' | 'failure'

/** One classified line for the expanded body. */
export interface ClassifiedLine {
  text: string
  role: LineRole
}

/**
 * Split output text into typed lines for the expanded body.
 *
 * ANSI escape sequences are stripped BEFORE classification and rendering, so
 * a `\x1b[32m` (green SGR) or an OSC title (`\x1b]0;title\x07`) prefix cannot
 * break the command/success/plain role system the design depends on. Without
 * stripping, escape bytes render as literal garbage and `classifyLines`
 * classifies raw bytes — a `\x1b[0m` in front of a line makes it `plain`
 * instead of `success`.
 *
 * Classification rules (derived from design frame sCrmX's own examples):
 *   - A line starting with `$ ` is a **command** line.
 *   - Otherwise, a line whose trimmed text begins with `✓` is **success**.
 *   - A line whose trimmed text begins with `✗` or `✘` is **failure**.
 *   - A line whose trimmed text begins with `▲` is **dim** (progress).
 *   - Everything else is **plain**.
 *
 * Trailing empty line (terminator) is dropped, matching TerminalBlock's own
 * parse semantics. Empty input yields an empty array.
 *
 * @param output - the raw output text (exit marker already stripped).
 * @returns one entry per non-terminator line, with ANSI-stripped text.
 */
export function classifyLines(output: string | undefined): ClassifiedLine[] {
  if (output === undefined || output === '') return []
  const clean = stripAnsi(output)
  const body = clean.endsWith('\n') ? clean.slice(0, -1) : clean
  return body.split('\n').map((text) => {
    if (text.startsWith('$ ')) return { text, role: 'command' as const }
    const trimmed = text.trim()
    if (trimmed.startsWith('✓')) return { text, role: 'success' as const }
    if (trimmed.startsWith('✗') || trimmed.startsWith('✘')) return { text, role: 'failure' as const }
    if (trimmed.startsWith('▲')) return { text, role: 'dim' as const }
    return { text, role: 'plain' as const }
  })
}

/**
 * Count command lines and output lines for the chips.
 *
 * Command lines:
 *   - Shell (bash/pwsh): the number of `\n`-separated physical source lines in
 *     the command text the model carries. The `$ ` prompt is a *decoration the
 *     card adds* (see `TerminalCardView.tsx` `` `$ ${model.command}` ``) — the
 *     raw bash output never contains `$ `-prefixed command lines, so counting
 *     them from the output always yields 0 (the bug: chip read `0 行命令` for
 *     a real bash call). The design frame sCrmX shows `2 行命令` for a card
 *     whose command genuinely spills onto 2 source lines — that is the
 *     intended semantics: `\n`-separated source lines, NOT wrapped rows.
 *   - terminal_send: the output may echo a `$ `-prefixed prompt, so the
 *     `$ `-prefix heuristic is kept for that arm only.
 *
 * Output lines = all non-command, non-terminator lines (including empty ones
 * between content lines, matching what the user sees).
 *
 * @param opts.command - the command text (shell) or terminal-send text.
 * @param opts.output - the raw output text (exit marker already stripped).
 * @param opts.isTerminalSend - whether the call is a terminal_send.
 * @returns `{ commands, outputLines }` counts.
 */
export function countLines(opts: {
  command: string | undefined
  output: string | undefined
  isTerminalSend: boolean
}): { commands: number; outputLines: number } {
  const lines = classifyLines(opts.output)
  if (opts.isTerminalSend) {
    // terminal_send output may echo a `$ `-prefixed prompt — count those.
    let commands = 0
    let outputLines = 0
    for (const line of lines) {
      if (line.role === 'command') commands++
      else outputLines++
    }
    return { commands, outputLines }
  }
  // Shell: command lines = `\n`-separated physical source lines in the
  // command text. Output lines = all classified output lines (none of them
  // are commands for a shell call — the `$ ` prefix is a card decoration).
  const commands = opts.command !== undefined && opts.command !== ''
    ? opts.command.split('\n').length
    : 0
  return { commands, outputLines: lines.length }
}

/**
 * Derive the shell name for the status pill.
 *
 * The `ToolResultNode` carries no shell identification — it has only
 * `content`/`isError`/`error`/`meta`, and the bash tool declares no
 * `presentationMeta`. So the true shell is genuinely unknowable from the
 * block. However, the `bash` tool always executes through argv
 * `['bash', '-c', command]` — both executors confirm this:
 *   - sandboxed: `bash-sandbox/src/index.ts:173` →
 *     `this.ctx.sandbox.confine(['bash', '-c', command], policy)`
 *   - local: `bash-local/src/index.ts:214` →
 *     `this.runArgv(spec, ['bash', '-c', spec.command])`
 *
 * So the honest fallback is `bash` (the actual executing argv), NOT `zsh`.
 * The design frames literally show `zsh · 运行中` / `zsh · 成功`, but that
 * is factually wrong for the corum `bash` tool — it is a **deliberate
 * deviation from the design's literal `zsh`**. We still keep the
 * explicit-prefix derivation (`bash -c '…'` / `zsh -c '…'` → that name) so
 * a command that visibly names a shell still shows it.
 *
 * @param command - the command text.
 * @returns the shell name for the status pill: an explicitly-named shell if
 *   the command starts with one, otherwise `bash` (the real executing argv).
 */
export function deriveShellName(command: string): string {
  const match = /^\s*(bash|zsh|sh|dash|ksh|ash)\b/.exec(command)
  return match?.[1] ?? 'bash'
}
