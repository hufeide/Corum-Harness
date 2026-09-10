/**
 * SettingsAgentPresetsSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Box, Brain, Check, ChevronLeft, ChevronRight, Cpu, Database, Ghost, Globe, Layers, Lock, Maximize2, Minimize2, Plus, Search, Server, Sparkles, Star, Trash2, Upload, X } from 'lucide-react'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { GlassButton, useCorumRpc, useSectionNav } from '../shared.tsx'
import { useDeveloperMode } from '../developer-mode.ts'
import type { SkillInfo, SkillVersion, SkillBinding, ProfileSummary, McpServerSummaryWire } from '../types.ts'
import type { CorumRpcCall } from '@corum/corum-rpc-client/client'
import css from '../SettingsSections.module.css'

/**
 * 「AI 润色」按钮的共享实现（设置页三处：人格 / 提示词 / 提示词放大态）。
 *
 * 为什么需要它：这三处此前是 `<button disabled title="即将上线">` 占位——违反已记录的
 * 设计红线（`.dbg/agent-presets-final-design.md` §三：「AI 润色要么做真的、要么隐藏，
 * 不留 disabled 占位」；`.dbg/agent-presets-pm-review.md` §四点名这是产品大忌：既暗示
 * 存在又宣告不可用）。宿主端润色能力（`corumAgent.polishConversation`）早已实现并被
 * composer 的 sparkle 按钮真实使用，故这里接真实现而不是删按钮。
 *
 * 与 composer 的差异：composer 带对话历史（润色提问）；设置页润色的是**Agent 定义文本**
 * （人格/提示词），无对话上下文，故 `history` 传空数组——宿主按「无历史」分支处理。
 * @param rpc - corum RPC 调用面（null 时按钮禁用）。
 * @returns 润色动作、进行中标志与最后一次错误。
 */
function usePolishSetting(rpc: CorumRpcCall | null): {
  polish: (text: string) => Promise<string | null>
  polishing: boolean
  error: string | null
} {
  const [polishing, setPolishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const polish = async (text: string): Promise<string | null> => {
    if (rpc === null || polishing || text.trim() === '') return null
    setPolishing(true)
    setError(null)
    try {
      const r = await rpc<{ polished?: string }>('corumAgent', 'polishConversation', {
        text,
        history: [],
      })
      const polished = r?.polished
      if (typeof polished !== 'string' || polished.trim() === '') {
        setError('润色未返回内容')
        return null
      }
      return polished
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setPolishing(false)
    }
  }
  return { polish, polishing, error }
}

/* ── Agent 预设（名片式 + 筛选 + 详情编辑）────────────────────────────── */

/** ProfileSummary 投影（与 host agent-service.ts 对齐）。 */
interface AgentProfileSummary {
  id: string
  nickname?: string
  title?: string
  domain?: string
  dimension?: string
  experience?: string
  persona?: string
  avatar?: string
  baseMode?: string
  prompt: string
  model: { provider: string; model: string; reasoningEffort?: string }
  /** 子 Agent 模型配置（可选，缺省同主 Agent）。 */
  subagentModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 研究子 Agent 模型配置（可选，缺省同 subagentModel）。 */
  researchModel?: { provider: string; model: string; reasoningEffort?: string }
  /** 并行开发策略（可选；fork #10 双实例行 config 的 profile 级覆盖）。 */
  parallelWork?: ParallelWorkDraft
  skills: SkillBinding[]
  mcpServers: string[]
  terminal: { mode: string }
  /** 记忆功能开关（UI 投影；持久化在 memoryPolicy.scope，'agent'=开启）。 */
  memoryEnabled?: boolean
  version: number
  trust: string
  source: 'corum' | 'official'
}

/** 并行开发策略的 UI 投影（与 host profile.ts ParallelWorkPolicy 逐字段对齐）。 */
interface ParallelWorkDraft {
  isolation?: 'always' | 'write-tasks' | 'off'
  worktreeRoot?: string
  branchPrefix?: string
  merger?: 'parent' | 'merger'
  maxParallelChildren?: number
  autoCleanup?: boolean
  denyDirectFs?: boolean
  integrateChecks?: string[]
}

const AGENT_DIMENSIONS = ['研发', '产品', '设计', '市场', '自媒体', '创作', '通用'] as const

/** 按 prompt 生成「擅长什么」摘要（取首行，去 markdown 标记）。 */
function promptToMotto(prompt: string): string {
  const first = prompt.split('\n').find(l => l.trim().length > 0) ?? ''
  return first.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim() || '—'
}

/** 推断岗位维度（profile 未显式设置时按 title/id 关键词兜底）。 */
function inferDimension(p: AgentProfileSummary): string {
  if (p.dimension !== undefined && p.dimension !== '') return p.dimension
  const text = `${p.title ?? ''} ${p.id}`.toLowerCase()
  if (/产品|pm|product/.test(text)) return '产品'
  if (/设计|design/.test(text)) return '设计'
  if (/市场|营销|market/.test(text)) return '市场'
  if (/自媒体|媒体|content/.test(text)) return '自媒体'
  if (/创作|写作|creative|writer/.test(text)) return '创作'
  return '研发'
}

/* 技能卡 icon 语义映射（设计稿 uC1P0：code-review→layers、research→search，默认 star） */
function skillIcon(name: string, size: number, className?: string) {
  const n = name.toLowerCase()
  if (/review|audit|层/.test(n)) return <Layers size={size} className={className} />
  if (/research|search|检索|调研/.test(n)) return <Search size={size} className={className} />
  return <Star size={size} className={className} />
}

/* 工具（MCP）卡 icon 语义映射（设计稿 LTUPo：filesystem→database、websearch→globe） */
function toolIcon(name: string, size: number, className?: string) {
  const n = name.toLowerCase()
  if (/file|fs|database|db|目录/.test(n)) return <Database size={size} className={className} />
  if (/web|search|http|browser|网/.test(n)) return <Globe size={size} className={className} />
  return <Server size={size} className={className} />
}

/* ── Agent 名片卡 ─────────────────────────────────────────────────────── */

function AgentCard({ profile, onClick, hideChevron }: { profile: AgentProfileSummary; onClick: () => void; hideChevron?: boolean }) {
  const dim = inferDimension(profile)
  return (
    <div className={css.agentCard} onClick={onClick} role="button">
      <div className={css.agentCardHead}>
        <div className={css.agentAvatar}>
          {profile.avatar !== undefined && profile.avatar !== ''
            ? <img className={css.agentAvatarImg} src={profile.avatar} alt="" />
            : <div className={css.agentAvatarPlaceholder} />}
        </div>
        <div className={css.agentNameCol}>
          <div className={css.agentNameRow}>
            <span className={css.agentNickname}>{profile.nickname ?? profile.id}</span>
            <span className={css.trustBadge}>{profile.trust === 'system' ? '系统' : '用户'}</span>
          </div>
          <span className={css.agentRole}>{profile.title ?? 'Agent'}</span>
        </div>
        {hideChevron !== true && <ChevronRight size={14} className={css.agentChevron} />}
      </div>
      <span className={css.agentMotto}>{promptToMotto(profile.prompt)}</span>
      {/* 经验行固定占位（设计稿 exp 行；无经验时留空占位保证名片等高） */}
      <span className={css.agentExp}>{profile.experience ?? ''}</span>
      <div className={css.agentModelRow}>
        <Cpu size={11} className={css.agentModelIcon} />
        <span className={css.agentInheritTag}>继承自 {baseModeLabel(profile.baseMode ?? (profile.source === 'official' ? profile.id : 'standard'))}</span>
        <span className={css.agentModelName}>{profile.model.model}</span>
        <span className={css.agentDimTag}>{dim}</span>
      </div>
    </div>
  )
}

/* ── 名片预览（编辑弹窗右上角）───────────────────────────────────────── */

function AgentCardPreview({ draft }: { draft: EditDraft }) {
  const pseudo: AgentProfileSummary = {
    id: draft.name || 'new-agent',
    ...(draft.nickname !== '' ? { nickname: draft.nickname } : {}),
    ...(draft.title !== '' ? { title: draft.title } : {}),
    ...(draft.domain !== '' ? { domain: draft.domain } : {}),
    ...(draft.dimension !== '' ? { dimension: draft.dimension } : {}),
    ...(draft.experience !== '' ? { experience: draft.experience } : {}),
    ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
    prompt: draft.prompt,
    model: { provider: draft.provider, model: draft.model },
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    terminal: { mode: draft.terminal },
    version: 1,
    trust: draft.trust,
    source: 'corum',
  }
  return (
    <div className={css.cardPreviewRow}>
      <span className={css.cardPreviewLabel}>名片预览 →</span>
      <div className={css.cardPreviewCard}>
        <AgentCard profile={pseudo} onClick={() => {}} />
      </div>
    </div>
  )
}

/* ── 官方模式只读卡 ──────────────────────────────────────────────────── */

const OFFICIAL_MODE_META: Record<string, { label: string; desc: string }> = {
  standard: { label: '标准模式', desc: '功能完整的编码 Agent，支持文件编辑 / Shell / 检索 / Skills' },
  ptc: { label: 'PTC 模式', desc: '标准模式 + Code Mode SDK 多步操作' },
  minimal: { label: '极简模式', desc: '仅持久 bash + 编辑器的双工具 Agent' },
  cordis: { label: '创造模式', desc: '用于创建自定义 Agent preset' },
}

function OfficialModeCard({ id }: { id: string }) {
  const meta = OFFICIAL_MODE_META[id] ?? { label: id, desc: '' }
  return (
    <div className={css.officialCard}>
      <div className={css.officialCardHead}>
        <Box size={13} className={css.officialCardIcon} />
        <span className={css.officialCardLabel}>{meta.label}</span>
        <span className={css.officialBadge}>官方</span>
        <span className={css.agentInheritTag}>继承自</span>
      </div>
      <span className={css.officialCardDesc}>{meta.desc}</span>
    </div>
  )
}

/* ── 编辑表单草稿 ────────────────────────────────────────────────────── */

interface EditDraft {
  name: string
  nickname: string
  title: string
  domain: string
  dimension: string
  experience: string
  persona: string
  avatar: string
  baseMode: string
  prompt: string
  provider: string
  model: string
  subEnabled: boolean
  subProvider: string
  subModel: string
  /** 研究子 Agent 模型（subagent_research 只读实例；缺省同子 Agent）。 */
  researchEnabled: boolean
  researchProvider: string
  researchModel: string
  /** 并行开发策略（undefined 段 = 跟随全局/默认）。 */
  pwIsolation: '' | 'always' | 'write-tasks' | 'off'
  pwMerger: '' | 'parent' | 'merger'
  pwMaxParallel: string
  pwIntegrateChecks: string
  terminal: 'sandbox' | 'host'
  /** 记忆功能开关（设计稿 GHBvv「记忆功能」switch；持久化在 memoryPolicy.scope）。 */
  memoryEnabled: boolean
  skills: SkillBinding[]
  mcpServers: string[]
  trust: 'system' | 'user'
}

function emptyDraft(): EditDraft {
  return {
    name: '', nickname: '', title: '', domain: '', dimension: '研发', experience: '', persona: '', avatar: '',
    baseMode: 'standard', prompt: '', provider: 'deepseek-official', model: 'deepseek-v4-flash',
    subEnabled: false, subProvider: 'deepseek-official', subModel: 'deepseek-v4-flash',
    researchEnabled: false, researchProvider: 'deepseek-official', researchModel: 'deepseek-v4-flash',
    pwIsolation: '', pwMerger: '', pwMaxParallel: '', pwIntegrateChecks: '',
    terminal: 'sandbox', memoryEnabled: false, skills: [], mcpServers: [], trust: 'user',
  }
}

function draftFromProfile(p: AgentProfileSummary): EditDraft {
  return {
    name: p.id,
    nickname: p.nickname ?? '',
    title: p.title ?? '',
    domain: p.domain ?? '',
    dimension: p.dimension ?? inferDimension(p),
    experience: p.experience ?? '',
    persona: p.persona ?? '',
    avatar: p.avatar ?? '',
    baseMode: p.baseMode ?? 'standard',
    prompt: p.prompt,
    provider: p.model.provider,
    model: p.model.model,
    // 子 Agent 模型回填：已配 → subEnabled + 回填 provider/model；未配 → subEnabled=false
    // （否则编辑已配子模型的 Agent 再保存会把 subagentModel 静默冲掉）。
    subEnabled: p.subagentModel !== undefined,
    subProvider: p.subagentModel?.provider ?? 'deepseek-official',
    subModel: p.subagentModel?.model ?? 'deepseek-v4-flash',
    researchEnabled: p.researchModel !== undefined,
    researchProvider: p.researchModel?.provider ?? 'deepseek-official',
    researchModel: p.researchModel?.model ?? 'deepseek-v4-flash',
    pwIsolation: p.parallelWork?.isolation ?? '',
    pwMerger: p.parallelWork?.merger ?? '',
    pwMaxParallel: p.parallelWork?.maxParallelChildren !== undefined ? String(p.parallelWork.maxParallelChildren) : '',
    pwIntegrateChecks: p.parallelWork?.integrateChecks?.join('\n') ?? '',
    terminal: (p.terminal.mode === 'host' ? 'host' : 'sandbox') as 'sandbox' | 'host',
    memoryEnabled: p.memoryEnabled === true,
    skills: p.skills,
    mcpServers: p.mcpServers,
    trust: (p.trust === 'system' ? 'system' : 'user') as 'system' | 'user',
  }
}

/** 从编辑草稿构造 parallelWork 载荷：全空 → 不带键（跟随全局/默认）。 */
function buildParallelWork(draft: EditDraft): { parallelWork?: ParallelWorkDraft } {
  const pw: ParallelWorkDraft = {}
  if (draft.pwIsolation !== '') pw.isolation = draft.pwIsolation
  if (draft.pwMerger !== '') pw.merger = draft.pwMerger
  const maxParallel = Number.parseInt(draft.pwMaxParallel, 10)
  if (draft.pwMaxParallel.trim() !== '' && Number.isInteger(maxParallel) && maxParallel > 0) pw.maxParallelChildren = maxParallel
  const checks = draft.pwIntegrateChecks.split('\n').map(s => s.trim()).filter(s => s !== '')
  if (checks.length > 0) pw.integrateChecks = checks
  return Object.keys(pw).length > 0 ? { parallelWork: pw } : {}
}

/* ── 虚位以待占位卡（每行不足 3 张时补齐）───────────────────────────── */

function PlaceholderCard() {
  return (
    // 占位卡与同行名片等高（flex 行 stretch），不写死高度。
    <div className={css.agentAddCard}>
      <Ghost size={16} style={{ color: 'var(--dsw-alias-label-dimmed)' }} />
      <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-dimmed)' }}>虚位以待</span>
    </div>
  )
}

/* ── 主 section（home / edit 两级 view）───────────────────────────────── */

type PresetsView =
  | { kind: 'home' }
  | { kind: 'edit'; profile: AgentProfileSummary | 'new' }

export function AgentPresetsSection() {
  const rpc = useCorumRpc()
  const [view, setView] = useState<PresetsView>({ kind: 'home' })
  const [profiles, setProfiles] = useState<AgentProfileSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dimFilter, setDimFilter] = useState<string>('全部')
  const [search, setSearch] = useState('')

  const reload = async () => {
    if (!rpc) return
    try {
      const r = await rpc<{ profiles: AgentProfileSummary[] }>('corumAgent', 'listProfiles', {})
      setProfiles(r.profiles)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void reload() }, [rpc])

  if (!rpc) return <p className={css.hintText}>Agent 服务未就绪。</p>

  if (view.kind === 'edit') {
    return (
      <EditPresetView
        key={view.profile === 'new' ? '__new__' : view.profile.id}
        profile={view.profile === 'new' ? undefined : view.profile}
        rpc={rpc}
        onBack={() => setView({ kind: 'home' })}
        onSaved={() => { setView({ kind: 'home' }); void reload() }}
      />
    )
  }

  const corumProfiles = (profiles ?? []).filter(p => p.source === 'corum')
  const officialProfiles = (profiles ?? []).filter(p => p.source === 'official')

  const filtered = corumProfiles.filter(p => {
    if (dimFilter !== '全部' && inferDimension(p) !== dimFilter) return false
    if (search !== '') {
      const q = search.toLowerCase()
      const hay = `${p.nickname ?? ''} ${p.id} ${p.title ?? ''} ${promptToMotto(p.prompt)}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })

  const rows: AgentProfileSummary[][] = []
  for (let i = 0; i < filtered.length; i += 3) rows.push(filtered.slice(i, i + 3))

  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>预设决定 Agent 的模型、技能与工具组合。点击名片进入 Agent 设置。</span>
        <GlassButton variant="primary" onClick={() => setView({ kind: 'edit', profile: 'new' })}>+ 新建预设</GlassButton>
      </div>

      <div className={css.agentFilterRow}>
        {(['全部', ...AGENT_DIMENSIONS] as const).map(d => (
          <button
            key={d}
            type="button"
            className={`${css.agentDimPill}${dimFilter === d ? ' ' + css.agentDimPillActive : ''}`}
            onClick={() => setDimFilter(d)}
          >{d}</button>
        ))}
        <div className={css.agentSearchBox}>
          <Search size={13} className={css.agentSearchIcon} />
          <input
            className={css.agentSearchInput}
            placeholder="搜索 Agent…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {error !== null && <p className={css.hintText}>加载失败:{error}</p>}
      {profiles === null && error === null && <p className={css.hintText}>加载中…</p>}
      {profiles !== null && filtered.length === 0 && (
        <p className={css.hintText}>{corumProfiles.length === 0 ? '暂无 Agent 预设，点击右上角「新建预设」创建。' : '没有匹配的 Agent。'}</p>
      )}

      <div className={css.agentCardGrid}>
        {rows.map((row, ri) => (
          <div key={ri} className={css.agentGridRow}>
            {row.map(p => (
              <AgentCard key={p.id} profile={p} onClick={() => setView({ kind: 'edit', profile: p })} />
            ))}
            {row.length < 3 && Array.from({ length: 3 - row.length }, (_, i) => (
              <PlaceholderCard key={`ph-${i}`} />
            ))}
          </div>
        ))}
      </div>

      {officialProfiles.length > 0 && (
        <div className={css.officialGroup}>
          <span className={css.officialGroupTitle}>官方基础模式</span>
          <div className={css.officialGrid}>
            <div className={css.officialRow}>
              {officialProfiles.slice(0, 2).map(p => <OfficialModeCard key={p.id} id={p.id} />)}
            </div>
            {officialProfiles.length > 2 && (
              <div className={css.officialRow}>
                {officialProfiles.slice(2, 4).map(p => <OfficialModeCard key={p.id} id={p.id} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/* ── 编辑/新建 Agent 预设二级页（左右分栏，按设计稿 GHBvv 落码）────────── */

/** 基础模式中文描述（继承自下拉 + 名片 inheritTag 共用）。 */
const BASE_MODE_LABELS: Record<string, string> = {
  standard: '标准模式（完整编码能力）',
  conductor: '指挥模式（只编排不亲手执行）',
  ptc: '多步操作模式',
  minimal: '极简双工具模式',
  cordis: '创造模式',
}

const BASE_MODE_OPTIONS = [
  { id: 'standard', label: BASE_MODE_LABELS.standard },
  { id: 'conductor', label: BASE_MODE_LABELS.conductor },
  { id: 'ptc', label: BASE_MODE_LABELS.ptc },
  { id: 'minimal', label: BASE_MODE_LABELS.minimal },
  { id: 'cordis', label: BASE_MODE_LABELS.cordis },
]

/** 取基础模式中文描述（未知名称回退原 id）。 */
function baseModeLabel(id: string): string {
  return BASE_MODE_LABELS[id] ?? id
}

const TERMINAL_OPTIONS = [
  { id: 'sandbox', label: 'sandbox' },
  { id: 'host', label: 'host' },
]

const DIMENSION_OPTIONS = AGENT_DIMENSIONS.map(d => ({ id: d, label: d }))

/** 模型下拉兜底目录（corumAgent/listModels 不可用时；与设计稿文案一致）。 */
const FALLBACK_PROVIDERS = [
  { id: 'deepseek-official', label: 'deepseek-official' },
  { id: 'pi-ai', label: 'pi-ai' },
]
const FALLBACK_MODELS = [
  { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { id: 'deepseek-v4', label: 'deepseek-v4' },
  { id: 'deepseek-r1', label: 'deepseek-r1' },
]

/** 子 Agent 模型未启用时的占位项（设计稿 iUSeO「（同主 Agent）」）。 */
const SAME_AS_MAIN = { id: '', label: '（同主 Agent）' }

function EditPresetView({ profile, rpc, onBack, onSaved }: {
  profile: AgentProfileSummary | undefined
  rpc: CorumRpcCall
  onBack: () => void
  onSaved: () => void
}) {
  const isNew = profile === undefined
  const [draft, setDraft] = useState<EditDraft>(() => isNew ? emptyDraft() : draftFromProfile(profile))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skillBindOpen, setSkillBindOpen] = useState(false)
  const [mcpBindOpen, setMcpBindOpen] = useState(false)
  const [promptZoom, setPromptZoom] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  // 人格 / 提示词两处的 AI 润色（接宿主真实现，替代原 disabled 占位）。
  const { polish, polishing } = usePolishSetting(rpc)
  const sectionNav = useSectionNav()
  const developerMode = useDeveloperMode()
  const fileRef = useRef<HTMLInputElement | null>(null)

  // 模型目录（corumAgent/listModels 动态加载；失败用兜底静态目录）。
  const [catalog, setCatalog] = useState<{ providers: typeof FALLBACK_PROVIDERS; modelsByProvider: Record<string, typeof FALLBACK_MODELS> }>(
    { providers: FALLBACK_PROVIDERS, modelsByProvider: {} },
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<{ providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> }>('corumAgent', 'listModels', {})
        if (cancelled) return
        const providers = r.providers.map(p => ({ id: p.id, label: p.name !== '' ? p.name : p.id }))
        const modelsByProvider: Record<string, typeof FALLBACK_MODELS> = {}
        for (const p of r.providers) modelsByProvider[p.id] = p.models.map(m => ({ id: m.id, label: m.name !== '' ? m.name : m.id }))
        setCatalog({ providers, modelsByProvider })
      } catch {
        // 静默用兜底目录（不阻断编辑页）。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  const mainProviderOptions = catalog.providers
  const mainModelOptions = catalog.modelsByProvider[draft.provider] ?? FALLBACK_MODELS

  // 技能目录（skillManager/listAll）：技能卡 desc 行显示技能描述（设计稿 VttzW/a0RSk）。
  const [skillDescMap, setSkillDescMap] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<{ skills: Array<{ name: string; description: string }> }>('skillManager', 'listAll', {})
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const s of r.skills) map[s.name] = s.description
        setSkillDescMap(map)
      } catch {
        // 静默：无描述时技能卡 desc 退回版本号。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])

  // MCP 服务器目录（mcpManager/listServers）：工具卡 desc 行显示服务描述（设计稿 V0OOkx/cMHCe）。
  const [mcpDescMap, setMcpDescMap] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const r = await rpc<{ servers: Array<{ name: string; description?: string }> }>('mcpManager', 'listServers', {})
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const s of r.servers) map[s.name] = s.description ?? ''
        setMcpDescMap(map)
      } catch {
        // 静默：无描述时工具卡 desc 退回服务名。
      }
    })()
    return () => { cancelled = true }
  }, [rpc])
  const subProviderOptions = [SAME_AS_MAIN, ...catalog.providers]
  const subModelOptions = draft.subEnabled
    ? [SAME_AS_MAIN, ...(catalog.modelsByProvider[draft.subProvider] ?? FALLBACK_MODELS)]
    : [SAME_AS_MAIN]

  const set = <K extends keyof EditDraft>(k: K, v: EditDraft[K]) => setDraft(prev => ({ ...prev, [k]: v }))

  const handleAvatarFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => { if (typeof reader.result === 'string') set('avatar', reader.result) }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  // AI 生成头像（接通）：按岗位/昵称生成方形头像，走项目 text_to_image 图片 API。
  const [aiGenBusy, setAiGenBusy] = useState(false)
  const handleAiGenAvatar = () => {
    if (aiGenBusy) return
    setAiGenBusy(true)
    const subject = (draft.title || draft.nickname || draft.name || 'AI agent').trim()
    const prompt = encodeURIComponent(
      `minimalist flat vector avatar icon for an AI assistant, role: ${subject}, soft gradient glass style, centered, clean background, high quality`,
    )
    set('avatar', `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${prompt}&image_size=square`)
    setAiGenBusy(false)
  }

  const doSave = async () => {
    const id = draft.name.trim().toLowerCase().replace(/\s+/g, '-')
    if (id === '') { setError('预设 ID 不能为空'); return }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { setError('预设 ID 只能包含小写字母、数字、连字符'); return }
    setBusy(true)
    setError(null)
    try {
      await rpc('corumAgent', 'saveProfile', {
        input: {
          id,
          ...(draft.nickname.trim() !== '' ? { nickname: draft.nickname.trim() } : {}),
          ...(draft.title.trim() !== '' ? { title: draft.title.trim() } : {}),
          ...(draft.domain.trim() !== '' ? { domain: draft.domain.trim() } : {}),
          dimension: draft.dimension,
          ...(draft.experience.trim() !== '' ? { experience: draft.experience.trim() } : {}),
          ...(draft.persona.trim() !== '' ? { persona: draft.persona.trim() } : {}),
          ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
          baseMode: draft.baseMode as EditDraft['baseMode'],
          prompt: draft.prompt,
          model: { provider: draft.provider, model: draft.model },
          ...(draft.subEnabled ? { subagentModel: { provider: draft.subProvider, model: draft.subModel } } : {}),
          ...(draft.researchEnabled ? { researchModel: { provider: draft.researchProvider, model: draft.researchModel } } : {}),
          ...buildParallelWork(draft),
          skills: draft.skills,
          mcpServers: draft.mcpServers,
          terminal: { mode: draft.terminal },
          // 记忆开关落 memoryPolicy.scope：开='agent'（专属记忆目录），关='none'。
          memoryPolicy: { scope: draft.memoryEnabled ? 'agent' : 'none' },
          // 开发者模式下编排的 Agent 固化为系统级预置（trust:'system'，不可删除）；
          // 非开发者模式新建为 user；已有 profile 保留原 trust。
          trust: developerMode ? 'system' : (isNew ? 'user' : draft.trust),
        },
      })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async () => {
    if (profile === undefined) return
    setBusy(true)
    try {
      await rpc('corumAgent', 'deleteProfile', { id: profile.id })
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Esc 缩小（设计稿 sBqOd：「Esc 缩小 · ⌘Z 撤销润色」）。
  // ⚠️ 必须用 capture 阶段：设置壳 dialog 的 bubble 阶段 Esc 处理器会关闭整个设置弹窗，
  //    capture 阶段先拿到事件并 stopPropagation，Esc 只缩小、不冒泡到壳。
  useEffect(() => {
    if (!promptZoom) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      setPromptZoom(false)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [promptZoom])

  // 提示词放大态（设计稿 sBqOd：单栏铺满内容区 — zoom-hd + big-area + hint）
  if (promptZoom) {
    return (
      <div className={css.promptZoomCol}>
        <div className={css.promptZoomHd}>
          <span className={css.promptZoomTitle}>提示词</span>
          <div className={css.promptZoomActions}>
            <button
              type="button"
              className={css.btnPolish}
              disabled={polishing || draft.prompt.trim() === ''}
              title={draft.prompt.trim() === '' ? '先填写提示词' : '用润色模型改写这段提示词'}
              onClick={() => {
                void polish(draft.prompt).then(next => { if (next !== null) set('prompt', next) })
              }}
            >
              <Sparkles size={11} />{polishing ? '润色中…' : 'AI 润色'}
            </button>
            <button type="button" className={css.btnGhost} onClick={() => setPromptZoom(false)}><Minimize2 size={12} />缩小</button>
          </div>
        </div>
        <div className={css.promptZoomArea}>
          <textarea
            className={css.promptZoomTextarea}
            value={draft.prompt}
            onChange={e => set('prompt', e.target.value)}
            placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。"
          />
        </div>
        <p className={css.hintText}>Esc 缩小 · ⌘Z 撤销润色</p>
      </div>
    )
  }

  const previewProfile: AgentProfileSummary = {
    id: draft.name || 'new-agent',
    ...(draft.nickname !== '' ? { nickname: draft.nickname } : {}),
    ...(draft.title !== '' ? { title: draft.title } : {}),
    ...(draft.dimension !== '' ? { dimension: draft.dimension } : {}),
    ...(draft.experience !== '' ? { experience: draft.experience } : {}),
    ...(draft.persona !== '' ? { persona: draft.persona } : {}),
    ...(draft.avatar !== '' ? { avatar: draft.avatar } : {}),
    prompt: draft.prompt,
    model: { provider: draft.provider, model: draft.model },
    skills: draft.skills,
    mcpServers: draft.mcpServers,
    terminal: { mode: draft.terminal },
    version: 1,
    trust: draft.trust,
    source: 'corum',
  }

  return (
    // 整页统一滚动（顶部一排 + 下方表单同处一个滚动流，操作体验优于局部滚动）。
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%', height: '100%', minHeight: 0, overflowY: 'auto' }}>
      {/* 返回行（设计稿 GHBvv KLRxp：纯文本幽灵行，非按钮） */}
      <button type="button" className={css.backRowGhost} onClick={onBack}>
        <ChevronLeft size={14} />返回 Agent 预设
      </button>

      {/* 顶部一排：基本信息（左）+ 名片预览（右） */}
      <div style={{ display: 'flex', gap: 20, width: '100%' }}>
        {/* 左：基本信息（设计稿 GHBvv basicCol: gap 4 + avatarRow gap 18，纵向居中） */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className={css.formGroupTitle}>基本信息</div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            {/* avatarCol：88 头像 + AI 生成钮 + 上传提示（纵向 gap 4，居中；AI 生成接通） */}
            <div className={css.avatarBlock}>
              <div className={css.avatarBox} onClick={() => fileRef.current?.click()} role="button">
                {draft.avatar !== ''
                  ? <img className={css.agentAvatarImg} src={draft.avatar} alt="" />
                  : <Upload size={32} className={css.avatarIcon} />}
              </div>
              <button type="button" className={css.btnAiGen} onClick={handleAiGenAvatar}>
                <Sparkles size={12} className={css.btnPolishIcon} />AI 生成
              </button>
              <span className={css.avatarHint}>点击上传头像</span>
            </div>
            {/* fieldsBlock：两列字段（组内 gap 14，纵向居中） */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14, justifyContent: 'center' }}>
              <div className={css.formCols}>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>预设 ID</label>
                  <input className={css.fieldInputSm} value={draft.name} onChange={e => set('name', e.target.value)} placeholder="my-agent" disabled={!isNew} />
                </div>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>昵称</label>
                  <input className={css.fieldInputSm} value={draft.nickname} onChange={e => set('nickname', e.target.value)} placeholder="我的 Agent" />
                </div>
              </div>
              <div className={css.formCols}>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>岗位 / 职位</label>
                  <input className={css.fieldInputSm} value={draft.title} onChange={e => set('title', e.target.value)} placeholder="如：前端工程师 / 测试 / PM" />
                </div>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>岗位维度（名片筛选）</label>
                  <SelectField value={draft.dimension} options={DIMENSION_OPTIONS} onChange={v => set('dimension', v)} variant="fill" />
                </div>
              </div>
              {/* 专业领域（覆盖模式组装进 persona：「You are an expert in the {domain} field」） */}
              <div className={css.formCols}>
                <div className={css.formCol} style={{ gap: 4 }}>
                  <label className={css.fieldLabelSm}>专业领域</label>
                  <input className={css.fieldInputSm} value={draft.domain} onChange={e => set('domain', e.target.value)} placeholder="如：软件开发 / 制造业 / 工程项目管理" />
                </div>
              </div>
            </div>
          </div>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarFile} />
        </div>

        {/* 右：名片预览（设计稿 prevCol: width 280, gap 4；预览卡 chev enabled:false，隐藏箭头） */}
        <div style={{ flex: 'none', width: 280, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div className={css.formGroupTitle}>名片预览</div>
          <AgentCard profile={previewProfile} onClick={() => {}} hideChevron />
        </div>
      </div>

      {/* 下方单一纵向表单列（设计稿 GHBvv formCol: gap 4；整页滚动流，不再局部滚动）。
          顺序 = 设计稿 formCol.children：继承 → 工作经验 → 人格 → 提示词 → 模型 → 技能+MCP → 终端/记忆 → 页脚。 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
        {/* 继承自（设计稿 GHBvv g-inherit：仅开发者模式显示；非开发者模式固定
            继承标准模式并覆盖其 persona，不展示该选项） */}
        {developerMode && (
          <div className={css.formGroup} style={{ gap: 3 }}>
            <label className={css.fieldLabel}>继承自</label>
            <SelectField value={draft.baseMode} options={BASE_MODE_OPTIONS} onChange={v => set('baseMode', v)} variant="fill" />
            <p className={css.fieldHint}>
              {draft.baseMode === 'standard'
                ? '标准模式将覆盖官方身份模板，使用你的人格与提示词'
                : `将继承「${baseModeLabel(draft.baseMode)}」的系统提示词与 persona`}
            </p>
          </div>
        )}

        {/* 工作经验（设计稿 GHBvv g-exp F73NUB：只读，基于 Agent 记忆自动总结；
            后续在「记忆管理」中维护，此处不可编辑） */}
        <div className={css.formGroup} style={{ gap: 3 }}>
          <div className={css.formGroupTitle}>工作经验</div>
          <div className={css.expReadBox}>
            <span className={css.expReadText}>{draft.experience || '暂无记忆摘要。'}</span>
          </div>
          <div className={css.expNoteRow}>
            <Lock size={11} className={css.expNoteIcon} />
            <span className={css.expNoteText}>基于 Agent 记忆自动总结 · 不可编辑</span>
          </div>
        </div>

        {/* 人格设置（设计稿 GHBvv g-persona：AI 润色在文本域内底部行，与字数统计同行） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitle}>人格设置</div>
          <label className={css.fieldLabel}>用一段话描述 Agent 的人格特质与行为倾向（不超过 500 字符）</label>
          <div className={css.promptArea}>
            <textarea
              className={css.promptTextarea}
              value={draft.persona}
              onChange={e => set('persona', e.target.value.slice(0, 500))}
              placeholder="务实、简洁、注重结果。接到任务后先理解目标再动手，不废话不拖延。"
              rows={3}
              maxLength={500}
            />
            <div className={css.promptActionsRow}>
              <span className={css.promptCount}>{draft.persona.length} / 500</span>
              <button
                type="button"
                className={css.btnPolish}
                disabled={polishing || draft.persona.trim() === ''}
                title={draft.persona.trim() === '' ? '先填写人格描述' : '用润色模型改写这段人格描述'}
                onClick={() => {
                  void polish(draft.persona).then(next => { if (next !== null) set('persona', next.slice(0, 500)) })
                }}
              >
                <Sparkles size={11} className={css.btnPolishIcon} />{polishing ? '润色中…' : 'AI 润色'}
              </button>
            </div>
          </div>
        </div>

        {/* 提示词（设计稿 GHBvv g-prompt：放大钮为 ghost 小钮；AI 润色在文本域内底部行） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitleRow}>
            <span className={css.formGroupTitle}>提示词</span>
            <button type="button" className={css.btnGhost} onClick={() => setPromptZoom(true)}><Maximize2 size={12} />放大</button>
          </div>
          <label className={css.fieldLabel}>自定义提示词（叠加在基础模式 persona 之上，非替代）</label>
          <div className={css.promptArea}>
            <textarea className={css.promptTextarea} value={draft.prompt} onChange={e => set('prompt', e.target.value)} placeholder="你是研发工程师。接到任务后简洁完成并调用 complete_task 上报。" rows={3} />
            <div className={css.promptActionsRow}>
              <button
                type="button"
                className={css.btnPolish}
                disabled={polishing || draft.prompt.trim() === ''}
                title={draft.prompt.trim() === '' ? '先填写提示词' : '用润色模型改写这段提示词'}
                onClick={() => {
                  void polish(draft.prompt).then(next => { if (next !== null) set('prompt', next) })
                }}
              >
                <Sparkles size={11} className={css.btnPolishIcon} />{polishing ? '润色中…' : 'AI 润色'}
              </button>
            </div>
          </div>
        </div>

        {/* 模型（设计稿 GHBvv g-model: model-row 横向两组，各 pair=供应商+模型两列并排，
            每个下拉上方有 10px tertiary 小字「供应商」「模型」标签） */}
        <div className={css.formGroup}>
          <div className={css.formGroupTitle}>模型</div>
          <div className={css.formColsStretch}>
            <div className={css.formCol} style={{ gap: 4 }}>
              <span className={css.formSubLabel}>主 Agent</span>
              <div className={css.selectStack}>
                <div className={css.formCol} style={{ gap: 3 }}>
                  <label className={css.fieldLabelSm}>供应商</label>
                  <SelectField value={draft.provider} options={mainProviderOptions} onChange={v => set('provider', v)} variant="fill" />
                </div>
                <div className={css.formCol} style={{ gap: 3 }}>
                  <label className={css.fieldLabelSm}>模型</label>
                  <SelectField value={draft.model} options={mainModelOptions} onChange={v => set('model', v)} variant="fill" />
                </div>
              </div>
            </div>
            <div className={css.formCol} style={{ gap: 4 }}>
              <span className={css.formSubLabel}>子 Agent（可选，缺省同主 Agent）</span>
              <div className={css.selectStack}>
                <div className={css.formCol} style={{ gap: 3 }}>
                  <label className={css.fieldLabelSm}>供应商</label>
                  <SelectField value={draft.subEnabled ? draft.subProvider : ''} options={subProviderOptions} onChange={v => { set('subEnabled', v !== ''); if (v !== '') set('subProvider', v) }} variant="fill" />
                </div>
                <div className={css.formCol} style={{ gap: 3 }}>
                  <label className={css.fieldLabelSm}>模型</label>
                  <SelectField value={draft.subEnabled ? draft.subModel : ''} options={subModelOptions} onChange={v => { if (v !== '') set('subModel', v) }} disabled={!draft.subEnabled} variant="fill" />
                </div>
              </div>
            </div>
            <div className={css.formCol} style={{ gap: 4 }}>
              <span className={css.formSubLabel}>研究子 Agent（只读实例，不可移除；可选，缺省同子 Agent）</span>
              <div className={css.selectStack}>
                <div className={css.formCol} style={{ gap: 3 }}>
                  <label className={css.fieldLabelSm}>供应商</label>
                  <SelectField value={draft.researchEnabled ? draft.researchProvider : ''} options={subProviderOptions} onChange={v => { set('researchEnabled', v !== ''); if (v !== '') set('researchProvider', v) }} variant="fill" />
                </div>
                <div className={css.formCol} style={{ gap: 3 }}>
                  <label className={css.fieldLabelSm}>模型</label>
                  <SelectField value={draft.researchEnabled ? draft.researchModel : ''} options={subModelOptions} onChange={v => { if (v !== '') set('researchModel', v) }} disabled={!draft.researchEnabled} variant="fill" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 并行开发（子 Agent 硬隔离编排；空 = 跟随全局/默认。机制：fork #10
            双实例——worker 召唤写任务自动独立 worktree+分支，integrate 召唤合并） */}
        <div className={css.formCol} style={{ gap: 6 }}>
          <div className={css.formGroupTitle}>并行开发</div>
          <div className={css.formColsStretch}>
            <div className={css.formCol} style={{ gap: 3 }}>
              <label className={css.fieldLabelSm}>隔离模式（默认 write-tasks：并发写任务隔离）</label>
              <SelectField
                value={draft.pwIsolation}
                options={[
                  { id: '', label: '（跟随全局/默认）' },
                  { id: 'write-tasks', label: 'write-tasks · 并发写任务隔离' },
                  { id: 'always', label: 'always · 凡召唤必隔离' },
                  { id: 'off', label: 'off · 不隔离' },
                ]}
                onChange={v => set('pwIsolation', v as EditDraft['pwIsolation'])}
                variant="fill"
              />
            </div>
            <div className={css.formCol} style={{ gap: 3 }}>
              <label className={css.fieldLabelSm}>合并者（默认 parent：主 Agent 合并）</label>
              <SelectField
                value={draft.pwMerger}
                options={[
                  { id: '', label: '（跟随全局/默认）' },
                  { id: 'parent', label: 'parent · 主 Agent 合并' },
                  { id: 'merger', label: 'merger · 专职合并子 Agent' },
                ]}
                onChange={v => set('pwMerger', v as EditDraft['pwMerger'])}
                variant="fill"
              />
            </div>
          </div>
          <div className={css.formColsStretch}>
            <div className={css.formCol} style={{ gap: 3 }}>
              <label className={css.fieldLabelSm}>并行子 Agent 上限（默认 4）</label>
              <input
                className={css.textInput}
                value={draft.pwMaxParallel}
                placeholder="4"
                onChange={e => set('pwMaxParallel', e.target.value)}
              />
            </div>
            <div className={css.formCol} style={{ gap: 3 }}>
              <label className={css.fieldLabelSm}>集成核查命令（每行一条，默认 pnpm -r typecheck）</label>
              <textarea
                className={css.textInput}
                rows={2}
                value={draft.pwIntegrateChecks}
                placeholder={'pnpm -r typecheck\npnpm lint'}
                onChange={e => set('pwIntegrateChecks', e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* 技能 + 工具（设计稿 GHBvv g-skill-mcp：双列各「2 卡网格 + 添加钮」，
            卡片 = icon+name(+tag) / ver+del 头行 + desc 行；右列标题「工具配置」） */}
        <div className={css.formColsStretch}>
          <div className={css.formCol} style={{ gap: 4 }}>
            <div className={css.formGroupTitle}>技能配置</div>
            <div className={css.skillCardGrid}>
              {draft.skills.slice(0, 2).map((s, i) => (
                <div key={`${s.name}-${i}`} className={css.skillCard}>
                  <div className={css.skillCardTop}>
                    <div className={css.skillCardLeft}>
                      {skillIcon(s.name, 13, css.skillCardIcon)}
                      <span className={css.skillCardName}>{s.name}</span>
                    </div>
                    <div className={css.skillCardRight}>
                      <span className={css.skillCardVer}>{s.versionId}</span>
                      <Trash2 size={12} className={css.listDel} onClick={() => set('skills', draft.skills.filter((_, idx) => idx !== i))} />
                    </div>
                  </div>
                  <span className={css.skillCardDesc}>{skillDescMap[s.name] || `绑定版本 ${s.versionId}`}</span>
                </div>
              ))}
              {draft.skills.length === 1 && <div className={css.skillCardPlaceholder} />}
            </div>
            <button type="button" className={css.btnAdd} onClick={() => setSkillBindOpen(true)}><Plus size={12} />添加技能</button>
          </div>
          <div className={css.formCol} style={{ gap: 4 }}>
            <div className={css.formGroupTitle}>MCP 配置</div>
            <div className={css.skillCardGrid}>
              {draft.mcpServers.slice(0, 2).map((s, i) => (
                <div key={`${s}-${i}`} className={css.skillCard}>
                  <div className={css.skillCardTop}>
                    <div className={css.skillCardLeft}>
                      {toolIcon(s, 13, css.skillCardIcon)}
                      <span className={css.skillCardName}>{s}</span>
                      <span className={css.skillCardTag}>MCP</span>
                    </div>
                    <div className={css.skillCardRight}>
                      <Trash2 size={12} className={css.listDel} onClick={() => set('mcpServers', draft.mcpServers.filter((_, idx) => idx !== i))} />
                    </div>
                  </div>
                  <span className={css.skillCardDesc}>{mcpDescMap[s] || s}</span>
                </div>
              ))}
              {draft.mcpServers.length === 1 && <div className={css.skillCardPlaceholder} />}
            </div>
            <button type="button" className={css.btnAdd} onClick={() => setMcpBindOpen(true)}><Plus size={12} />添加 MCP</button>
          </div>
        </div>

        {/* 终端 + 记忆（设计稿 GHBvv g-misc：终端模式 sel + 记忆功能 field(「默认关闭」+switch)） */}
        <div className={css.formColsStretch}>
          <div className={css.formCol} style={{ gap: 3 }}>
            <label className={css.fieldLabelSm}>终端模式</label>
            <SelectField value={draft.terminal} options={TERMINAL_OPTIONS} onChange={v => set('terminal', v as 'sandbox' | 'host')} variant="fill" />
          </div>
          <div className={css.formCol} style={{ gap: 3 }}>
            <label className={css.fieldLabelSm}>记忆功能</label>
            <div className={css.memoryField}>
              <span className={css.memoryState}>{draft.memoryEnabled ? '已开启' : '默认关闭'}</span>
              <Switch checked={draft.memoryEnabled} onChange={v => set('memoryEnabled', v)} />
            </div>
          </div>
        </div>

        {error !== null && <p className={css.hintText}>{error}</p>}

        {/* footer（设计稿 GHBvv footer s8r0w：左 信任级 badge + 记忆管理(brain)，
            右 删除(error)/取消/保存；删除走内联二次确认弹窗 confirm-pop） */}
        <div className={css.formGroup} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, position: 'relative' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className={css.trustLabel}>信任级</span>
            <span className={css.trustBadge}>{draft.trust}</span>
            {sectionNav !== null && (
              <button type="button" className={css.btnMemoryNav} onClick={() => sectionNav.openSection('memory')}>
                <Brain size={14} className={css.btnMemoryNavIcon} />记忆管理
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* 系统级预置 Agent（trust:'system'）不可删除，隐藏删除钮 */}
            {!isNew && draft.trust !== 'system' && (
              <button type="button" className={css.btnDeleteGhost} onClick={() => setConfirmDel(true)} disabled={busy}>
                <Trash2 size={13} className={css.btnDeleteIcon} />删除
              </button>
            )}
            <GlassButton onClick={onBack}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => void doSave()} disabled={busy}>{busy ? '保存中…' : isNew ? '创建' : '保存'}</GlassButton>
          </div>

          {/* 内联二次确认（统一确认框 inline 形态，设计稿 DKRwC confirm-pop） */}
          {confirmDel && profile !== undefined && (
            <ConfirmDialog
              placement="inline"
              title="删除该预设？"
              message="预设删除后不可恢复，此操作需要二次确认。"
              confirmLabel="确认删除"
              busy={busy}
              onConfirm={() => { setConfirmDel(false); void doDelete() }}
              onCancel={() => setConfirmDel(false)}
            />
          )}
        </div>
      </div>

      {/* 弹窗 */}
      {skillBindOpen && (
        <SkillBindDialog
          rpc={rpc}
          bound={draft.skills}
          onClose={() => setSkillBindOpen(false)}
          onConfirm={skills => { set('skills', skills); setSkillBindOpen(false) }}
        />
      )}
      {mcpBindOpen && (
        <McpBindDialog
          rpc={rpc}
          bound={draft.mcpServers}
          onClose={() => setMcpBindOpen(false)}
          onConfirm={servers => { set('mcpServers', servers); setMcpBindOpen(false) }}
        />
      )}
    </div>
  )
}

/* ── 技能绑定弹窗（设计稿 ExxZt）─────────────────────────────────────── */

function SkillBindDialog({ rpc, bound, onClose, onConfirm }: {
  rpc: CorumRpcCall
  bound: SkillBinding[]
  onClose: () => void
  onConfirm: (skills: SkillBinding[]) => void
}) {
  const [allSkills, setAllSkills] = useState<SkillInfo[] | null>(null)
  const [versionsMap, setVersionsMap] = useState<Record<string, SkillVersion[]>>({})
  const [checked, setChecked] = useState<Map<string, string>>(() => new Map(bound.map(b => [b.name, b.versionId])))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await rpc<{ skills: SkillInfo[] }>('skillManager', 'listAll', {})
        if (cancelled) return
        setAllSkills(r.skills)
        // 拉取每个技能的版本列表
        const entries = await Promise.all(r.skills.map(async s => {
          const h = await rpc<{ versions: SkillVersion[] }>('skillManager', 'getSkillHistory', { name: s.name })
          return [s.name, h.versions] as const
        }))
        if (cancelled) return
        const map: Record<string, SkillVersion[]> = {}
        for (const [name, versions] of entries) map[name] = versions
        setVersionsMap(map)
        setLoading(false)
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [rpc])

  const toggle = (name: string) => {
    setChecked(prev => {
      const next = new Map(prev)
      if (next.has(name)) next.delete(name)
      else {
        const versions = versionsMap[name] ?? []
        next.set(name, versions[versions.length - 1]?.id ?? '')
      }
      return next
    })
  }

  const setVersion = (name: string, versionId: string) => {
    setChecked(prev => new Map(prev).set(name, versionId))
  }

  const doConfirm = () => {
    const result: SkillBinding[] = [...checked.entries()]
      .filter(([, v]) => v !== '')
      .map(([name, versionId]) => ({ name, versionId }))
    onConfirm(result)
  }

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加技能</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>从全局技能库选择技能并绑定版本；一个 Agent 可绑定多个技能。</p>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {loading && <p className={css.hintText}>加载中…</p>}
          {!loading && allSkills !== null && allSkills.length === 0 && (
            <p className={css.hintText}>暂无技能，请先在「技能」页导入。</p>
          )}
          {(allSkills ?? []).map(s => {
            const isChecked = checked.has(s.name)
            const versions = versionsMap[s.name] ?? []
            // 设计稿 ExxZt：未选中行也显示版本选择器（dimmed 禁用态，值为最新版）
            const latest = versions[versions.length - 1]?.id ?? ''
            const displayVersion = isChecked ? (checked.get(s.name) ?? latest) : latest
            return (
              <div
                key={s.name}
                className={`${css.bindPickRow}${isChecked ? ' ' + css.bindPickRowActive : ''}`}
                onClick={() => toggle(s.name)}
                role="button"
              >
                <span className={`${css.bindCheckbox}${isChecked ? ' ' + css.bindCheckboxOn : ''}`}>
                  {isChecked && <Check size={10} className={css.bindCheckIcon} />}
                </span>
                <div className={css.bindPickMeta}>
                  <div className={css.bindPickName}>
                    <Star size={12} className={css.listIcon} />
                    <span className={css.skillLabel}>{s.name}</span>
                  </div>
                  <span className={css.bindPickDesc}>{s.description}</span>
                </div>
                {versions.length > 0 && (
                  <span
                    className={isChecked ? undefined : css.bindVersionDim}
                    onClick={e => e.stopPropagation()}
                  >
                    <SelectField
                      value={displayVersion}
                      options={versions.map(v => ({ id: v.id, label: v.id }))}
                      onChange={v => setVersion(s.name, v)}
                      disabled={!isChecked}
                      variant="compact"
                    />
                  </span>
                )}
              </div>
            )
          })}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={doConfirm}>绑定 {checked.size} 个技能</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/* ── MCP 绑定弹窗（设计稿 hMLsO）─────────────────────────────────────── */


function McpBindDialog({ rpc, bound, onClose, onConfirm }: {
  rpc: CorumRpcCall
  bound: string[]
  onClose: () => void
  onConfirm: (servers: string[]) => void
}) {
  const [servers, setServers] = useState<McpServerSummaryWire[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(() => new Set(bound))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const r = await rpc<{ servers: McpServerSummaryWire[] }>('mcpManager', 'listServers', {})
        if (!cancelled) { setServers(r.servers); setLoading(false) }
      } catch (e) {
        if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false) }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [rpc])

  const toggle = (name: string) => {
    setChecked(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  return createPortal(
    <div className={css.modalOverlay} onClick={onClose}>
      <div className={css.modalDialog} onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div className={css.modalHeader}>
          <span className={css.modalTitle}>添加 MCP 服务</span>
          <button type="button" className={css.modalClose} onClick={onClose}><X size={16} /></button>
        </div>
        <div className={css.modalBody}>
          <p className={css.hintText}>从全局 MCP 注册表选择服务授权给此 Agent；新服务请在「MCP 与集成」中注册。</p>
          {error !== null && <p className={css.hintText}>{error}</p>}
          {loading && <p className={css.hintText}>加载中…</p>}
          {!loading && servers !== null && servers.length === 0 && (
            <p className={css.hintText}>暂无 MCP 服务，请先在「MCP 与集成」中添加。</p>
          )}
          {(servers ?? []).map(s => {
            const isChecked = checked.has(s.name)
            const disabled = s.disabled === true
            return (
              <div
                key={s.name}
                className={`${css.bindPickRow}${isChecked ? ' ' + css.bindPickRowActive : ''}`}
                onClick={() => toggle(s.name)}
                role="button"
              >
                <span className={`${css.bindCheckbox}${isChecked ? ' ' + css.bindCheckboxOn : ''}`}>
                  {isChecked && <Check size={10} className={css.bindCheckIcon} />}
                </span>
                <div className={css.bindPickMeta}>
                  <div className={css.bindPickName}>
                    <span className={css.listDot} style={disabled ? { background: 'var(--dsw-alias-label-dimmed)' } : undefined} />
                    <span className={css.skillLabel}>{s.name}</span>
                  </div>
                  <span className={css.bindPickDesc}>{s.description ?? s.transport}{disabled ? ' · 已停用' : ''}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className={css.modalFooter}>
          <div className={css.footerLeft} />
          <div className={css.footerRight}>
            <GlassButton onClick={onClose}>取消</GlassButton>
            <GlassButton variant="primary" onClick={() => onConfirm([...checked])}>授权 {checked.size} 个服务</GlassButton>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
