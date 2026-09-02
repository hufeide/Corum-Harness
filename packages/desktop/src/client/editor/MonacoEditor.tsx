/**
 * MonacoEditor — the corum-desktop desktop code editor surface.
 *
 * A thin React wrapper around the Monaco standalone editor, tuned for the
 * desktop shell: the worker environment is installed once (see ./worker.ts),
 * the editor is created on mount against a DOM node, and the model/theme are
 * driven by props. Phase 2 adds editable mode + content/cursor change callbacks
 * for dirty tracking and status bar.
 *
 * Model caching (2026-09-04 P0): models are keyed by file path in a module-
 * level cache and REUSED across tab switches — undo/redo stacks, cursor
 * position and scroll state survive switching away and back. External content
 * updates (file reloaded from disk / saved) reuse the model when the in-editor
 * text already matches (no-op), or apply a full-range edit so the undo stack
 * is preserved. Models are disposed only when their tab closes (the parent
 * passes the closed path list via `disposePaths`).
 *
 * Language contributions are imported for their side effects (registering
 * tokenizers/features) via the `monaco.contribution.js` subpath of each
 * language. The editor API itself comes from
 * `monaco-editor/esm/vs/editor/editor.api`,
 * NOT the full `monaco-editor` index (which pulls every language + the LSP
 * client, inflating the bundle far beyond what a desktop code view needs).
 * @module corum-desktop/client/editor/MonacoEditor
 */

import { useEffect, useRef } from 'react'
import { editor } from 'monaco-editor/editor/editor.api'
import type { editor as MonacoEditorApi } from 'monaco-editor'
import { installMonacoWorkerEnvironment } from './worker.ts'

// Side-effect language registrations: the tokenizers/features these contribute
// are what make TS/JSON/CSS/HTML files highlight and parse. Kept to the four
// the desktop shell's code surface actually opens; more can be added on demand.
// The `./*` exports subpath maps these to esm/vs/language/*/monaco.contribution.js,
// which carries no CSS (that lives in the full `monaco-editor` index), so the
// client bundle stays free of Monaco's stylesheet stack.
import 'monaco-editor/language/typescript/monaco.contribution.js'
import 'monaco-editor/language/json/monaco.contribution.js'
import 'monaco-editor/language/css/monaco.contribution.js'
import 'monaco-editor/language/html/monaco.contribution.js'

// Editor feature contributions（VS Code 体验对齐）：find/undo/multicursor 等是
// 懒加载 contribution，editor.api 子集不含，需显式 import 注册。
// 路径走 monaco exports map `./*` → `./esm/vs/*.js`（与 language contribution
// 同一模式：不写 `esm/vs/` 前缀，让 bundler 与模块表解析一致）。
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'

/** One code file shown in the editor. */
export interface MonacoFileModel {
  /** Stable identity used to key the model across content swaps. */
  readonly path: string
  /** File contents. */
  readonly value: string
  /** Language id Monaco uses (typescript/json/css/html/…). */
  readonly language: string
}

export interface MonacoEditorProps {
  /** The file to display; changes replace the model content. */
  file: MonacoFileModel
  /** Light/dark preference; maps to the corum glass Monaco themes. */
  dark?: boolean
  /** Extra class on the host element (layout/positioning). */
  className?: string
  /** Whether the editor is editable (Phase 2: true). */
  editable?: boolean
  /** Fired when the user edits content (dirty tracking). */
  onContentChange?: (value: string) => void
  /** Fired when the cursor moves (status bar line/column). */
  onCursorChange?: (pos: { line: number; column: number }) => void
  /** Paths whose models should be disposed (closed tabs). */
  disposePaths?: readonly string[]
}

/**
 * The corum liquid-glass Monaco themes (design.pen ③ 编辑器区). The editor
 * surface sits inside the glass region card, so the editor background is
 * transparent — the card's glass-1 fill shows through instead of Monaco's
 * stock solid #1e1e1e/#fffffe. Gutter/line-number/cursor colors follow the
 * design's label tokens; values are the design.pen hex (Monaco themes take
 * literal colors, not CSS variables).
 */
const CORUM_THEMES: Record<'corum-light' | 'corum-dark', MonacoEditorApi.IStandaloneThemeData> = {
  'corum-light': {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.lineHighlightBackground': '#0E0E1C08',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#8B8BA3',
      'editorLineNumber.activeForeground': '#0E0E1C',
      'editorCursor.foreground': '#5B21F5',
      'editor.foreground': '#0E0E1C',
      'editorWidget.background': '#FFFFFFCC',
      'editorWidget.border': '#FFFFFF',
      'scrollbarSlider.background': '#8B8BA333',
      'scrollbarSlider.hoverBackground': '#8B8BA355',
      'minimap.background': '#00000000',
      'minimapSlider.background': '#8B8BA322',
      'minimapSlider.hoverBackground': '#8B8BA333',
      'minimapSlider.activeBackground': '#8B8BA344',
      'editorIndentGuide.background1': '#8B8BA326',
      'editorIndentGuide.activeBackground1': '#8B8BA355',
      'editorBracketMatch.background': '#5B21F522',
      'editorBracketMatch.border': '#5B21F566',
      'editor.foldBackground': '#0E0E1C06',
      'editorGutter.foldingControlForeground': '#8B8BA3',
      'editor.findMatchBackground': '#5B21F544',
      'editor.findMatchHighlightBackground': '#5B21F522',
      'editor.findMatchBorder': '#5B21F5',
      'editor.selectionBackground': '#5B21F533',
      'editor.selectionHighlightBackground': '#5B21F522',
      'editorGhostText.foreground': '#8B8BA388',
    },
  },
  'corum-dark': {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#00000000',
      'editorGutter.background': '#00000000',
      'editor.lineHighlightBackground': '#F3ECFF0A',
      'editor.lineHighlightBorder': '#00000000',
      'editorLineNumber.foreground': '#7E719E',
      'editorLineNumber.activeForeground': '#F3ECFF',
      'editorCursor.foreground': '#01CDFE',
      'editor.foreground': '#F3ECFF',
      'editorWidget.background': '#2A1840D9',
      'editorWidget.border': '#B98CFF2E',
      'scrollbarSlider.background': '#7E719E33',
      'scrollbarSlider.hoverBackground': '#7E719E55',
      // minimap / 缩进参考线 / 括号匹配 / 折叠（corum 玻璃暗色对齐）。
      'minimap.background': '#00000000',
      'minimapSlider.background': '#7E719E22',
      'minimapSlider.hoverBackground': '#7E719E33',
      'minimapSlider.activeBackground': '#7E719E44',
      'editorIndentGuide.background1': '#7E719E26',
      'editorIndentGuide.activeBackground1': '#7E719E55',
      'editorBracketMatch.background': '#01CDFE22',
      'editorBracketMatch.border': '#01CDFE66',
      'editorBracketHighlight.foreground1': '#01CDFE',
      'editorBracketHighlight.foreground2': '#B98CFF',
      'editorBracketHighlight.foreground3': '#01FEA5',
      'editorBracketHighlight.unexpectedBracket.foreground': '#FF5B5B',
      'editor.foldBackground': '#F3ECFF08',
      'editorGutter.foldingControlForeground': '#7E719E',
      // 查找高亮。
      'editor.findMatchBackground': '#01CDFE44',
      'editor.findMatchHighlightBackground': '#01CDFE22',
      'editor.findMatchBorder': '#01CDFE',
      // 选区。
      'editor.selectionBackground': '#5B21F533',
      'editor.selectionHighlightBackground': '#5B21F522',
      // 幽灵文本（补全）。
      'editorGhostText.foreground': '#7E719E88',
    },
  },
}

/** Registered-once flag (defineTheme is global, not per-editor). */
let corumThemesDefined = false
function defineCorumThemes(): void {
  if (corumThemesDefined) return
  corumThemesDefined = true
  editor.defineTheme('corum-light', CORUM_THEMES['corum-light'])
  editor.defineTheme('corum-dark', CORUM_THEMES['corum-dark'])
}

/** Resolve a stable language id from a file path (no model guessing needed). */
export function languageFromPath(path: string, fallback: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'typescript'
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript'
    case 'json': case 'jsonc': case 'json5': return 'json'
    case 'css': case 'scss': case 'less': return 'css'
    case 'html': case 'htm': case 'xhtml': case 'vue': case 'svelte': return 'html'
    case 'md': case 'markdown': return 'markdown'
    case 'py': case 'pyi': return 'python'
    case 'yaml': case 'yml': return 'yaml'
    case 'sh': case 'bash': case 'zsh': return 'shell'
    case 'rs': return 'rust'
    case 'go': return 'go'
    case 'java': case 'kt': case 'kts': return 'java'
    case 'c': case 'h': return 'c'
    case 'cpp': case 'cc': case 'cxx': case 'hpp': case 'hh': return 'cpp'
    case 'toml': case 'ini': case 'conf': return 'ini'
    case 'xml': case 'svg': case 'plist': return 'xml'
    case 'sql': return 'sql'
    case 'lock': return 'plaintext'
    default: return fallback
  }
}

// ── Per-path model cache ────────────────────────────────────────────────────
// Models are created once per file path and reused across tab switches, so
// undo/redo history, cursor and scroll state survive. A model is disposed
// only when its tab closes (EditorColumn passes the closed paths through the
// `disposePaths` prop). Language changes re-create the model (rare: only when
// the host's language detection disagrees with the initial extension guess).
const modelCache = new Map<string, MonacoEditorApi.ITextModel>()

function acquireModel(file: MonacoFileModel): MonacoEditorApi.ITextModel {
  const cached = modelCache.get(file.path)
  if (cached !== undefined && !cached.isDisposed()) {
    if (cached.getLanguageId() !== file.language) {
      // Language re-detected (host override): re-create, undo history is lost
      // but this only happens once right after load.
      cached.dispose()
      const fresh = editor.createModel(file.value, file.language)
      modelCache.set(file.path, fresh)
      return fresh
    }
    if (cached.getValue() !== file.value) {
      // External content update (reload from disk / save normalization):
      // apply as a full-range edit so the undo stack is preserved.
      cached.pushEditOperations(
        [],
        [{ range: cached.getFullModelRange(), text: file.value }],
        () => null,
      )
    }
    return cached
  }
  const model = editor.createModel(file.value, file.language)
  modelCache.set(file.path, model)
  return model
}

function disposeModels(paths: readonly string[]): void {
  for (const path of paths) {
    const model = modelCache.get(path)
    if (model !== undefined) {
      if (!model.isDisposed()) model.dispose()
      modelCache.delete(path)
    }
  }
}

/**
 * Render a Monaco editor bound to one file model.
 * @param props - see {@link MonacoEditorProps}.
 * @returns the host div Monaco mounts into.
 */
export function MonacoEditor({ file, dark = true, className, editable = false, onContentChange, onCursorChange, disposePaths }: MonacoEditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<MonacoEditorApi.IStandaloneCodeEditor | null>(null)
  // Stable refs to callbacks so the editor is not recreated on every parent render.
  const onContentChangeRef = useRef(onContentChange)
  onContentChangeRef.current = onContentChange
  const onCursorChangeRef = useRef(onCursorChange)
  onCursorChangeRef.current = onCursorChange

  // One-time: install the worker environment before the first editor exists.
  useEffect(() => {
    installMonacoWorkerEnvironment()
  }, [])

  // Create the editor once, on the host node. Theme switches call setTheme on
  // the live instance instead of recreating it (preserves view state).
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    defineCorumThemes()
    try {
      const instance = editor.create(host, {
        value: '',
        language: 'plaintext',
        readOnly: !editable,
        automaticLayout: true,
        // minimap：VS Code 标志性代码缩略图（slider 模式滑块常驻）。
        minimap: { enabled: true, showSlider: 'always', renderCharacters: false, maxColumn: 80 },
        theme: dark ? 'corum-dark' : 'corum-light',
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        // 括号/缩进/折叠/空白字符（VS Code 默认体验对齐）。
        matchBrackets: 'always',
        bracketPairColorization: { enabled: true },
        autoClosingBrackets: 'languageDefined',
        autoClosingQuotes: 'languageDefined',
        autoIndent: 'full',
        guides: { bracketPairs: true, indentation: true },
        folding: true,
        foldingHighlight: true,
        showFoldingControls: 'always',
        renderWhitespace: 'selection',
        renderControlCharacters: true,
        // 多光标（⌥Click + ⌘⌥↑↓）。
        multiCursorModifier: 'alt',
        multiCursorMergeOverlapping: true,
        // 查找（⌘F widget 自带，无需额外配置）。
        find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection' },
        // 选择/滚动体验。
        selectOnLineNumbers: true,
        roundedSelection: false,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        smoothScrolling: true,
        // 字体/行高（对齐设计 token；JetBrains Mono 优先）。
        fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
        fontSize: 13,
        lineHeight: 20,
        letterSpacing: 0,
        // 行号/装饰。
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        glyphMargin: false,
        lineDecorationsWidth: 8,
        // 滚动条（细滑块对齐玻璃风格）。
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        // 粘贴/拖拽。
        dragAndDrop: true,
        pasteAs: { enabled: true },
        // 快速建议（输入即补全；VS Code 默认 on）。
        quickSuggestions: { other: true, comments: false, strings: false },
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'on',
        tabCompletion: 'off',
        wordBasedSuggestions: 'currentDocument',
        // 格式化（⌥⇧F 自带，register 由 language contribution 提供）。
        formatOnPaste: false,
        formatOnType: false,
      })
      editorRef.current = instance
      instance.onDidChangeModelContent(() => {
        const model = instance.getModel()
        if (model !== null) onContentChangeRef.current?.(model.getValue())
      })
      instance.onDidChangeCursorPosition((e) => {
        onCursorChangeRef.current?.({ line: e.position.lineNumber, column: e.position.column })
      })
    } catch (error) {
      console.error('[corum-desktop] monaco editor.create failed:', error)
      throw error
    }
    return () => {
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // editable is a create-time option; a change recreates the editor (never
    // happens in practice — the editor column is always editable).
  }, [editable])

  // Theme switch on the live editor (no recreation → cursor/scroll survive).
  useEffect(() => {
    defineCorumThemes()
    editor.setTheme(dark ? 'corum-dark' : 'corum-light')
  }, [dark])

  // Bind the cached per-path model to the editor (tab switch = setModel).
  useEffect(() => {
    const instance = editorRef.current
    if (instance === null) return
    const model = acquireModel(file)
    if (instance.getModel() !== model) {
      instance.setModel(model)
    }
  }, [file.path, file.value, file.language])

  // Dispose models of closed tabs.
  useEffect(() => {
    if (disposePaths !== undefined && disposePaths.length > 0) disposeModels(disposePaths)
  }, [disposePaths])

  return (
    <div
      ref={hostRef}
      className={className}
      data-monaco-editor=""
      style={{ height: '100%', minHeight: '0', width: '100%' }}
    />
  )
}
