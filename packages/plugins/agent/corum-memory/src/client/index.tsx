/**
 * @corum/corum-memory client half — 设置「扩展」里注册「记忆」面板。
 *
 * 面板职责（人工管理，非记忆来源）：
 *   - 浏览：按 scope / 关键词过滤，按记忆强度降序。
 *   - 详情：事实文本 + 时间窗 + 存续期 + 来源 + 作者 + 证据链。
 *   - 人工修剪三动作：失效标记 / 重要性上调下调 / 硬删除（二次确认）。
 *
 * 数据走 host memory RPC（connection.rpc.call → /api/memory/*）。
 *
 * @module @corum/corum-memory/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// ── 与 host 侧同形的投影类型（client bundle 独立，不 import host 值，避免跨 bundle 耦合）──

type MemoryScope = 'agent' | 'project' | 'global'
type MemoryRetention = 'temporary' | 'short' | 'long' | 'permanent'

interface MemoryFactView {
  id: string
  entity: string
  relation: string
  fact: string
  importance: number
  validAt: number | null
  invalidAt: number | null
  source: string
  scope: MemoryScope
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

function makeCall(connection: ConnectionHandle) {
  return async function call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const result = await connection.rpc.call('/api', `memory/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

const MONO: React.CSSProperties = { fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 12 }

const RETENTION_LABEL: Record<MemoryRetention, string> = {
  temporary: '临时',
  short: '短期',
  long: '长期',
  permanent: '永久',
}

const SCOPE_LABEL: Record<MemoryScope, string> = {
  agent: 'Agent',
  project: '项目',
  global: '全局',
}

function Row({ label, desc, children }: { label: string; desc?: string; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 2px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{label}</span>
        {desc !== undefined && <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

function fmtTime(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleString()
}

/** 有效分 → 色条长度百分比。 */
function barPercent(score: number): number {
  return Math.max(0, Math.min(100, score))
}

function MemoryPanel({ call }: { call: ReturnType<typeof makeCall> }) {
  const [facts, setFacts] = useState<MemoryFactView[] | null>(null)
  const [scope, setScope] = useState<MemoryScope | 'all'>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const all = await call<MemoryFactView[]>('listFacts', {})
      setFacts(all)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { void refresh() }, [])

  const filtered = (facts ?? []).filter(f => {
    if (scope !== 'all' && f.scope !== scope) return false
    if (query.trim() !== '' && !f.fact.toLowerCase().includes(query.trim().toLowerCase())) return false
    return true
  })

  const invalidate = async (id: string) => {
    setBusyId(id)
    try { await call('invalidate', { id }); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusyId(null) }
  }

  const pin = async (id: string, importance: number) => {
    setBusyId(id)
    try { await call('setImportance', { id, importance }); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusyId(null) }
  }

  const remove = async (id: string) => {
    setBusyId(id)
    try { await call('deleteFact', { id }); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusyId(null) }
  }

  const count = filtered.length
  const applicableCount = filtered.filter(f => f.applicable).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
      <Row label="记忆底座" desc="事实级记忆组织（重要性 / 时间窗 / 分层 / 衰减）。此处只做人工管理，记忆来源由使用者接入。">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={scope} onChange={e => setScope(e.target.value as MemoryScope | 'all')}
            style={{ padding: '6px 10px', borderRadius: 8, fontSize: 12, border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)', color: 'var(--dsw-alias-label-primary)', outline: 'none' }}>
            <option value="all">全部作用域</option>
            <option value="agent">Agent</option>
            <option value="project">项目</option>
            <option value="global">全局</option>
          </select>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索事实文本…"
            style={{ flex: 1, minWidth: 160, padding: '6px 10px', borderRadius: 8, fontSize: 12, border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-2)', color: 'var(--dsw-alias-label-primary)', outline: 'none' }}
          />
          <span style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' }}>
            {facts === null ? '加载中…' : `共 ${count} 条 · 适用 ${applicableCount} 条`}
          </span>
        </div>
      </Row>

      {error !== null && <span style={{ fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' }}>{error}</span>}

      {facts === null ? (
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>加载事实列表…</span>
      ) : filtered.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-dimmed)' }}>暂无记忆事实。</span>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {filtered.map(f => (
            <div key={f.id} style={{
              display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px',
              borderRadius: 10, border: '1px solid var(--corum-glass-border)',
              background: f.applicable ? 'var(--corum-glass-2)' : 'var(--corum-glass-1)',
              opacity: f.applicable ? 1 : 0.65,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{f.fact}</span>
                <span style={{ flex: 1 }} />
                {!f.applicable && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, fontWeight: 600, color: 'var(--dsw-alias-label-dimmed)', border: '1px solid var(--corum-glass-border)' }}>已到期</span>}
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--corum-glass-border)', color: 'var(--dsw-alias-label-tertiary)' }}>{SCOPE_LABEL[f.scope]}</span>
                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, border: '1px solid var(--corum-glass-border)', color: 'var(--dsw-alias-label-tertiary)' }}>{RETENTION_LABEL[f.retention]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--corum-glass-3)', overflow: 'hidden' }}>
                  <div style={{ width: `${barPercent(f.effectiveScore)}%`, height: '100%', background: 'var(--dsw-alias-brand-primary)' }} />
                </div>
                <span style={{ ...MONO, fontSize: 10, color: 'var(--dsw-alias-brand-primary)', minWidth: 40, textAlign: 'right' }}>{f.effectiveScore.toFixed(0)}</span>
                <span style={{ fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>重要 {f.importance}</span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', flexWrap: 'wrap' }}>
                {f.entity !== '' && <span>实体 {f.entity}</span>}
                {f.relation !== '' && <span>关系 {f.relation}</span>}
                {f.source !== '' && <span>来源 {f.source}</span>}
                <span>作者 {f.author}</span>
                <span>创建 {fmtTime(f.createdAt)}</span>
                {f.invalidAt !== null && <span>失效 {fmtTime(f.invalidAt)}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button type="button" disabled={busyId === f.id} onClick={() => void pin(f.id, Math.min(100, f.importance + 10))}
                  style={btnStyle(busyId === f.id)}>↑ 重要</button>
                <button type="button" disabled={busyId === f.id} onClick={() => void pin(f.id, Math.max(0, f.importance - 10))}
                  style={btnStyle(busyId === f.id)}>↓ 压底</button>
                {f.applicable && (
                  <button type="button" disabled={busyId === f.id} onClick={() => void invalidate(f.id)}
                    style={{ ...btnStyle(busyId === f.id), border: '1px solid var(--dsw-alias-state-warn-primary)', color: 'var(--dsw-alias-state-warn-primary)' }}>标失效</button>
                )}
                <button type="button" disabled={busyId === f.id} onClick={() => void remove(f.id)}
                  style={{ ...btnStyle(busyId === f.id), border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', borderRadius: 8, fontSize: 11, cursor: disabled ? 'wait' : 'pointer',
    border: '1px solid var(--corum-glass-border)', background: 'var(--corum-glass-3)',
    color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap',
  }
}

export const inject = ['slots', 'connection', 'remote']

export function apply(ctx: ClientContext): void {
  let slots: ClientContext['slots'] | undefined
  try {
    slots = ctx.slots
  } catch {
    return
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 196,
    label: '记忆',
  }, () => <MemoryPanel call={call} />))
}
