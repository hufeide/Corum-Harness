/**
 * AgentTwoLevelSelect —— Agent 二级分组选择器（2026-09-07 用户定调）。
 *
 * 背景：预置 25 个行业角色后 Agent 列表很长（corum 30 + official 4）。原生
 * `<select>` + `<optgroup>` 只能平铺一级分组，长列表仍要滚动找；且原生下拉
 * 面板样式不可控（深色玻璃下一致性差）。本组件把列表收敛为**三个顶级分组 +
 * 组内二级展开**：
 *
 *   ▸ 通用        —— dsh 官方四模式（cordis/minimal/ptc/standard）
 *   ▸ Corum 内置  —— 标记为系统的 Agent（25 个行业预置 + PM/Task 兜底，trust=system）
 *   ▸ 用户        —— 用户自定义 Agent（trust=user）
 *
 * 交互：trigger 显示当前选中 Agent 名；点击展开面板，顶级分组可 chevron 展开/
 * 收起（默认只展开当前选中所在组，无选中展开「Corum 内置」）；点条目提交选择
 * 并收起。点面板外部/Esc 收起。样式由调用方传入的 css 映射驱动（两个消费点
 * —— 新建任务表单与 composer chip —— 各用自己的 module CSS 保持视觉一致）。
 *
 * 可访问性：trigger 是 button（aria-haspopup="menu" + aria-expanded），面板
 * role="menu"，条目 role="menuitemradio"（aria-checked 标记选中）；键盘
 * Esc 收起，焦点回 trigger。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Search, X } from 'lucide-react'
import type { AgentOption } from '../contract/slots.ts'

/** 三个顶级分组的展示定义（顺序即面板顺序）。 */
const GROUPS = [
  { key: 'official', label: '通用' },
  { key: 'builtin', label: 'Corum 内置' },
  { key: 'user', label: '用户' },
] as const
type GroupKey = (typeof GROUPS)[number]['key']

/** 把一个 AgentOption 归到顶级分组（source 优先，corum 内再看 trust）。 */
function groupOf(a: AgentOption): GroupKey {
  if (a.source === 'official') return 'official'
  return a.trust === 'user' ? 'user' : 'builtin'
}

/** 组件需要的样式键（调用方 module CSS 提供）。 */
export interface AgentSelectCss {
  root: string
  trigger: string
  triggerName?: string
  chevron: string
  panel: string
  /** 搜索框（2026-09-07 增加）：面板顶部的过滤输入行。 */
  searchRow: string
  searchIcon: string
  searchInput: string
  searchClear: string
  groupHead: string
  groupLabel: string
  groupCount: string
  list: string
  item: string
  itemCheck: string
  /** 搜索无命中 / 条目旁的次级说明文本。 */
  itemHint?: string
  empty: string
}

/** 归一化匹配串（小写 + 去空白），用于搜索的子串匹配。 */
function norm(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, '')
}

/** 一个 Agent 是否命中搜索词：name / title / dimension / id 任一含子串。 */
function matches(a: AgentOption, q: string): boolean {
  const query = norm(q)
  if (query === '') return true
  return norm(a.name).includes(query)
    || norm(a.title).includes(query)
    || norm(a.dimension).includes(query)
    || norm(a.id).includes(query)
}

export function AgentTwoLevelSelect({ agents, value, onChange, css, ariaLabel, disabled }: {
  agents: readonly AgentOption[]
  /** 当前选中的 profileId（'' = 无）。 */
  value: string
  onChange: (profileId: string) => void
  css: AgentSelectCss
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  /** 搜索词（面板内顶部过滤框；非空时跨组平铺命中项）。 */
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const groups = useMemo(() => {
    const map: Record<GroupKey, AgentOption[]> = { official: [], builtin: [], user: [] }
    for (const a of agents) map[groupOf(a)].push(a)
    return map
  }, [agents])
  /** 搜索态：非空 query → 跨组命中项（保持原相对顺序：通用→内置→用户）。 */
  const searching = query.trim() !== ''
  const hits = useMemo(
    () => (searching ? GROUPS.flatMap(({ key }) => groups[key]).filter((a) => matches(a, query)) : []),
    [searching, groups, query],
  )
  /** 选中项所在组（默认展开）；无选中默认「Corum 内置」（预置角色主入口）。 */
  const selectedGroup: GroupKey = useMemo(() => {
    const cur = agents.find((a) => a.id === value)
    return cur === undefined ? 'builtin' : groupOf(cur)
  }, [agents, value])
  const [expanded, setExpanded] = useState<Record<GroupKey, boolean>>({ official: false, builtin: true, user: false })
  // 打开面板时把展开态对齐到当前选中所在组（用户切过 Agent 后再开，落在正确的组）。
  useEffect(() => {
    if (open) setExpanded((prev) => ({ ...prev, [selectedGroup]: true }))
  }, [open, selectedGroup])

  // 点击面板外部 / Esc 收起；关闭时清空搜索词（下次打开回分组视图）。
  useEffect(() => {
    if (!open) {
      setQuery('')
      return
    }
    // 打开即聚焦搜索框（定位高频操作：点开就能直接敲关键字过滤）。
    searchRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = agents.find((a) => a.id === value)
  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled === true}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={css.triggerName}>{selected?.name ?? '选择 Agent'}</span>
        <ChevronDown size={14} className={css.chevron} />
      </button>
      {open && (
        <div className={css.panel} role="menu" aria-label={ariaLabel}>
          {/* 搜索框（2026-09-07）：面板顶部过滤——非空时跨组平铺命中项（name/
              title/dimension/id 子串匹配），清空回三级分组视图；打开即聚焦。 */}
          <div className={css.searchRow}>
            <Search size={13} className={css.searchIcon} />
            <input
              ref={searchRef}
              type="text"
              className={css.searchInput}
              placeholder="搜索 Agent…"
              value={query}
              aria-label="搜索 Agent"
              onChange={(e) => setQuery(e.target.value)}
            />
            {query !== '' && (
              <button
                type="button"
                className={css.searchClear}
                aria-label="清空搜索"
                onClick={() => { setQuery(''); searchRef.current?.focus() }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          {searching
            ? (
              hits.length === 0
                ? <div className={css.empty}>无匹配的 Agent</div>
                : (
                  <div className={css.list} role="group" aria-label="搜索结果">
                    {hits.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={css.item}
                        role="menuitemradio"
                        aria-checked={a.id === value}
                        data-active={a.id === value || undefined}
                        onClick={() => { onChange(a.id); setOpen(false) }}
                      >
                        <span className={css.itemCheck}>{a.id === value && <Check size={13} />}</span>
                        {a.name}
                        {a.title !== undefined && a.title !== a.name && (
                          <span className={css.itemHint}>{a.title}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )
            )
            : GROUPS.map(({ key, label }) => {
              const list = groups[key]
              if (list.length === 0) return null
              const isOpen = expanded[key]
              return (
                <div key={key}>
                  <button
                    type="button"
                    className={css.groupHead}
                    aria-expanded={isOpen}
                    onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                  >
                    {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className={css.groupLabel}>{label}</span>
                    <span className={css.groupCount}>{list.length}</span>
                  </button>
                  {isOpen && (
                    <div className={css.list} role="group" aria-label={label}>
                      {list.map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          className={css.item}
                          role="menuitemradio"
                          aria-checked={a.id === value}
                          data-active={a.id === value || undefined}
                          onClick={() => { onChange(a.id); setOpen(false) }}
                        >
                          <span className={css.itemCheck}>{a.id === value && <Check size={13} />}</span>
                          {a.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
