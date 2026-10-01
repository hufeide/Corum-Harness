/**
 * SkillsPage — 集成中心 · 技能页（design.pen VNH3k「集成中心·技能 SKILL」）。
 *
 * 数据链路（RPC 方法名与参数逐字不变）：skillManager/listAll|getSkillContent|
 * getSkillHistory|pinVersion|commitVersion|deleteSkill|importFromFile|
 * importFromText|scanDirectory|importDirectory|importBuiltinSkills
 * + corumAgent/listProfiles（绑定数）。
 *
 * 视图结构（design.pen VNH3k）：页头单行（市场|已装 pill tab + 280×31 搜索框 +
 * 分类 chips + 右端「导入技能 / 导入内置技能」）→ 全宽分隔线 → 磁贴群
 * （节头「技能 SKILL」+ 第一张「添加」磁贴 + 技能磁贴，角标 = 启用开关）
 * + 右侧 510px 详情简介面板（hero 150 + body，元信息 = 类型/状态/触发）。
 * 「添加」磁贴点击打开 ImportSkillDialog（file/text/scan 三 tab 与 RPC 逐字不变）。
 *
 * SkillDetailView 二级视图（基本信息 / SKILL.md 内容 / 版本历史 / 绑定关系 /
 * CommitVersionDialog / DeleteSkillDialog）功能与 RPC 全部保留。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft, ChevronDown, Download, FileSearch, GitPullRequest, PackagePlus,
  Plus, Search, ShieldCheck, Sparkles, Star, Terminal, Trash2, X, Zap,
} from 'lucide-react'
import { SettingGroup } from './SettingGroup.tsx'
import { ConfirmDialog } from './ConfirmDialog.tsx'
import { GlassButton, useIntegrationsRpc } from './face.tsx'
import type { SkillInfo, SkillVersion, ProfileSummary, ScannedSkill, SkillAgentBind, BuiltinSkillImportResult } from './types.ts'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import type { LucideIcon } from 'lucide-react'
import css from './SkillsPage.module.css'
import legacy from './IntegrationsPages.module.css'

/* ── 技能 ──────────────────────────────────────────────────────────── */


type SkillsView = { kind: 'list' } | { kind: 'detail'; name: string }

/**
 * 把「导入内置技能」的三桶摘要压成一行读得懂的结果。
 * 空桶不出现；三桶全空说明内置技能都已就位，给一句明确结论而不是空白。
 */
function formatBuiltinSummary(r: BuiltinSkillImportResult): string {
  const parts: string[] = []
  if (r.installed.length > 0) parts.push(`新装 ${r.installed.length} 个（${r.installed.join('、')}）`)
  if (r.skipped.length > 0) parts.push(`跳过 ${r.skipped.length} 个已有同名的，未覆盖（${r.skipped.join('、')}）`)
  if (r.tombstoned.length > 0) parts.push(`不复活 ${r.tombstoned.length} 个你删除过的（${r.tombstoned.join('、')}）`)
  if (parts.length === 0) return '内置技能都已在库，没有需要变更的。'
  return parts.join('；')
}

export function SkillsPage() {
  const rpc = useIntegrationsRpc()
  const [view, setView] = useState<SkillsView>({ kind: 'list' })
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [builtinBusy, setBuiltinBusy] = useState(false)
  const [builtinResult, setBuiltinResult] = useState<BuiltinSkillImportResult | null>(null)
  const [tab, setTab] = useState<'market' | 'installed'>('market')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('all')
  /** 详情面板选中态（null = 默认选第一个）。 */
  const [selectedName, setSelectedName] = useState<string | null>(null)
  /** 本地启用态（host 侧暂无启停 RPC，先按纯 UI 态记录）。 */
  const [disabledSet, setDisabledSet] = useState<Set<string>>(new Set())

  const reload = async () => {
    if (!rpc) return
    try {
      const [sk, pf] = await Promise.all([
        rpc<{ skills: SkillInfo[] }>('skillManager', 'listAll', {}),
        rpc<{ profiles: ProfileSummary[] }>('corumAgent', 'listProfiles', {}),
      ])
      setSkills(sk.skills)
      setProfiles(pf.profiles)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  /**
   * 「导入内置技能」：把随包分发的官方技能集装进技能库。
   * 幂等且不破坏——已有同名一律不覆盖、用户删过的不复活（host 侧策略），
   * 这里只负责发起 + 把三桶结果如实摊给用户看。
   */
  const importBuiltin = async () => {
    if (!rpc) return
    setBuiltinBusy(true)
    setBuiltinResult(null)
    try {
      const r = await rpc<BuiltinSkillImportResult>('skillManager', 'importBuiltinSkills', {})
      setBuiltinResult(r)
      if (r.ok) await reload()
    } catch (e) {
      setBuiltinResult({ ok: false, error: e instanceof Error ? e.message : String(e), installed: [], skipped: [], tombstoned: [] })
    } finally {
      setBuiltinBusy(false)
    }
  }

  /** 计算某 skill 被多少个 Agent 绑定。 */
  const bindCount = (name: string) =>
    profiles.filter(p => (p.skills ?? []).some(s => s.name === name)).length

  if (!rpc) {
    return <p className={css.hintText}>技能服务未就绪。</p>
  }

  if (view.kind === 'detail') {
    const info = (skills ?? []).find(s => s.name === view.name)
    return (
      <SkillDetailView
        name={view.name}
        info={info}
        profiles={profiles}
        rpc={rpc}
        onBack={() => setView({ kind: 'list' })}
        onChanged={() => { void reload() }}
      />
    )
  }

  return (
    <>
      <SkillMarketView
        skills={skills}
        error={error}
        tab={tab}
        setTab={setTab}
        query={query}
        setQuery={setQuery}
        category={category}
        setCategory={setCategory}
        selectedName={selectedName}
        setSelectedName={setSelectedName}
        disabledSet={disabledSet}
        onToggle={(name) => setDisabledSet(prev => {
          const next = new Set(prev)
          if (next.has(name)) next.delete(name); else next.add(name)
          return next
        })}
        bindCount={bindCount}
        onOpenDetail={(name) => setView({ kind: 'detail', name })}
        onDelete={(s) => setDeleting(s)}
        onImport={() => setImportOpen(true)}
        onImportBuiltin={() => void importBuiltin()}
        builtinBusy={builtinBusy}
        builtinResult={builtinResult}
      />
      {deleting && (
        <DeleteSkillDialog
          skill={deleting}
          bindCount={bindCount(deleting.name)}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); void reload() }}
          rpc={rpc}
        />
      )}
      {importOpen && (
        <ImportSkillDialog
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); void reload() }}
          rpc={rpc}
        />
      )}
    </>
  )
}

/* ── 技能市场视图：Metro 磁贴 + 右侧详情简介面板 ───────────────────── */

/** 分类筛选 chips（名称关键词归桶；全部永远有）。文案与顺序对应 design.pen VNH3k。 */
const CATEGORIES: { id: string; label: string; match: RegExp | null }[] = [
  { id: 'all', label: '全部', match: null },
  { id: 'verify', label: '验证', match: /verify|cdp|test|check|audit/ },
  { id: 'code', label: '代码', match: /code|review|refactor|lint|commit|git|dev/ },
  { id: 'deploy', label: '部署', match: /deploy|pack|build|release|publish|ship/ },
]

function categoryOf(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase()
  for (const c of CATEGORIES) {
    if (c.match !== null && c.match.test(text)) return c.id
  }
  return 'other'
}

/**
 * 磁贴图标按技能名语义映射到 lucide（design.pen VNH3k 用 ShieldCheck/
 * FileSearch/GitPullRequest/Terminal/Zap 等具体图标，不是统一 Star）。
 */
function skillIconOf(name: string): LucideIcon {
  const n = name.toLowerCase()
  if (/verify|cdp|check|audit/.test(n)) return ShieldCheck
  if (/review|lint/.test(n)) return FileSearch
  if (/pr|pull|flow/.test(n)) return GitPullRequest
  if (/dev|server|serve/.test(n)) return Terminal
  if (/auto|deploy|pack/.test(n)) return Zap
  return Sparkles
}

/**
 * 磁贴尺寸分级（Metro 混排）。
 *
 * 设计稿首行的排法是固定 6 拍循环（VNH3k：大贴 264×264 → 两张宽贴 264×128 →
 * 高贴 128×264 → 两张小贴 128×128），iYTAN / bFLLQ / fngID 三个 frame 完全同构。
 * 尺寸因此由**序号**决定，而不是按名字猜——按名字判会让整片网格退化成等大方块。
 */
const MOSAIC_CYCLE: readonly ('big' | 'wide' | 'wide' | 'tall' | 'small' | 'small')[] =
  ['big', 'wide', 'wide', 'tall', 'small', 'small']

/** 按序号取磁贴尺寸（6 拍循环；`grid-auto-flow: dense` 自动补位）。 */
function mosaicSizeOf(index: number): 'big' | 'wide' | 'tall' | 'small' {
  return MOSAIC_CYCLE[index % MOSAIC_CYCLE.length]!
}

/**
 * 磁贴 tint 档：按分类给底色（紫/深紫/堇色/灰蓝），token 派生。
 * 对应 design.pen VNH3k 磁贴的多档语义底色。
 */
function skillTintClassOf(s: SkillInfo, size: 'big' | 'wide' | 'tall' | 'small'): string {
  if (size === 'big') return css.tintDeep
  if (size === 'wide') return css.tintMauve
  if (size === 'tall') return css.tintSlate
  const cat = categoryOf(s.name, s.description ?? '')
  if (cat === 'verify') return css.tintViolet
  if (cat === 'code') return css.tintMauve
  if (cat === 'deploy') return css.tintViolet
  return css.tintSlate
}

/**
 * 磁贴小字 = 作者口径（design.pen VNH3k「@corum · 官方」/「社区」）。
 * 判据：随包分发的内置技能集（packages/desktop/shipped-skills/，即
 * 「导入内置技能」装入的那批，PROVENANCE.md 判定的官方技能）写
 * 「@corum · 官方」；其余（用户从文件/文本/目录导入的）写「社区」。
 * 注意 listAll wire 上没有来源字段，这里按本仓技能库的既定组成近似：
 * 内置技能清单在编译期可知，与其求交集。
 */
const OFFICIAL_SKILL_NAMES = new Set([
  'cordis-plugin-development', 'dsh-archive-agent-notes', 'dsh-ci-test-reliability',
  'dsh-code-review', 'dsh-doc', 'dsh-find-simplifications', 'dsh-merging-stacked-prs',
  'dsh-pre-push-checks', 'dsh-prose-standard', 'dsh-translate-docs',
  'dsh-trim-cot-leakage', 'editing-cordis-compositions', 'record-browser-gif',
])
function skillAuthorLabel(name: string): string {
  return OFFICIAL_SKILL_NAMES.has(name) ? '@corum · 官方' : '社区'
}

function SkillMarketView({ skills, error, tab, setTab, query, setQuery, category, setCategory,
  selectedName, setSelectedName, disabledSet, onToggle, bindCount, onOpenDetail, onDelete,
  onImport, onImportBuiltin, builtinBusy, builtinResult }: {
  skills: SkillInfo[] | null
  error: string | null
  tab: 'market' | 'installed'
  setTab: (t: 'market' | 'installed') => void
  query: string
  setQuery: (q: string) => void
  category: string
  setCategory: (c: string) => void
  selectedName: string | null
  setSelectedName: (n: string) => void
  disabledSet: Set<string>
  onToggle: (name: string) => void
  bindCount: (name: string) => number
  onOpenDetail: (name: string) => void
  onDelete: (s: SkillInfo) => void
  onImport: () => void
  onImportBuiltin: () => void
  builtinBusy: boolean
  builtinResult: BuiltinSkillImportResult | null
}) {
  /** 过滤后的技能池（搜索 + 分类）。「市场 | 已装」目前同一数据源，tab 仅作视图语义。 */
  const pool = useMemo(() => {
    let list = skills ?? []
    const q = query.trim().toLowerCase()
    if (q !== '') {
      list = list.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
    }
    if (category !== 'all') {
      list = list.filter(s => categoryOf(s.name, s.description ?? '') === category)
    }
    return list
  }, [skills, query, category])

  /** 详情面板选中项（默认第一个；过滤后选中项出列则回落）。 */
  const selected = useMemo(() => {
    if (pool.length === 0) return null
    const hit = selectedName !== null ? pool.find(s => s.name === selectedName) : undefined
    return hit ?? pool[0]
  }, [pool, selectedName])

  return (
    <div className={css.page}>
      {/* 页头单行：市场|已装 pill tab + 搜索框 + 分类 chips + 右端导入按钮（design.pen VNH3k） */}
      <div className={css.headerRow} role="tablist" aria-label="技能分区">
        <button type="button" role="tab" aria-selected={tab === 'market'} className={`${css.tab}${tab === 'market' ? ' ' + css.tabActive : ''}`} onClick={() => setTab('market')}>市场</button>
        <button type="button" role="tab" aria-selected={tab === 'installed'} className={`${css.tab}${tab === 'installed' ? ' ' + css.tabActive : ''}`} onClick={() => setTab('installed')}>已装</button>
        <div className={css.searchBox}>
          <Search size={14} className={css.searchIcon} />
          <input
            className={css.searchInput}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索技能…"
          />
        </div>
        {CATEGORIES.map(c => (
          <button
            key={c.id}
            type="button"
            className={`${css.filterChip}${category === c.id ? ' ' + css.filterChipActive : ''}`}
            onClick={() => setCategory(c.id)}
          >{c.label}</button>
        ))}
        <span className={css.headerSpacer} />
        <button type="button" className={css.addBtn} onClick={onImport}>
          <PackagePlus size={14} />导入技能
        </button>
        <button type="button" className={css.addBtn} onClick={onImportBuiltin} disabled={builtinBusy}>
          <Download size={14} />{builtinBusy ? '导入中…' : '导入内置技能'}
        </button>
      </div>

      {/* 全宽分隔线（页头行与磁贴群之间） */}
      <div className={css.divider} />

      {builtinResult !== null && (
        builtinResult.ok
          ? <p className={css.hintText}>内置技能：{formatBuiltinSummary(builtinResult)}</p>
          : <p className={legacy.confirmWarn}>导入内置技能失败：{builtinResult.error ?? '未知错误'}</p>
      )}

      <div className={css.body}>
        {/* 左：Metro 磁贴群（节头 + 添加磁贴 + 技能磁贴） */}
        <div className={css.tiles}>
          <span className={css.sectionHead}>技能 SKILL</span>
          {error !== null && <p className={css.hintText}>加载失败：{error}</p>}
          {skills === null && error === null && <p className={css.hintText}>加载中…</p>}
          <div className={css.tileGrid}>
            {/* 「添加」磁贴：固定第一张（左上角），点击打开 ImportSkillDialog。 */}
            <button
              type="button"
              className={`${css.tile} ${css.tintSlate}`}
              aria-label="添加技能"
              onClick={onImport}
            >
              <span className={css.tileCorner}>
                <span className={css.tileSwitch} data-off="" aria-hidden="true" />
              </span>
              <div className={css.tileTop}>
                <span className={css.tileIcon}><Plus size={24} /></span>
              </div>
              <div className={css.tileBottom}>
                <div className={css.tileNameRow}>
                  <span className={css.tileName}>添加</span>
                  <span className={css.tileVersion}>SKILL</span>
                </div>
                <span className={css.tileSub}>新技能</span>
              </div>
            </button>
            {skills !== null && pool.length === 0 && error === null && (
              <>
                <div className={css.tilePlaceholder}><span className={css.tilePlaceholderIcon}><Plus size={20} /></span><p className={css.tilePlaceholderText}>即将上线</p></div>
                <div className={css.tilePlaceholder}><span className={css.tilePlaceholderIcon}><Plus size={20} /></span><p className={css.tilePlaceholderText}>即将上线</p></div>
                <div className={css.tilePlaceholder}><span className={css.tilePlaceholderIcon}><Plus size={20} /></span><p className={css.tilePlaceholderText}>即将上线</p></div>
              </>
            )}
            {pool.map((s, i) => {
              const enabled = !disabledSet.has(s.name)
              const active = selected !== null && selected.name === s.name
              const size = mosaicSizeOf(i)
              const Icon = skillIconOf(s.name)
              const sizeClass = size === 'big' ? ` ${css.tileBig}` : size === 'wide' ? ` ${css.tileWide}` : size === 'tall' ? ` ${css.tileTall}` : ''
              return (
                <button
                  key={s.name}
                  type="button"
                  className={`${css.tile}${sizeClass} ${skillTintClassOf(s, size)}${size === 'big' ? ' ' + css.tileGlow : ''}${active ? ' ' + css.tileActive : ''}`}
                  aria-pressed={active}
                  onClick={() => setSelectedName(s.name)}
                >
                  {/* 角标：启用开关（绝对定位于右上角；stopPropagation 防误触选中）。 */}
                  <span
                    role="switch"
                    aria-checked={enabled}
                    aria-label={`${s.name} 启用开关`}
                    className={`${css.tileCorner} ${css.tileSwitch}`}
                    data-off={enabled ? undefined : ''}
                    onClick={e => { e.stopPropagation(); onToggle(s.name) }}
                  >
                    <span className={css.tileSwitchKnob} />
                  </span>
                  <div className={css.tileTop}>
                    <span className={css.tileIcon}><Icon size={size === 'big' ? 30 : 24} /></span>
                  </div>
                  <div className={css.tileBottom}>
                    <div className={css.tileNameRow}>
                      <span className={css.tileName}>{s.name}</span>
                      <span className={css.tileVersion}>{s.currentVersion ?? '—'}</span>
                    </div>
                    {(size === 'big' || size === 'wide') && s.description !== '' && (
                      <span className={css.tileDesc}>{s.description}</span>
                    )}
                    <span className={css.tileSub}>{skillAuthorLabel(s.name)}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* 右：详情简介面板（点击磁贴就地展开；默认选第一个） */}
        <aside className={css.detail} aria-label="技能详情">
          {selected === null
            ? <DetailEmpty
                title="选择一个技能"
                desc="点左侧任意技能磁贴，在这里查看它的简介、状态与绑定；「管理版本与绑定」进入完整管理。"
              />
            : (
              <SkillDetailSummary
                skill={selected}
                enabled={!disabledSet.has(selected.name)}
                onToggle={() => onToggle(selected.name)}
                bindCount={bindCount(selected.name)}
                onOpenDetail={() => onOpenDetail(selected.name)}
                onDelete={() => onDelete(selected)}
              />
            )}
        </aside>
      </div>
    </div>
  )
}

/* ── 详情简介面板（磁贴选中项的就地展开；完整管理进二级详情视图）────── */

/** 详情面板空态（未选中任何磁贴）：产品 logo + glow + 引导文案。 */
function DetailEmpty({ title, desc }: { title: string; desc: string }) {
  return (
    <div className={css.detailEmpty}>
      <div className={css.detailEmptyHero}>
        <img className={css.detailEmptyLogo} src="corumapp://app/assets/icon.png" alt="" draggable={false} />
      </div>
      <p className={css.detailEmptyTitle}>{title}</p>
      <p className={css.detailEmptyDesc}>{desc}</p>
    </div>
  )
}

function SkillDetailSummary({ skill, enabled, onToggle, bindCount, onOpenDetail, onDelete }: {
  skill: SkillInfo
  enabled: boolean
  onToggle: () => void
  bindCount: number
  onOpenDetail: () => void
  onDelete: () => void
}) {
  const Icon = skillIconOf(skill.name)
  /** 分类名（元信息「类型」）；未归类给默认口径。 */
  const catLabel = CATEGORIES.find(c => c.id === categoryOf(skill.name, skill.description ?? ''))?.label
  return (
    <>
      <div className={css.detailHero}>
        <span className={css.detailHeroBadge}><Icon size={30} /></span>
      </div>
      <div className={css.detailBody}>
        <div>
          <div className={css.detailTitleRow}>
            <span className={css.detailName}>{skill.name}</span>
            <span className={css.detailVersion}>{skill.currentVersion ?? '—'}</span>
          </div>
          <span className={css.detailSub}>{OFFICIAL_SKILL_NAMES.has(skill.name) ? 'corum · 官方技能' : 'corum 技能库'}</span>
          {skill.description !== '' && <p className={css.detailDesc}>{skill.description}</p>}
          <div className={css.detailMeta}>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>类型</span>
              <span className={css.detailMetaValue}>{catLabel !== undefined ? `${catLabel} · 技能（SKILL.md 指令包）` : '技能（SKILL.md 指令包）'}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>状态</span>
              <span className={css.detailMetaValue}>{enabled ? '已启用' : '已停用'}</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>触发</span>
              <span className={css.detailMetaValue}>Agent 预设按版本绑定（{bindCount} 个）</span>
            </div>
            <div className={css.detailMetaRow}>
              <span className={css.detailMetaKey}>版本数</span>
              <span className={css.detailMetaValue}>{skill.versionCount} 个</span>
            </div>
          </div>
        </div>
        <div>
          <div className={css.detailSwitchRow}>
            <span className={css.detailSwitchLabel}>启用此技能</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              className={css.tileSwitch}
              data-off={enabled ? undefined : ''}
              onClick={onToggle}
            >
              <span className={css.tileSwitchKnob} />
            </button>
          </div>
          <div className={css.detailActions}>
            <button type="button" className={`${css.actionBtn} ${css.actionDanger}`} onClick={onDelete}>
              <Trash2 size={13} />删除
            </button>
            <button type="button" className={css.actionBtn} onClick={onOpenDetail}>管理版本与绑定</button>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── 版本选择下拉（触发按钮 + portal 面板，面板内每个版本用 item 富形态）────── */

function VersionSelect({ versions, pinned, onSelect, disabled }: {
  versions: SkillVersion[]
  pinned: string | undefined
  onSelect: (versionId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)

  const current = versions.find(v => v.id === pinned) ?? versions[versions.length - 1]

  useEffect(() => {
    if (!open) return
    const btn = btnRef.current
    if (btn) {
      const r = btn.getBoundingClientRect()
      setPos({ top: r.bottom + 4, left: r.left, width: r.width })
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <div className={legacy.versionSelectWrap}>
      <button
        ref={btnRef}
        type="button"
        className={legacy.versionSelectBtn}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
      >
        <span className={legacy.radioOn} />
        <span className={legacy.versionMeta}>
          <span className={legacy.versionId}>{current.id}</span>
          <span className={legacy.versionLabel}>{current.label}</span>
        </span>
        <ChevronDown size={16} className={legacy.versionSelectChevron} />
      </button>
      {open && !disabled && pos && createPortal(
        <div
          ref={panelRef}
          className={legacy.versionPanel}
          role="listbox"
          style={{ position: 'fixed', top: pos.top, left: pos.left, minWidth: pos.width }}
        >
          {versions.map(v => {
            const active = v.id === current.id
            return (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={active}
                className={active ? legacy.versionRowActive : legacy.versionRow}
                onClick={() => { onSelect(v.id); setOpen(false) }}
              >
                <span className={active ? legacy.radioOn : legacy.radioOff} />
                <div className={legacy.versionMeta}>
                  <span className={legacy.versionId}>{v.id}</span>
                  <span className={legacy.versionLabel}>{v.label}</span>
                </div>
                {active && <span className={legacy.currentTag}>当前使用</span>}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

/* ── 技能详情视图（基本信息 / SKILL.md 内容 / 版本历史 / 绑定关系）────────── */

function SkillDetailView({ name, info, profiles, rpc, onBack, onChanged }: {
  name: string
  info: SkillInfo | undefined
  profiles: ProfileSummary[]
  rpc: CorumRpcCall
  onBack: () => void
  onChanged: () => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const [versions, setVersions] = useState<SkillVersion[]>([])
  const [pinned, setPinned] = useState<string | undefined>(info?.currentVersion)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [commitOpen, setCommitOpen] = useState(false)

  // 绑定此 skill 的全部 Agent（含各自 pin 的版本）
  const bindings: SkillAgentBind[] = profiles
    .filter(p => (p.skills ?? []).some(s => s.name === name))
    .map(p => ({
      agentId: p.id,
      agentName: p.nickname ?? p.id,
      versionId: (p.skills ?? []).find(s => s.name === name)!.versionId,
    }))

  const load = async () => {
    try {
      const [c, h] = await Promise.all([
        rpc<{ ok: boolean; error?: string; content?: string }>('skillManager', 'getSkillContent', { name }),
        rpc<{ versions: SkillVersion[] }>('skillManager', 'getSkillHistory', { name }),
      ])
      if (c.ok && c.content !== undefined) setContent(c.content)
      setVersions(h.versions)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void load() }, [name])

  const switchVersion = async (versionId: string) => {
    setBusy(true)
    try {
      await rpc('skillManager', 'pinVersion', { name, versionId })
      setPinned(versionId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveAndCommit = async (label?: string) => {
    setBusy(true)
    try {
      const r = await rpc<{ ok: boolean; error?: string; version?: SkillVersion }>(
        'skillManager', 'commitVersion', { name, content: draft, label: label ?? '手动提交' })
      if (!r.ok) { setError(r.error ?? '提交失败'); return }
      setEditing(false)
      setCommitOpen(false)
      await load()
      if (r.version) setPinned(r.version.id)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const startEdit = () => { setDraft(content ?? ''); setEditing(true) }

  return (
    <>
      <div className={legacy.detailHeadRow}>
        <button type="button" className={legacy.backBtn} onClick={onBack}>
          <ArrowLeft size={14} />返回列表
        </button>
      </div>

      {/* 基本信息 */}
      <SettingGroup title="基本信息">
        <div className={legacy.skillTitleRow}>
          <Star size={16} className={legacy.skillIcon} />
          <span className={legacy.skillTitle}>{name}</span>
          {pinned && <span className={legacy.skillChip}>{pinned}</span>}
        </div>
        <div className={legacy.kvRow}><span className={legacy.kvLabel}>描述</span><span className={legacy.kvValue}>{info?.description ?? '—'}</span></div>
        <div className={legacy.kvRow}><span className={legacy.kvLabel}>存储路径</span><span className={legacy.kvValue}>{info?.path ?? '—'}</span></div>
        <div className={legacy.kvRow}><span className={legacy.kvLabel}>版本数量</span><span className={legacy.kvValue}>{info?.versionCount ?? versions.length} 个</span></div>
        <div className={legacy.kvRow}><span className={legacy.kvLabel}>创建时间</span><span className={legacy.kvValue}>{info?.createdAt ?? '—'}</span></div>
      </SettingGroup>

      {/* SKILL.md 内容 */}
      <SettingGroup title="SKILL.md 内容">
        {error && <p className={legacy.hintText}>{error}</p>}
        {!editing ? (
          <>
            <pre className={legacy.skillViewer}>{content ?? '加载中…'}</pre>
            <div className={legacy.actionsRow}>
              <GlassButton onClick={startEdit}>✎ 编辑</GlassButton>
              <GlassButton variant="primary" onClick={() => { setDraft(content ?? ''); setCommitOpen(true) }}>提交新版本</GlassButton>
            </div>
          </>
        ) : (
          <>
            <textarea className={legacy.skillEditor} value={draft} onChange={e => setDraft(e.target.value)} rows={14} />
            <p className={legacy.hintText}>编辑不会立即生效——保存后将当前内容提交为新版本（自动设为当前版本）。</p>
            <div className={legacy.actionsRow}>
              <GlassButton onClick={() => setEditing(false)}>取消</GlassButton>
              <GlassButton variant="primary" onClick={() => void saveAndCommit()} disabled={busy}>{busy ? '提交中…' : '保存并提交新版本'}</GlassButton>
            </div>
          </>
        )}
      </SettingGroup>

      {/* 版本历史：下拉选择（不 list 平铺），面板内版本项用 item 富形态，选中即生效 */}
      <SettingGroup title={`版本历史（${versions.length}）`}>
        {versions.length === 0 && <p className={legacy.hintText}>暂无版本记录。</p>}
        {versions.length > 0 && (
          <VersionSelect
            versions={versions}
            pinned={pinned}
            onSelect={id => void switchVersion(id)}
            disabled={busy}
          />
        )}
      </SettingGroup>

      {/* 绑定关系（全列表，只读） */}
      <SettingGroup title={`绑定此技能的 Agent（${bindings.length}）`}>
        {bindings.length === 0 && <p className={legacy.hintText}>暂无 Agent 绑定此技能。</p>}
        {bindings.map(b => (
          <div key={b.agentId} className={legacy.bindRow}>
            <span className={legacy.bindAvatar}>{b.agentName[0] ?? '?'}</span>
            <span className={legacy.bindName}>{b.agentName}</span>
            <span className={legacy.skillChip}>pin {b.versionId}</span>
          </div>
        ))}
        <p className={legacy.hintText}>绑定关系在 Agent 预设中管理，此处仅展示。</p>
      </SettingGroup>

      {commitOpen && (
        <CommitVersionDialog
          name={name}
          onClose={() => setCommitOpen(false)}
          onSubmit={label => void saveAndCommit(label)}
          busy={busy}
        />
      )}
    </>
  )
}

/* ── 提交新版本对话框 ─────────────────────────────────────────────── */

function CommitVersionDialog({ name, onClose, onSubmit, busy }: {
  name: string
  onClose: () => void
  onSubmit: (label: string) => void
  busy: boolean
}) {
  const [label, setLabel] = useState('')
  return createPortal(
    <div className={legacy.modalOverlay} onClick={onClose}>
      <div className={legacy.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={legacy.modalHeader}>
          <span className={legacy.modalTitle}>提交新版本</span>
          <button type="button" className={legacy.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={legacy.modalBody}>
          <p className={legacy.hintText}>把「{name}」当前的 SKILL.md 保存为一个新版本快照。</p>
          <div className={legacy.formGroup}>
            <label className={legacy.fieldLabel}>版本备注</label>
            <input className={legacy.fieldInput} value={label} onChange={e => setLabel(e.target.value)} placeholder="如：优化评审分级模板" />
          </div>
          <p className={legacy.hintText}>提交后该版本将自动设为当前生效版本；Agent 仍按各自 pin 的版本引用。</p>
        </div>
        <div className={legacy.modalFooter}>
          <div className={legacy.footerLeft} />
          <div className={legacy.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onSubmit(label || '手动提交')} disabled={busy}>{busy ? '提交中…' : '提交'}</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── 删除技能确认对话框 ───────────────────────────────────────────── */

function DeleteSkillDialog({ skill, bindCount, onClose, onDeleted, rpc }: {
  skill: SkillInfo
  bindCount: number
  onClose: () => void
  onDeleted: () => void
  rpc: CorumRpcCall
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doDelete = async () => {
    setBusy(true)
    try {
      const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'deleteSkill', { name: skill.name })
      if (!r.ok) { setError(r.error ?? '删除失败'); setBusy(false); return }
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog
      title="删除技能"
      message={<>确定删除技能「{skill.name}」吗？</>}
      warning={bindCount > 0 ? `该技能已绑定 ${bindCount} 个 Agent。删除后这些 Agent 将失去此技能，且不可恢复。` : undefined}
      error={error}
      confirmLabel="删除"
      busyLabel="删除中…"
      busy={busy}
      onConfirm={() => void doDelete()}
      onCancel={onClose}
    />
  )
}

/* ── 导入技能对话框（文件 / 文本粘贴 / 扫描目录）───────────────────── */

type ImportTab = 'file' | 'text' | 'scan'

function ImportSkillDialog({ onClose, onImported, rpc }: {
  onClose: () => void
  onImported: () => void
  rpc: CorumRpcCall
}) {
  const [tab, setTab] = useState<ImportTab>('file')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // file
  const [filePath, setFilePath] = useState('')
  // text
  const [textName, setTextName] = useState('')
  const [textContent, setTextContent] = useState('')
  // scan
  const [scanDir, setScanDir] = useState('')
  const [scanned, setScanned] = useState<ScannedSkill[] | null>(null)
  const [existing, setExisting] = useState<string[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }

  const importFile = () => run(async () => {
    const name = filePath.replace(/\/+$/, '').split('/').pop() ?? ''
    const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'importFromFile', { skillName: name, sourcePath: filePath })
    if (!r.ok) { setError(r.error ?? '导入失败'); return }
    onImported()
  })

  const importText = () => run(async () => {
    const r = await rpc<{ ok: boolean; error?: string }>('skillManager', 'importFromText', { skillName: textName, content: textContent })
    if (!r.ok) { setError(r.error ?? '导入失败'); return }
    onImported()
  })

  const doScan = () => run(async () => {
    const r = await rpc<{ skills: ScannedSkill[]; existing: string[] }>('skillManager', 'scanDirectory', { sourcePath: scanDir })
    setScanned(r.skills)
    setExisting(r.existing)
    setChecked(new Set(r.skills.filter(s => !r.existing.includes(s.name)).map(s => s.name)))
  })

  const importScanned = () => run(async () => {
    const r = await rpc<{ imported: number; skipped: number; failed: { name: string; error: string }[] }>('skillManager', 'importDirectory', { sourcePath: scanDir })
    if (r.failed.length > 0) { setError(`部分失败：${r.failed.map(f => f.name).join('、')}`); return }
    onImported()
  })

  const TABS: { id: ImportTab; label: string }[] = [
    { id: 'file', label: '从文件导入' },
    { id: 'text', label: '从文本粘贴' },
    { id: 'scan', label: '扫描目录' },
  ]

  return createPortal(
    <div className={legacy.modalOverlay} onClick={onClose}>
      <div className={legacy.modalDialog} onClick={e => e.stopPropagation()}>
        <div className={legacy.modalHeader}>
          <span className={legacy.modalTitle}>导入技能</span>
          <button type="button" className={legacy.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={legacy.modalBody}>
          <div className={legacy.transportPills}>
            {TABS.map(t => (
              <button key={t.id} type="button" className={`${legacy.transportPill}${tab === t.id ? ' ' + legacy.transportPillActive : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          {error && <p className={legacy.confirmWarn}>{error}</p>}

          {tab === 'file' && (
            <div className={legacy.formGroup}>
              <label className={legacy.fieldLabel}>技能目录或 SKILL.md 路径</label>
              <input className={legacy.fieldInput} value={filePath} onChange={e => setFilePath(e.target.value)} placeholder="/path/to/skill" />
              <p className={legacy.hintText}>需包含有效 frontmatter（name + description）的 SKILL.md。</p>
            </div>
          )}

          {tab === 'text' && (
            <>
              <div className={legacy.formGroup}>
                <label className={legacy.fieldLabel}>技能名称</label>
                <input className={legacy.fieldInput} value={textName} onChange={e => setTextName(e.target.value)} placeholder="my-skill" />
              </div>
              <div className={legacy.formGroup}>
                <label className={legacy.fieldLabel}>SKILL.md 内容</label>
                <textarea className={legacy.skillEditor} value={textContent} onChange={e => setTextContent(e.target.value)} rows={10} placeholder={'---\nname: my-skill\ndescription: 技能描述\n---\n在此粘贴 markdown 正文…'} />
                <p className={legacy.hintText}>frontmatter 必须包含 name 和 description 字段。</p>
              </div>
            </>
          )}

          {tab === 'scan' && (
            <>
              <div className={legacy.formGroup}>
                <label className={legacy.fieldLabel}>目录路径</label>
                <div className={legacy.formCols}>
                  <input className={legacy.fieldInput} value={scanDir} onChange={e => setScanDir(e.target.value)} placeholder="/Users/you/my-skills" style={{ flex: 1 }} />
                  <GlassButton onClick={() => void doScan()} disabled={busy || !scanDir}>扫描</GlassButton>
                </div>
              </div>
              {scanned !== null && (
                <div className={legacy.formGroup}>
                  <label className={legacy.fieldLabel}>识别到 {scanned.length} 个技能（已存在将跳过）</label>
                  {scanned.length === 0 && <p className={legacy.hintText}>该目录下未识别到技能。</p>}
                  {scanned.map(s => {
                    const exists = existing.includes(s.name)
                    return (
                      <label key={s.name} className={legacy.scanRow}>
                        <input
                          type="checkbox"
                          checked={checked.has(s.name)}
                          disabled={exists}
                          onChange={e => setChecked(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(s.name); else next.delete(s.name)
                            return next
                          })}
                        />
                        <span className={exists ? legacy.scanNameDim : legacy.scanName}>{s.name}</span>
                        <span className={legacy.scanDesc}>{s.description}</span>
                        {exists && <span className={legacy.scanExists}>已存在</span>}
                      </label>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
        <div className={legacy.modalFooter}>
          <div className={legacy.footerLeft} />
          <div className={legacy.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            {tab === 'file' && <GlassButton variant="primary" onClick={() => void importFile()} disabled={busy || !filePath}>{busy ? '导入中…' : '导入'}</GlassButton>}
            {tab === 'text' && <GlassButton variant="primary" onClick={() => void importText()} disabled={busy || !textName || !textContent}>{busy ? '导入中…' : '导入'}</GlassButton>}
            {tab === 'scan' && <GlassButton variant="primary" onClick={() => void importScanned()} disabled={busy || scanned === null || checked.size === 0}>{busy ? '导入中…' : `导入（${checked.size}）`}</GlassButton>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
