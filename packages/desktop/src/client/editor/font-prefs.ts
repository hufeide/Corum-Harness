/**
 * fork（corum）：编辑器 / 终端「字面」偏好的 cordis 服务（PRD v2 §4.23 E1/E2/E3、
 * §4.2 乙类；§5 剩余项 3）。
 *
 * 背景：编辑器字号/字族/行高、终端字号/字族此前**硬编码**在消费方
 * （Monaco `MonacoEditor.tsx:234-236`、xterm `BottomPanel.tsx:76-77`），设置页
 * 标注未上线。真源与消费方**跨 bundle**（Monaco 在 desktop、xterm 在
 * corum-ide-panel-bottom-ui、设置页在 corum-ide-ui）⇒ 必须是 cordis 服务
 * （红线 1：root reflect.store 保证跨 bundle 单例），localStorage 方案在跨
 * bundle 下不实时联动（已实测），故只作持久化镜像，不作共享通道。
 *
 * 设计（与 notifications prefs 同范式）：
 *   - 模块保持 cordis-free（纯库纪律）：createFontPrefs() 返回纯 store，
 *     Context 合并与 provide 由 client/index.ts 侧声明。
 *   - 消费方（Monaco / xterm）经 inject 拿到同一实例，subscribe 后
 *     `updateOptions` 实时生效——**字号/字族/行高均实测对 updateOptions 有效**，
 *     无需重建编辑器（区别于 diff 布局等布局类选项）。
 *   - 持久化单键 JSON（用户裁定）：`corum.fontPrefs`，逐字段校验回退缺省。
 *
 * 默认值**严格对齐现状硬编码**（上线即不改变用户观感，PRD §6.1 不伪造状态）：
 *   编辑器 fontSize 13 / fontFamily 'JetBrains Mono' 栈 / lineHeight 20；
 *   终端   fontSize 13 / fontFamily 'JetBrains Mono' 栈。
 * @module corum-desktop/client/editor/font-prefs
 */

/** 编辑器字面（Monaco create/updateOptions 直接消费的子集）。 */
export interface EditorFontPrefs {
  fontSize: number
  fontFamily: string
  lineHeight: number
}

/** 终端字面（xterm create/updateOptions 直接消费的子集）。 */
export interface TerminalFontPrefs {
  fontSize: number
  fontFamily: string
}

/** 字面偏好快照（编辑器 + 终端两组）。 */
export interface FontPrefs {
  editor: EditorFontPrefs
  terminal: TerminalFontPrefs
}

/** 现状硬编码缺省值（Monaco `MonacoEditor.tsx:234-236` 原值）。 */
const DEFAULT_EDITOR: EditorFontPrefs = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
  lineHeight: 20,
}

/** 现状硬编码缺省值（xterm `BottomPanel.tsx:76-77` 原值）。 */
const DEFAULT_TERMINAL: TerminalFontPrefs = {
  fontSize: 13,
  fontFamily: "'JetBrains Mono', 'SFMono-Regular', 'Menlo', monospace",
}

const DEFAULT_PREFS: FontPrefs = { editor: DEFAULT_EDITOR, terminal: DEFAULT_TERMINAL }

/** 持久化键（用户裁定：单键一个 JSON，与通知 prefs 一致）。 */
const FONT_PREFS_KEY = 'corum.fontPrefs'

/** 数值字段校验：有限正数才采纳，否则回落缺省。 */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}

/** 字族字段校验：非空字符串才采纳（允许完整自定义栈），否则回落缺省。 */
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback
}

/** 读持久化的字面偏好（异常数据逐字段回退缺省）。 */
function readPrefs(): FontPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_PREFS
  try {
    const raw = localStorage.getItem(FONT_PREFS_KEY)
    if (raw === null) return DEFAULT_PREFS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFS
    const { editor, terminal } = parsed as { editor?: unknown; terminal?: unknown }
    const e = (typeof editor === 'object' && editor !== null ? editor : {}) as Record<string, unknown>
    const t = (typeof terminal === 'object' && terminal !== null ? terminal : {}) as Record<string, unknown>
    return {
      editor: {
        fontSize: num(e.fontSize, DEFAULT_EDITOR.fontSize),
        fontFamily: str(e.fontFamily, DEFAULT_EDITOR.fontFamily),
        lineHeight: num(e.lineHeight, DEFAULT_EDITOR.lineHeight),
      },
      terminal: {
        fontSize: num(t.fontSize, DEFAULT_TERMINAL.fontSize),
        fontFamily: str(t.fontFamily, DEFAULT_TERMINAL.fontFamily),
      },
    }
  } catch {
    return DEFAULT_PREFS
  }
}

/** 字面偏好 store 面（cordis 服务，跨 bundle 单例）。 */
export interface FontPrefsStore {
  /** 当前快照（uSES 源；引用稳定——值不变时返回同一对象）。 */
  getPrefs(): FontPrefs
  /**
   * 局部更新编辑器 / 终端字面（patch 深合入对应分组；内部持久化）。
   * 写方是设置页（跨 bundle，经 cordis 单例命中同一实例，实时联动）。
   */
  setPrefs(patch: { editor?: Partial<EditorFontPrefs>; terminal?: Partial<TerminalFontPrefs> }): void
  /** 订阅偏好变化（Monaco / xterm / 设置页回显用）。 */
  subscribe(listener: () => void): () => void
}

/** 创建字面偏好 store（单实例由 desktop 壳 provide，经 inject 消费）。 */
export function createFontPrefs(): FontPrefsStore {
  let prefs: FontPrefs = readPrefs()
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[corum-desktop] font prefs listener threw:', error)
      }
    }
  }
  return {
    getPrefs: () => prefs,
    setPrefs: (patch) => {
      const editor: EditorFontPrefs = {
        fontSize: num(patch.editor?.fontSize, prefs.editor.fontSize),
        fontFamily: str(patch.editor?.fontFamily, prefs.editor.fontFamily),
        lineHeight: num(patch.editor?.lineHeight, prefs.editor.lineHeight),
      }
      const terminal: TerminalFontPrefs = {
        fontSize: num(patch.terminal?.fontSize, prefs.terminal.fontSize),
        fontFamily: str(patch.terminal?.fontFamily, prefs.terminal.fontFamily),
      }
      const unchanged =
        editor.fontSize === prefs.editor.fontSize &&
        editor.fontFamily === prefs.editor.fontFamily &&
        editor.lineHeight === prefs.editor.lineHeight &&
        terminal.fontSize === prefs.terminal.fontSize &&
        terminal.fontFamily === prefs.terminal.fontFamily
      if (unchanged) return
      prefs = { editor, terminal }
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(FONT_PREFS_KEY, JSON.stringify(prefs))
        } catch {
          // 持久化失败不影响本次会话内的偏好。
        }
      }
      emit()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/* ── 同 bundle 实例桥（monaco-bridge.ts 范式）─────────────────────────
 * cordis 服务实例在 desktop index.ts provide；同 bundle 的 MonacoEditor 组件
 * 无法走 cordis inject（React 组件不持 ctx）⇒ 经此模块级桥取同一实例。
 * 同 bundle 内模块引用不构成红线 1 的跨 bundle 共享（与 monaco-bridge 同理）。 */

let fontPrefsInstance: FontPrefsStore | undefined

/** 写入 cordis 服务实例（desktop index.ts provide 时调用）。 */
export function setFontPrefsInstance(store: FontPrefsStore | undefined): void {
  fontPrefsInstance = store
}

/** 读 cordis 服务实例（同 bundle 组件用；未 provide 时 undefined → 组件用缺省值）。 */
export function getFontPrefsInstance(): FontPrefsStore | undefined {
  return fontPrefsInstance
}
