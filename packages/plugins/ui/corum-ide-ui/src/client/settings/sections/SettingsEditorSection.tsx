/**
 * SettingsEditorSection — 编辑器分区（PRD v2 §4.23：**25 项 / 5 分组**）。
 *
 * ## 本分区在设计稿与代码里**原本都不存在**
 *
 * 用户裁定 `#1`：「外观页的字体是整个软件 UI 上的字体大小设置。**终端字体只对终端内**
 * 生效。另外需要增加编辑器字体大小设置。要**单独有一个编辑器的设置页面**」
 * ⇒ 新增 `editor` 分区（PRD §4.23、§3.2 第 3 项），设计稿侧同步新建
 * `设置 · 编辑器 · 深色`（5 分组 / 25 行）。
 *
 * ## 就绪度（PRD §4.23 + §10.2 分档）
 *
 * 25 项中**只有 1 项有真源**：
 *
 * | 项 | 真源 | 状态 |
 * |---|---|---|
 * | E20 diff 布局（并排 / 内联） | ✅ `localStorage['corum.diff.sideBySide']` | **已接线** |
 * | E1~E19、E21~E22 | ❌ Monaco 选项全部**硬编码**在 `MonacoEditor.tsx:196-257`（约 35 项） | 未上线 |
 * | E23~E25 编辑体验 | ❌ 全仓无实现（无 autoSave、无 formatter 提供者） | 未上线 |
 *
 * ⇒ 其余 24 项一律「禁用 + 未上线」badge（PRD §6.1）；标签描述里保留**当前硬编码值**，
 * 让「现在是什么、以后能改什么」一眼可见。
 *
 * ⚠️ **E20 的读写格式是 `'1'` / `'0'`，不是 `'true'` / `'false'`**，且 `null` 视为 `true`
 * （`EditorColumn.tsx:435-441`）。写错格式会让真实编辑器**静默**翻成内联布局 ——
 * 故此处严格对齐源实现的格式。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsEditorSection
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton, useFontPrefs } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 编辑器（PRD §4.23）────────────────────────────────────────────── */

/**
 * diff 布局偏好的 localStorage key。
 *
 * ⚠️ 必须与 `packages/desktop/src/client/editor/EditorColumn.tsx:103` 的
 * `DIFF_SIDE_BY_SIDE_KEY` **保持一致**；跨 bundle 不能 import（红线 2），故此处重复字面量。
 */
const DIFF_SIDE_BY_SIDE_KEY = 'corum.diff.sideBySide'

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：未上线控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/**
 * 读 diff 布局偏好（与 `EditorColumn.tsx` 同格式：`'1'` = 并排，其余 = 内联）。
 * @returns 是否并排。
 */
function readDiffSideBySide(): boolean {
  try {
    const raw = localStorage.getItem(DIFF_SIDE_BY_SIDE_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true
  }
}

/**
 * 编辑器设置分区。
 *
 * 字体组（E1 字族 / E2 字号 / E3 行高）已接真源（fontPrefs cordis 服务）；
 * E20（diff 布局）走 localStorage；其余项为「目标态占位」，禁用并标注未上线。
 *
 * @returns the editor settings section.
 */
export function EditorSection() {
  const [sideBySide, setSideBySide] = useState<boolean>(readDiffSideBySide)
  // 字面偏好真源（fontPrefs cordis 服务，跨 bundle 单例；context 下发）。
  const fontPrefs = useFontPrefs()
  const font = useSyncExternalStore(
    (listener) => fontPrefs?.subscribe(listener) ?? (() => {}),
    () => fontPrefs?.getPrefs() ?? null,
  )
  const fontReady = fontPrefs !== null && font !== null
  /** 字族受控输入草稿（失焦写回；null = 未编辑，跟随真源）。 */
  const [familyDraft, setFamilyDraft] = useState<string | null>(null)
  // 真源变化（外部写入）时清掉草稿，避免显示陈旧值。
  useEffect(() => { setFamilyDraft(null) }, [font?.editor.fontFamily])

  /** 写入 diff 布局偏好（格式对齐 `EditorColumn.tsx`：`'1'`/`'0'`）。 */
  const applyDiffLayout = useCallback((id: string) => {
    const next = id === 'side-by-side'
    setSideBySide(next)
    try {
      localStorage.setItem(DIFF_SIDE_BY_SIDE_KEY, next ? '1' : '0')
    } catch { /* 容量满 / 隐私模式：退回会话内记忆 */ }
  }, [])

  const editorFont = font?.editor
  /** 字号/行高候选（含当前真源值置顶）。 */
  const sizeOptions = (current: number): { id: string; label: string }[] =>
    [current, ...[10, 11, 12, 13, 14, 15, 16, 18, 20].filter(v => v !== current)]
      .map(v => ({ id: String(v), label: String(v) }))
  const lineHeightOptions = (current: number): { id: string; label: string }[] =>
    [current, ...[0, 16, 18, 20, 22, 24, 28].filter(v => v !== current)]
      .map(v => ({ id: String(v), label: v === 0 ? '0（自动）' : String(v) }))

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          编辑器专属设置（**仅编辑器内生效**，与外观页的界面字体、终端页的终端字体互不影响）。
          当前除「diff 布局」外，其余条目尚未接入设置真源，故标注未上线并禁用。
        </span>
      </div>

      <SettingGroup title="字体">
        <SettingRow label="编辑器字体" desc="仅编辑器内生效的等宽字族（含回退栈，失焦写回；空 = 回落默认）。" badge={fontReady ? undefined : OFFLINE}>
          <input
            className={css.textInput}
            value={familyDraft ?? editorFont?.fontFamily ?? ''}
            placeholder="'JetBrains Mono', 'SFMono-Regular', Menlo, monospace"
            disabled={!fontReady}
            onChange={e => { setFamilyDraft(e.target.value) }}
            onBlur={() => {
              if (familyDraft === null) return
              const raw = familyDraft.trim()
              setFamilyDraft(null)
              if (raw !== (editorFont?.fontFamily ?? '')) fontPrefs?.setPrefs({ editor: { fontFamily: raw } })
            }}
          />
        </SettingRow>
        <SettingRow label="编辑器字号" desc="仅编辑器内的文字大小（px，实时生效）。" badge={fontReady ? undefined : OFFLINE}>
          <SelectField
            value={String(editorFont?.fontSize ?? 13)}
            options={sizeOptions(editorFont?.fontSize ?? 13)}
            onChange={id => { fontPrefs?.setPrefs({ editor: { fontSize: Number(id) } }) }}
            disabled={!fontReady}
          />
        </SettingRow>
        <SettingRow label="行高" desc="0 = 按字号自动（px，实时生效）。" badge={fontReady ? undefined : OFFLINE}>
          <SelectField
            value={String(editorFont?.lineHeight ?? 20)}
            options={lineHeightOptions(editorFont?.lineHeight ?? 20)}
            onChange={id => { fontPrefs?.setPrefs({ editor: { lineHeight: Number(id) } }) }}
            disabled={!fontReady}
          />
        </SettingRow>
        <SettingRow label="字距" desc="当前硬编码：0" badge={OFFLINE}>
          <SelectField value="0" options={[{ id: '0', label: '0' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="连字" desc="编程连字（如 =&gt; 合并显示）。当前未设置（= 关）" badge={OFFLINE} divider={false}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="缩进与换行">
        <SettingRow label="Tab 宽度" desc="当前未设置（Monaco 默认 4）" badge={OFFLINE}>
          <SelectField value="4" options={[{ id: '4', label: '4' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="用空格代替 Tab" desc="当前未设置（默认开）" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="自动检测缩进" desc="按打开的文件内容推断缩进。当前未设置（默认开）" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="自动换行" desc="关 / 按视口宽度 / 按指定列。当前未设置（= 关）" badge={OFFLINE}>
          <SelectField value="off" options={[{ id: 'off', label: '关' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="换行宽度" desc="仅「自动换行 = 按指定列」时生效" badge={OFFLINE} divider={false}>
          <SelectField value="80" options={[{ id: '80', label: '80' }]} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="显示">
        <SettingRow label="行号" desc="开 / 关 / 相对。当前硬编码：on" badge={OFFLINE}>
          <SelectField value="on" options={[{ id: 'on', label: '开' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="小地图" desc="当前硬编码：enabled + showSlider:always + maxColumn:80" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="空白字符" desc="不显示 / 仅选中 / 始终。当前硬编码：selection" badge={OFFLINE}>
          <SelectField value="selection" options={[{ id: 'selection', label: '仅选中' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="当前行高亮" desc="关 / 边框 / 整行。当前未设置（默认 line）" badge={OFFLINE}>
          <SelectField value="line" options={[{ id: 'line', label: '整行' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="括号对着色" desc="当前硬编码：enabled" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="缩进导轨 / 括号导轨" desc="当前硬编码：bracketPairs + indentation 均开" badge={OFFLINE}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="折叠控件显示" desc="始终 / 悬停。当前硬编码：always" badge={OFFLINE}>
          <SelectField value="always" options={[{ id: 'always', label: '始终' }]} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="滚动越界" desc="允许滚到末行之外。当前硬编码：false" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="平滑滚动 / 平滑光标" desc="当前硬编码：smoothScrolling + cursorSmoothCaretAnimation 均开" badge={OFFLINE} divider={false}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="代码对比 diff">
        <SettingRow label="diff 布局" desc="并排 / 内联。已接线：切换需重建编辑器（updateOptions 实测无效）。">
          <SelectField
            value={sideBySide ? 'side-by-side' : 'inline'}
            options={[{ id: 'side-by-side', label: '并排' }, { id: 'inline', label: '内联' }]}
            onChange={applyDiffLayout}
          />
        </SettingRow>
        <SettingRow label="忽略空白差异" desc="对比时忽略缩进与空白。当前硬编码：false（DiffViewer.tsx:72）" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="折叠未改动段" desc="开 / 关 + 上下文行数。当前硬编码：enabled + contextLineCount:3" badge={OFFLINE} divider={false}>
          <Switch checked={true} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="编辑体验">
        <SettingRow label="自动保存" desc="开 / 关 + 延迟。⚠️ 全仓无实现（无 autoSave、无 debounce 写盘）" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="保存时格式化" desc="开 / 关。⚠️ 无 formatter 提供者（formatOnPaste/Type 硬编码 false）" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="文件编码" desc="显示与切换。⚠️ 状态栏恒显 UTF-8（硬编码）；host 写入是否支持 encoding 未确证" badge={OFFLINE} divider={false}>
          <GlassButton disabled>UTF-8</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
