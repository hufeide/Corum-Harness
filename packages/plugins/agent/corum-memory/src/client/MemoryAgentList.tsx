/**
 * 「记忆 › 智能体记忆」第一步：**Agent 列表**（设计稿 `设置 · 记忆 · 智能体记忆 · Agent 列表 · 深色 v4`）。
 *
 * ## 为什么先有列表（用户 2026-09-21 裁定）
 *
 * > 「Agent 的记忆其中应该是先有个 Agent 列表，列出已经开启记忆的 Agent，点击进去后，
 * > 可以进入一个三维的 Agent 记忆空间。」
 *
 * 列表的**真源**是 `corumAgent/listProfiles` 的 `memoryEnabled`（= 服务侧
 * `memoryPolicy.scope !== 'none'`）——只有开了记忆的 Agent 才出现在这里；每个 Agent
 * 后面挂它在 `scope='agent'` 库里的条数。**点进去**才进 3D 空间（{@link MemorySpace}）。
 *
 * ## 为什么「有记忆的」与「已开记忆」分开显示
 *
 * 开了记忆但还没沉淀出东西的 Agent 同样是有效状态（用户刚开启、或该 Agent 还没干活）。
 * 把它藏起来会让用户以为「开关没生效」；把它和有内容的混在一起又要每条去比对条数。
 * 故列表分两段：有记忆的（可点进去）在前，已开但尚无记忆的在后（点进去是空态）。
 *
 * 未开记忆的 Agent **不出现**——这是刻意的：此处是「记忆管理」入口，不是 Agent 名册；
 * 想看全部 Agent 去「智能体 › 智能体设置」。
 *
 * @module @corum/corum-memory/client/MemoryAgentList
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, ErrorNote, GroupCard, Hint, TextInput } from './ui.tsx'
import type { MemoryCall } from './MemorySettingsPage.tsx'

/** `corumAgent/listProfiles` 的行投影（只取本页用到的字段）。 */
export interface AgentSummary {
  id: string
  nickname?: string
  title?: string
  /** 记忆功能开关（真源 `memoryPolicy.scope !== 'none'`）。 */
  memoryEnabled?: boolean
}

/** 一个 Agent 在记忆库里的汇总。 */
interface AgentStat {
  /** 记忆条数（scope='agent' + 该 agentId）。 */
  count: number
  /** 其中 permanent 的条数（「含 N 条永久」）。 */
  permanent: number
  /** 最近一条记忆的时间（0 = 无）。 */
  lastAt: number
}

/**
 * 「智能体记忆」的 Agent 列表页。
 *
 * @param props.call - host RPC。
 * @param props.onOpen - 点某个 Agent 时进入它的 3D 记忆空间。
 * @returns Agent 列表页节点。
 */
export function MemoryAgentList({ call, onOpen }: {
  call: MemoryCall
  onOpen: (agent: AgentSummary) => void
}) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null)
  const [stats, setStats] = useState<Record<string, AgentStat>>({})
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const [{ profiles }, facts] = await Promise.all([
        call<{ profiles: AgentSummary[] }>('corumAgent', 'listProfiles', {}),
        // 一次拿全 Agent 库，本地按 agentId 聚合——比「每个 Agent 问一次」少 N-1 次 RPC。
        call<Array<{ agentId: string, retention: string, createdAt: number }>, { input: Record<string, unknown> }>(
          'memory', 'listFacts', { input: { scope: 'agent' } },
        ),
      ])
      const byAgent: Record<string, AgentStat> = {}
      for (const f of facts) {
        const key = f.agentId === '' ? '' : f.agentId
        const cur = byAgent[key] ?? { count: 0, permanent: 0, lastAt: 0 }
        cur.count += 1
        if (f.retention === 'permanent') cur.permanent += 1
        if (f.createdAt > cur.lastAt) cur.lastAt = f.createdAt
        byAgent[key] = cur
      }
      setAgents(profiles.filter(p => p.memoryEnabled === true))
      setStats(byAgent)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setAgents([])
    }
  }, [call])

  useEffect(() => { void load() }, [load])

  const nameOf = useCallback((a: AgentSummary): string => a.nickname ?? a.title ?? a.id, [])

  /** 开了记忆的 Agent，按「有记忆 / 无记忆」分段 + 搜索过滤。 */
  const { withFacts, withoutFacts } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (agents ?? []).filter(a =>
      q === '' || nameOf(a).toLowerCase().includes(q) || a.id.toLowerCase().includes(q),
    )
    return {
      withFacts: list.filter(a => (stats[a.id]?.count ?? 0) > 0),
      withoutFacts: list.filter(a => (stats[a.id]?.count ?? 0) === 0),
    }
  }, [agents, stats, query, nameOf])

  const total = Object.values(stats).reduce((n, s) => n + s.count, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      <GroupCard title="开启了记忆的 Agent">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '4px 0 8px 0' }}>
          <Hint>每个 Agent 有自己的记忆空间（跨会话、跨项目）。点进去看它的记忆分层，并对单条做修剪或改档。</Hint>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 'none' }}>
            <Stat value={String(agents?.length ?? 0)} label="已开记忆" />
            <Stat value={String(withFacts.length)} label="有记忆的" />
            <Stat value={String(total)} label="记忆总条数" />
          </div>
        </div>
        <div style={{ padding: '0 0 6px 0' }}>
          <TextInput value={query} onChange={setQuery} placeholder="搜索 Agent 名或 id…" />
        </div>

        {agents === null ? (
          <Hint>加载中…</Hint>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '2px 0' }}>
              {withFacts.map(a => (
                <AgentRow key={a.id} agent={a} stat={stats[a.id]} onOpen={onOpen} />
              ))}
              {withFacts.length === 0 && (
                <Hint>{query.trim() === '' ? '还没有任何 Agent 沉淀出记忆——记忆来源接入后会出现在这里。' : '没有匹配的 Agent。'}</Hint>
              )}
            </div>
            {withoutFacts.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 0 4px 0' }}>
                  <Hint>已开启记忆 · 尚无沉淀</Hint>
                  <span style={{ flex: 1 }} />
                  <Hint>{withoutFacts.length} 个</Hint>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '2px 0' }}>
                  {withoutFacts.map(a => (
                    <AgentRow key={a.id} agent={a} stat={undefined} onOpen={onOpen} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </GroupCard>

      <Hint>
        只列出<strong>已开启记忆</strong>的 Agent。要开关某个 Agent 的记忆，去「智能体 › 智能体设置」编辑它。
      </Hint>
    </div>
  )
}

/** 汇总数字（列表右上）。 */
function Stat({ value, label }: { value: string, label: string }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end', flex: 'none' }}>
      <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 16, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' }}>{value}</span>
      <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>{label}</span>
    </span>
  )
}

/**
 * 一行 Agent（头像 + 名字 + 岗位 + 条数 + 箭头）。
 *
 * 整行可点（`onClick` 在容器上）而不是只点箭头：列表项的可点区域应当等于它看起来的
 * 面积，只让 16px 箭头可点是最常见的「点了没反应」来源。
 */
function AgentRow({ agent, stat, onOpen }: {
  agent: AgentSummary
  stat: AgentStat | undefined
  onOpen: (agent: AgentSummary) => void
}) {
  const [hover, setHover] = useState(false)
  const name = agent.nickname ?? agent.title ?? agent.id
  const initials = name.slice(0, 2).toUpperCase()
  const count = stat?.count ?? 0
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(agent)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(agent) } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 8px',
        borderRadius: 11, cursor: 'pointer',
        background: count > 0 || hover ? 'var(--corum-glass-2, rgba(255,255,255,0.12))' : 'transparent',
        border: `1px solid ${hover ? 'var(--corum-glass-border-active, var(--dsw-alias-brand-primary))' : 'transparent'}`,
        opacity: count > 0 ? 1 : 0.72,
      }}
    >
      <span style={{
        width: 30, height: 30, borderRadius: 9, flex: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--corum-glass-3, rgba(255,255,255,0.18))',
        border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
        fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 11, fontWeight: 700,
        color: 'var(--dsw-alias-brand-primary)',
      }}>{initials}</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{name}</span>
          {count === 0 && <Badge tone="neutral">尚无记忆</Badge>}
        </span>
        <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{agent.id}</span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-end', flex: 'none' }}>
        <span style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>
          {count === 0 ? '—' : `${count} 条`}
        </span>
        <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
          {count === 0 ? '尚未沉淀' : (stat !== undefined && stat.permanent > 0 ? `含 ${stat.permanent} 条永久` : '长期为主')}
        </span>
      </span>
      <span aria-hidden style={{ flex: 'none', color: 'var(--dsw-alias-label-tertiary)', fontSize: 14 }}>›</span>
    </div>
  )
}
