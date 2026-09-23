/**
 * 记忆库产品页（**按维度**的通用实现）—— 供「智能体记忆」与「项目记忆」两个 section 复用。
 *
 * ## 页面职责
 *
 * 用户 2026-09-21 裁定：记忆维度**只有 Agent 和项目**（不做全局记忆），导航里
 * 「记忆」自成一组，含「全局设置 / 智能体记忆 / 项目记忆」三项。本组件就是后两项的
 * 实现——`scope` 由 section 注入，页内**不再是 Tab**（维度已经在导航里选了）。
 *
 * ```
 * 记忆 › 智能体记忆（scope='agent'）
 *   └─ 归属 chip 行     ← 该库「属于哪个 Agent」的分布 + 过滤
 *   └─ 列表（搜索 + 存续期/重要性过滤 + 单条操作）
 *   └─ 手动添加（带归属选择）
 *   └─ 危险操作（清空本维度）
 * 记忆 › 项目记忆（scope='project'）—— 同上，「归属」维度换成项目
 * ```
 *
 * ## 为什么归属性要单独过滤
 *
 * `scope` 是「记忆跟着谁走」（存储归属），`agentId` / `projectId` 是「这条是谁的」
 * （内容归属）。同一个 `scope='agent'` 库里会有多个 Agent 的记忆、同一个
 * `scope='project'` 库里会有多个项目的记忆 ⇒ 必须能按归属收窄，否则记忆一多就没法看。
 *
 * ## 诚实性纪律（PRD §6.1）
 *
 * 「清空」是**真删除**（走 host `clearFacts`，不是前端逐条删——前端捞 id 会在「列表
 * 加载后有新写入」时静默少删）。故一律经 {@link ConfirmDialog} 二次确认。
 * 未接线的批量选择/导出**不做**（宁可没有，不要「能点但不落盘」）。
 *
 * @module @corum/corum-memory/client/MemoryLibrary
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Badge, Button, Chip, ConfirmDialog, ErrorNote, GroupCard, Hint, Row, RowDesc, RowLabel,
  Select, TextInput, fmtAbsolute, fmtRelative,
} from './ui.tsx'
import type { MemoryCall } from './MemorySettingsPage.tsx'

/* ── host 同形投影类型 ─────────────────────────────────────────────── */

/** 记忆维度（与底座 `memoryScopeSchema` 同形；**只有两个**）。 */
export type MemoryScope = 'agent' | 'project'
type MemoryRetention = 'temporary' | 'short' | 'long' | 'permanent'

/** host `MemoryFactView` 的同形投影。 */
interface FactView {
  id: string
  entity: string
  relation: string
  fact: string
  importance: number
  validAt: number | null
  invalidAt: number | null
  source: string
  scope: MemoryScope
  agentId: string
  projectId: string
  retention: MemoryRetention
  expiresAt: number | null
  readCount: number
  supersedes: string[]
  evidence: string[]
  author: string
  createdAt: number
  lastAccessedAt: number | null
  effectiveScore: number
  applicable: boolean
  retained: boolean
}

/** host `MemoryFacet` 的同形投影。 */
interface Facet {
  id: string
  label: string
  count: number
}

/* ── 选项表 ────────────────────────────────────────────────────────── */

const RETENTION_LABEL: Record<MemoryRetention, string> = {
  temporary: '临时',
  short: '短期',
  long: '长期',
  permanent: '永久',
}

const RETENTION_FILTER = [
  { value: 'all', label: '全部存续期' },
  { value: 'temporary', label: '临时' },
  { value: 'short', label: '短期' },
  { value: 'long', label: '长期' },
  { value: 'permanent', label: '永久' },
] as const

const IMPORTANCE_FILTER = [
  { value: '0', label: '全部重要性' },
  { value: '30', label: '重要性 ≥ 30' },
  { value: '50', label: '重要性 ≥ 50' },
  { value: '70', label: '重要性 ≥ 70' },
] as const

const ADD_RETENTION = [
  { value: 'long', label: '长期' },
  { value: 'short', label: '短期' },
  { value: 'permanent', label: '永久' },
  { value: 'temporary', label: '临时' },
] as const

/** 归属下拉的「自定义…」哨兵值（与任何真实 id 都不冲突，因为 id 不含该串）。 */
const CUSTOM = '__custom__'

/** 每个维度的文案（把「记忆跟谁走」讲清楚）。 */
const SCOPE_COPY: Record<MemoryScope, {
  /** 导航/标题里的维度名。 */
  dimension: string
  /** 一句话说明「这个库是什么」。 */
  libraryDesc: string
  /** 归属选择器的标签。 */
  ownerLabel: string
  /** 归属选择器的说明。 */
  ownerDesc: string
  /** 归属 id 的占位（自定义手输时）。 */
  ownerPlaceholder: string
}> = {
  agent: {
    dimension: 'Agent',
    libraryDesc: '跟着 Agent 走：同一 Agent 跨会话、跨项目共享自己的经验。',
    ownerLabel: '归属 Agent',
    ownerDesc: '这条记忆跟着哪个 Agent 走（它跨会话、跨项目都能取到）。选「自定义…」可手输 id。',
    ownerPlaceholder: 'Agent id',
  },
  project: {
    dimension: '项目',
    libraryDesc: '跟着项目走：每个项目有自己的记忆库，参与该项目的 Agent 都能读到。',
    ownerLabel: '归属项目',
    ownerDesc: '这条记忆属于哪个项目（参与该项目的 Agent 都能读到）。选「自定义…」可手输 id。',
    ownerPlaceholder: '项目 id',
  },
}

/* ── 页面 ─────────────────────────────────────────────────────────── */

/**
 * 某个维度的记忆库页。
 *
 * @param props.scope - 维度（由 section 注入：'agent' = 智能体记忆；'project' = 项目记忆）。
 * @param props.call - host RPC（/api/memory/*）。
 * @param props.profileNames - agentId → 展示名（从 corumAgent/listProfiles 取；取不到回落 id）。
 * @param props.projectNames - projectId → 展示名（从 corumProject/listProjects 取）。
 * @returns 记忆库页节点。
 */
export function MemoryLibrary({ scope, call, profileNames, projectNames }: {
  scope: MemoryScope
  call: MemoryCall
  profileNames: Record<string, string>
  projectNames: Record<string, string>
}) {
  const copy = SCOPE_COPY[scope]
  /** 归属过滤：'' = 全部（不按归属过滤）。 */
  const [owner, setOwner] = useState<string>('')
  const [query, setQuery] = useState('')
  const [retentionFilter, setRetentionFilter] = useState<string>('all')
  const [importanceFilter, setImportanceFilter] = useState<string>('0')
  const [facts, setFacts] = useState<FactView[] | null>(null)
  const [facets, setFacets] = useState<Facet[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  const nameOf = useCallback((id: string): string => {
    if (id === '') return '未归属'
    return (scope === 'agent' ? profileNames[id] : projectNames[id]) ?? id
  }, [scope, profileNames, projectNames])

  const reload = useCallback(async () => {
    setError(null)
    try {
      const filter: Record<string, unknown> = { scope }
      if (owner !== '') {
        if (scope === 'agent') filter.agentId = owner
        else filter.projectId = owner
      }
      const [list, facets] = await Promise.all([
        // SRC 信封：`listFactsRemote(input)` ⇒ wire 名 `input`。
        call<FactView[], { input: Record<string, unknown> }>('memory', 'listFacts', { input: filter }),
        call<Facet[], { dimension: string; filter: Record<string, unknown> }>('memory', 'listFacets', {
          dimension: scope, filter: { scope },
        }),
      ])
      setFacts(list)
      setFacets(facets)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setFacts([])
      setFacets([])
    }
  }, [call, scope, owner])

  // 切维度（导航里换 section）时清掉归属过滤，避免把上一个维度的 id 带进新库。
  useEffect(() => { setOwner('') }, [scope])
  useEffect(() => { void reload() }, [reload])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const minImp = Number(importanceFilter)
    return (facts ?? []).filter(f => {
      if (retentionFilter !== 'all' && f.retention !== retentionFilter) return false
      if (f.importance < minImp) return false
      if (q !== '') {
        const hay = `${f.fact} ${f.entity} ${f.relation} ${f.source} ${f.evidence.join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [facts, query, retentionFilter, importanceFilter])

  /** 单条操作后刷新（整表重拉会让长列表滚动位置跳掉，故只重拉本页数据）。 */
  const afterMutate = useCallback(async () => { await reload() }, [reload])

  const withBusy = useCallback(async (id: string, fn: () => Promise<unknown>) => {
    setBusyId(id); setError(null)
    try { await fn(); await afterMutate() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusyId(null) }
  }, [afterMutate])

  const applicable = filtered.filter(f => f.applicable).length
  const ownerName = owner === '' ? '全部归属' : nameOf(owner)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}>
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {/* ── 维度说明 + 归属分布 ──────────────────────────────────── */}
      <GroupCard title={scope === 'agent' ? '智能体记忆' : '项目记忆'}>
        <div style={{ padding: '4px 0' }}><Hint>{copy.libraryDesc}</Hint></div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 0 2px 0' }}>
          <Chip active={owner === ''} onClick={() => setOwner('')}>
            全部 {copy.dimension} · {(facts ?? []).length}
          </Chip>
          {facets.map(f => (
            <Chip key={f.id} active={owner === f.id} onClick={() => setOwner(f.id)}
              title={f.id === '' ? '未归属任何 Agent / 项目' : f.id}>
              {nameOf(f.id)} · {f.count}
            </Chip>
          ))}
          {facets.length === 0 && facts !== null && <Hint>本库暂无记忆</Hint>}
        </div>
      </GroupCard>

      {/* ── 记忆列表 ─────────────────────────────────────────────── */}
      <GroupCard title={`记忆列表 · ${filtered.length} 条`}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '2px 0 6px 0' }}>
          <Hint>共 {(facts ?? []).length} 条 · 适用 {applicable} 条</Hint>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Select width={130} value={retentionFilter} options={RETENTION_FILTER} onChange={setRetentionFilter} />
            <Select width={140} value={importanceFilter} options={IMPORTANCE_FILTER} onChange={setImportanceFilter} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '0 0 6px 0' }}>
          <TextInput value={query} onChange={setQuery} placeholder="搜索事实 / 实体 / 关系 / 来源 / 证据…" />
        </div>

        {facts === null ? (
          <Hint>加载中…</Hint>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '6px 0' }}>
            <Hint>
              {(facts ?? []).length === 0
                ? '本库暂无记忆。记忆来源（Agent 沉淀 / 手动添加）尚未接入时，这里就是空的——不会显示任何假条目。'
                : '当前过滤条件下没有匹配的记忆。'}
            </Hint>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '2px 0' }}>
            {filtered.map(f => (
              <FactRow
                key={f.id}
                fact={f}
                busy={busyId === f.id}
                onInvalidate={() => void withBusy(f.id, () => call('memory', 'invalidate', { id: f.id }))}
                onImportance={next => void withBusy(f.id, () => call('memory', 'setImportance', { id: f.id, importance: next }))}
                onDelete={() => void withBusy(f.id, () => call('memory', 'deleteFact', { id: f.id }))}
              />
            ))}
          </div>
        )}
      </GroupCard>

      {/* ── 手动添加 ─────────────────────────────────────────────── */}
      <AddFactRow
        call={call}
        scope={scope}
        defaultOwner={owner}
        profileNames={profileNames}
        projectNames={projectNames}
        onAdded={afterMutate}
        onError={setError}
      />

      {/* ── 危险操作 ─────────────────────────────────────────────── */}
      <GroupCard title="危险操作">
        <Row control={
          <Button variant="danger" disabled={facts === null || filtered.length === 0} onClick={() => setConfirm(true)}>
            清空本{scope === 'agent' ? '维度' : '维度'}
          </Button>
        }>
          <RowLabel>清空「{copy.dimension}记忆」</RowLabel>
          <RowDesc>
            删除当前范围（{ownerName}{owner === '' ? ' 的全部记忆' : ''}）的全部记忆，不可恢复。
          </RowDesc>
        </Row>
      </GroupCard>

      {confirm && (
        <ConfirmDialog
          danger
          title={`清空「${copy.dimension}记忆」？`}
          desc={`将永久删除 ${filtered.length} 条记忆（${ownerName}）。删除后无法恢复。`}
          confirmLabel="确认清空"
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            // 按维度清（传 scope + 当前归属，不靠前端捞 id——捞 id 会漏删加载后的新写入）。
            const filter: Record<string, unknown> = { scope }
            if (owner !== '') {
              if (scope === 'agent') filter.agentId = owner
              else filter.projectId = owner
            }
            setConfirm(false)
            void withBusy('__clear__', () => call('memory', 'clearFacts', { filter }))
          }}
        />
      )}
    </div>
  )
}

/* ── 单条事实卡 ───────────────────────────────────────────────────── */

/**
 * 一条事实（设计稿 fact 行：l1 = 事实文本 + 存续期/状态徽标 + 操作；l2 = 强度条 + 元信息）。
 *
 * 操作三件与底座能力一一对应：`setImportance`（↑重要 / ↓压底）、`invalidate`
 * （标失效，仅 applicable 时显示）、`deleteFact`（硬删除）。
 */
function FactRow({ fact, busy, onInvalidate, onImportance, onDelete }: {
  fact: FactView
  busy: boolean
  onInvalidate: () => void
  onImportance: (next: number) => void
  onDelete: () => void
}) {
  const [confirmDel, setConfirmDel] = useState(false)
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 5, padding: '7px 10px', borderRadius: 10,
        border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
        background: 'var(--corum-glass-2, rgba(255,255,255,0.12))',
        opacity: fact.applicable ? 1 : 0.62,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          onClick={() => setExpanded(v => !v)}
          title="点击展开全文 / 证据链"
          style={{
            flex: 1, minWidth: 0, fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)',
            fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
            lineHeight: 1.45, cursor: 'pointer',
            ...(expanded ? {} : { whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }),
          }}
        >{fact.fact}</span>
        <Badge tone={fact.retention === 'permanent' ? 'brand' : 'neutral'}>{RETENTION_LABEL[fact.retention]}</Badge>
        {!fact.applicable && <Badge tone="warn">已失效</Badge>}
        {!fact.retained && <Badge tone="warn">已到期</Badge>}
        <span style={{ display: 'flex', gap: 4, flex: 'none' }}>
          <Button disabled={busy} onClick={() => onImportance(Math.min(100, fact.importance + 10))} title="重要性 +10">↑ 重要</Button>
          <Button disabled={busy} onClick={() => onImportance(Math.max(0, fact.importance - 10))} title="重要性 -10（压底）">↓ 压底</Button>
          {fact.applicable && <Button disabled={busy} onClick={onInvalidate} title="标记为「不再成立」（可逆）">标失效</Button>}
          <Button variant="danger" disabled={busy} onClick={() => setConfirmDel(true)}>删除</Button>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'flex', width: 80, height: 4, borderRadius: 2, background: 'var(--corum-glass-3, rgba(255,255,255,0.18))', overflow: 'hidden', flex: 'none' }}>
          <span style={{ width: `${Math.max(0, Math.min(100, fact.effectiveScore))}%`, height: 4, background: 'var(--dsw-alias-brand-primary)' }} />
        </span>
        <span style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)', minWidth: 14 }}>
          {Math.round(fact.effectiveScore)}
        </span>
        <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
          {[
            `重要 ${fact.importance}`,
            fact.entity !== '' ? `实体 ${fact.entity}` : '',
            fact.source !== '' ? `来源 ${fact.source}` : '',
            `使用 ${fact.readCount} 次`,
            `创建 ${fmtRelative(fact.createdAt)}`,
            `最后使用 ${fmtRelative(fact.lastAccessedAt)}`,
            fact.expiresAt !== null ? `到期 ${fmtRelative(fact.expiresAt)}` : '永不遗忘',
          ].filter(s => s !== '').join('  ·  ')}
        </span>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
          {fact.relation !== '' && <Hint>关系：{fact.relation}</Hint>}
          <Hint>
            归属：{(fact.scope === 'agent' ? fact.agentId : fact.projectId) === '' ? '未归属' : (fact.scope === 'agent' ? fact.agentId : fact.projectId)}
            {' · '}作者：{fact.author}
          </Hint>
          <Hint>id：{fact.id}</Hint>
          {fact.evidence.length > 0 && <Hint>证据链：{fact.evidence.join(' / ')}</Hint>}
          {fact.supersedes.length > 0 && <Hint>取代了 {fact.supersedes.length} 条旧记忆（{fact.supersedes.join(', ')}）</Hint>}
          <Hint>创建于 {fmtAbsolute(fact.createdAt)}{fact.lastAccessedAt !== null ? ` · 最后使用 ${fmtAbsolute(fact.lastAccessedAt)}` : ''}</Hint>
        </div>
      )}
      {confirmDel && (
        <ConfirmDialog
          danger
          title="删除这条记忆？"
          desc={`将永久删除「${fact.fact}」。硬删除不可恢复（若要保留证据，用「标失效」）。`}
          confirmLabel="确认删除"
          onCancel={() => setConfirmDel(false)}
          onConfirm={() => { setConfirmDel(false); onDelete() }}
        />
      )}
    </div>
  )
}

/* ── 手动添加一条记忆 ─────────────────────────────────────────────── */

/**
 * 手动添加一行（设计稿 `card-手动添加`）。
 *
 * 落库走 `putFact`，`author='user'` —— 底座的持久化判定规则 3 会把手动添加落到
 * **至少长期**（写方未声明时）。存续期选择器默认「长期」，hint 说明「写永久需显式
 * 声明」，避免用户以为选了不生效（其实显式声明是生效的——写方显式优先）。
 *
 * **归属选择器**：`scope` 决定「这条记忆跟着谁走」，而 `agentId` / `projectId` 决定
 * 「这条是谁的」。用户口径要的正是后者，所以添加时必须能选归属——否则从 UI 添加的
 * 记忆永远是「未归属」，记忆库的归属 chip 就成了只读摆设。
 */
function AddFactRow({ call, scope, defaultOwner, profileNames, projectNames, onAdded, onError }: {
  call: MemoryCall
  scope: MemoryScope
  defaultOwner: string
  profileNames: Record<string, string>
  projectNames: Record<string, string>
  onAdded: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const copy = SCOPE_COPY[scope]
  const [text, setText] = useState('')
  const [retention, setRetention] = useState<string>('long')
  const [owner, setOwner] = useState<string>(defaultOwner)
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)

  // 当前归属过滤变了（用户点了别的 chip）⇒ 添加表单跟着走，避免「看着 pm 的列表、
  // 添加却进了未归属」的错位。
  useEffect(() => { setOwner(defaultOwner) }, [defaultOwner])

  /** 归属下拉项：已有归属（带展示名）+ 「未归属」+ 「自定义…」（手输）。 */
  const ownerOptions = useMemo(() => {
    const names = scope === 'agent' ? profileNames : projectNames
    return [
      { value: '', label: '未归属' },
      ...Object.keys(names).map(id => ({ value: id, label: names[id] ?? id })),
      { value: CUSTOM, label: '自定义…' },
    ]
  }, [scope, profileNames, projectNames])

  const submit = useCallback(async () => {
    const fact = text.trim()
    if (fact === '') return
    const ownerId = owner === CUSTOM ? custom.trim() : owner
    setBusy(true); onError(null)
    try {
      // ⚠️ SRC 信封：wire 名 = host 侧形参名，故 `putFactRemote(input)` 收 `{ input }`。
      await call('memory', 'putFact', {
        input: {
          fact,
          scope,
          retention,
          author: 'user',
          ...(scope === 'agent' && ownerId !== '' ? { agentId: ownerId } : {}),
          ...(scope === 'project' && ownerId !== '' ? { projectId: ownerId } : {}),
        },
      })
      setText('')
      setCustom('')
      await onAdded()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [call, text, scope, retention, owner, custom, onAdded, onError])

  return (
    <GroupCard title="手动添加一条记忆">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px' }}>
        <TextInput
          value={text}
          onChange={setText}
          disabled={busy}
          onEnter={() => { void submit() }}
          placeholder="写一条事实，例如「用户偏好暗色主题」…"
        />
        {owner === CUSTOM && (
          <TextInput value={custom} onChange={setCustom} disabled={busy} placeholder={copy.ownerPlaceholder} />
        )}
        <Select width={110} value={retention} options={ADD_RETENTION} onChange={setRetention} disabled={busy} />
        <Button variant="primary" disabled={busy || text.trim() === ''} onClick={() => { void submit() }}>添加</Button>
      </div>
      <Row control={<Select width={180} value={owner} options={ownerOptions} onChange={setOwner} disabled={busy} />}>
        <RowLabel>{copy.ownerLabel}</RowLabel>
        <RowDesc>{copy.ownerDesc}</RowDesc>
      </Row>
      <Hint>
        落到「{copy.dimension}记忆」库。手动添加按底座规则落「长期」；写「永久」需显式声明
        （用于纪律类事实）。写入门槛与自动沉淀共用同一套策略（见「记忆 › 全局设置」）。
      </Hint>
    </GroupCard>
  )
}
