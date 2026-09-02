/**
 * SettingsShell —— ide-shell 自建的设置壳（sidebar.settings occupant）。
 *
 * 1:1 复刻 design.pen 设置中心 (KybzJ > MEGzM 等 44 页)：
 * - SettingsShell: 1040×820, glass-1 面板, cornerRadius 24, background_blur 16,
 *   shadow #00000040 offset(0,16) blur 48
 * - nav: 200px, 搜索框 + 分组标题 + 导航项 (height 28, gap 2, padding [12,10,8,10])
 * - content: header (h56, title + scope-switch + close) + body (group 卡片)
 * - group: glass-1 fill, cornerRadius 16, glass-border stroke, padding [6,16,10,16]
 * - row: space_between, gap 12, padding [10,2], meta(label+desc) ↔ control(select/switch)
 *
 * 面板经 createPortal 挂到 document.body——网格 .leaf 的 will-change:transform +
 * overflow:hidden 会困住 position:fixed 面板（React 18 事件委托挂在 root 容器，
 * portal 子树仍在 React 树内，onClick 全部生效）。
 *
 * 壳是纯组合面：nav 分组/项文案、面板标题、关闭按钮可及名、sections 全部经
 * slots 到达；打开状态与 active section id 是组件本地 viewing state；
 * onboarding 协调器在空 Hero 事实激活期间挂载恰好一个有序 registrant。
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import {
  Archive, Bell, BookOpen, Box, Brain, ChevronDown, Command, Cpu, Layers,
  Lock, Plug, Puzzle, Search, Server, Settings as SettingsIcon, Shield,
  Star, Sun, Terminal, Trash2, User, Wrench, X,
} from 'lucide-react'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
// Type-only: pulls `useSessions` into GlobalStandardProps (0.1.2 起由 ui-session 声明)。
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import css from './SettingsShell.module.css'

/* ── 导航分组定义（设计稿 nav: secA/B/C/D/E/F）───────────────────────── */

interface NavItemDef {
  id: string
  icon: ReactNode
}

interface NavGroupDef {
  title: string
  items: NavItemDef[]
}

/** 导航项图标（lucide-react 14×14，与设计稿 icon 节点一一对应）。 */
function navIcon(id: string): ReactNode {
  const cls = css.navIcon
  const map: Record<string, ReactNode> = {
    general: <SettingsIcon className={cls} size={14} />,
    appearance: <Sun className={cls} size={14} />,
    notifications: <Bell className={cls} size={14} />,
    shortcuts: <Command className={cls} size={14} />,
    models: <Cpu className={cls} size={14} />,
    'agent-presets': <Layers className={cls} size={14} />,
    permissions: <Lock className={cls} size={14} />,
    rules: <BookOpen className={cls} size={14} />,
    memory: <Brain className={cls} size={14} />,
    terminal: <Terminal className={cls} size={14} />,
    account: <User className={cls} size={14} />,
    privacy: <Shield className={cls} size={14} />,
    data: <Archive className={cls} size={14} />,
    extensions: <Box className={cls} size={14} />,
    mcp: <Plug className={cls} size={14} />,
    skills: <Star className={cls} size={14} />,
    advanced: <Wrench className={cls} size={14} />,
    profiles: <User className={cls} size={14} />,
    'skill-manager': <Puzzle className={cls} size={14} />,
    'mcp-manager': <Server className={cls} size={14} />,
  }
  return map[id] ?? <SettingsIcon className={cls} size={14} />
}

/**
 * 导航分组：从注册的 section rows 中按 id 前缀分组。
 * 设计稿 6 个分组：通用 / AGENT / 数据与隐私 / 扩展 / 高级 / 插件。
 * 动态分组：注册的 section 按其 id 匹配到分组，未匹配的归入「高级」。
 */
const NAV_GROUPS: { title: string; ids: string[] }[] = [
  { title: '通用', ids: ['general', 'appearance', 'notifications', 'shortcuts'] },
  { title: 'AGENT', ids: ['models', 'agent-presets', 'permissions', 'rules', 'memory', 'terminal'] },
  { title: '数据与隐私', ids: ['account', 'privacy', 'data'] },
  { title: '扩展', ids: ['extensions', 'mcp', 'skills'] },
  { title: '高级', ids: ['advanced', 'profiles'] },
  { title: '插件', ids: ['skill-manager', 'mcp-manager'] },
]

/* ── 面板 ────────────────────────────────────────────────────────── */

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  t: (key: string) => string
}

/**
 * The modal layer: full-viewport mask + centered panel.
 * Close paths: header button, mask click, Escape (mounted only while open).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose, t }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement | null>(null)

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  useEffect(() => { closeButton.current?.focus() }, [])

  // 按 nav 分组投影 rows；搜索过滤。
  const lowerQuery = searchQuery.trim().toLowerCase()
  const filteredRows = lowerQuery === ''
    ? rows
    : rows.filter(r => r.label.toLowerCase().includes(lowerQuery) || r.id.includes(lowerQuery))

  // 为每个分组计算可见项
  const visibleGroups = NAV_GROUPS.map(group => ({
    title: group.title,
    items: group.ids
      .map(id => filteredRows.find(r => r.id === id))
      .filter((r): r is SettingsSectionRow => r !== undefined),
  })).filter(g => g.items.length > 0)

  // 未归入任何分组的项 → 放入「其他」
  const groupedIds = new Set(NAV_GROUPS.flatMap(g => g.ids))
  const otherRows = filteredRows.filter(r => !groupedIds.has(r.id))
  if (otherRows.length > 0) {
    visibleGroups.push({ title: '其他', items: otherRows })
  }

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {/* ── Nav (200px) ───────────────────────────────────────────── */}
        <nav className={css.nav}>
          <div className={css.navSearch}>
            <Search className={css.navSearchIcon} size={13} />
            <input
              className={css.navSearchInput}
              type="text"
              placeholder={t('search')}
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value) }}
            />
          </div>
          <div className={css.navSpacer} />
          {visibleGroups.map((group, gi) => (
            <div key={group.title} className={css.navGroup}>
              {gi > 0 && <div className={css.navSpacer} />}
              <div className={css.navSecTitle}>{group.title}</div>
              {group.items.map(row => (
                <button
                  key={row.id}
                  type="button"
                  className={clsx(css.navCell, row.id === active && css.navCellActive)}
                  aria-current={row.id === active ? 'true' : undefined}
                  onClick={() => { onSelect(row.id) }}
                >
                  {navIcon(row.id)}
                  <span className={css.navLabel}>{row.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* ── Content ────────────────────────────────────────────────── */}
        <div className={css.content}>
          <div className={css.header}>
            <span className={css.headerTitle} id={titleId}>
              {active !== undefined
                ? (rows.find(r => r.id === active)?.label ?? t('title'))
                : t('title')}
            </span>
            <div className={css.headerRight}>
              {/* close */}
              <button
                ref={closeButton}
                type="button"
                className={css.closeBtn}
                onClick={onClose}
                aria-label={t('close')}
              >
                <X size={20} />
              </button>
            </div>
          </div>
          <div className={css.headerDivider} />
          <div className={css.body}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ── 壳 ────────────────────────────────────────────────────────── */

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsShell(props: SettingsRootComponentProps) {
  const { wide, useSections, useOnboardingSteps, useSessions, renderSlot } = props
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
  }, [])
  const openSection = useCallback((id: string) => {
    setActiveId(id)
    setOpen(true)
  }, [])

  const rows = useSections(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  // t：settings 命名空间绑定（InjectFace 注入面）
  const t = props.t

  return (
    <>
      <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(true) }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>
      {/* 面板经 createPortal 到 document.body */}
      {open && createPortal(
        <SettingsPanel
          rows={rows}
          renderSlot={renderSlot}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={close}
          t={t}
        />,
        document.body,
      )}
      {onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSection,
      }, { only: onboardingStep.id })}
    </>
  )
}
