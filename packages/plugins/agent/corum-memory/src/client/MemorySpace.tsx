/**
 * 「Agent 记忆空间」——**WebGL 粒子星空**（设计稿 `设置 · 记忆 · Agent 星际记忆空间 · 粒子星空 · 深色 v5`）。
 *
 * ## 用户口径（2026-09-21 裁定）
 *
 * > 「点击进去后，可以进入一个三维的 Agent 记忆空间。每一层代表一些记忆的强度。
 * > 我们可以在这个空间观看 Agent 的记忆并且对它进行删减或者修改。」
 *
 * 视觉（用户 2026-09-21 第三轮口径：「有点粒子空间的效果，每个记忆是一个亮点，
 * 镜头可以拉近拉远查看，不同层次则是不同的星环一样」）：
 *
 * | 元素 | 几何 | 语义 |
 * |---|---|---|
 * | **星环** ×4 | 4 条同心椭圆（线段绘制） | 一档存续期一条环：永久最内 → 临时最外 |
 * | **记忆亮点** | `gl.POINTS`，一记忆一点 | 亮点大小/亮度 ∝ 重要性；环内角度由 id 哈希定 |
 * | 背景星尘 | `gl.POINTS`（静态） | 纯纵深氛围，**不**代表记忆（避免误读） |
 * | 中心核 | 大点 + 辉光 | 「核心 = 永不忘记的」的视觉锚 |
 *
 * **镜头**：滚轮 / 按钮推拉（沿 Z 移相机 + 透视投影），拖拽旋转（yaw/pitch）。
 * 点空白处或用「复位」回默认视角。
 *
 * ## 渲染选型：原生 WebGL2（**零新依赖**）
 *
 * 用户选定「原生 WebGL shader」。前置风险已实测排除：Electron 里 WebGL2 可用
 * （`ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max)`，shader 编译链接通过，
 * `ALIASED_POINT_SIZE_RANGE` 上界 511）。渲染器在 {@link useStarfield}，shader 是
 * **内联字符串**、几何只有 `gl.POINTS` + `gl.LINES` ⇒ 不引 three.js（那会往 client
 * bundle 里加约 700 KB），bundle 不涨。
 *
 * ## 为什么还能「删减或修改」
 *
 * 纯观赏的星云点不中就是装饰。故拾取走 **CPU 反投影**（`useStarfield` 里用与 GPU 同一
 * 套矩阵算屏幕坐标）：hover 给指针变手型、点击选中该点，选中后底部出现详情 + 五类操作
 * （重要/压底/改存续期/标失效/删除）。改存续期 = **亮点换环**，能直接看到它飞过去。
 *
 * @module @corum/corum-memory/client/MemorySpace
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Button, Chip, ConfirmDialog, ErrorNote, Hint, Select, TextInput, fmtRelative } from './ui.tsx'
import type { MemoryCall } from './MemorySettingsPage.tsx'
import { useStarfield, toStarPoints } from './starfield.ts'
import type { StarfieldHandle } from './starfield.ts'

/* ── host 同形投影类型 ─────────────────────────────────────────────── */

type MemoryRetention = 'temporary' | 'short' | 'long' | 'permanent'

/** host `MemoryFactView` 的同形投影（只取本视图用到的字段）。 */
export interface SpaceFact {
  id: string
  fact: string
  importance: number
  retention: MemoryRetention
  agentId: string
  createdAt: number
  expiresAt: number | null
  readCount: number
  applicable: boolean
  retained: boolean
  effectiveScore: number
  entity: string
  source: string
}

/* ── 星环配置 ─────────────────────────────────────────────────────── */

/**
 * 四个星环 = 四档存续期（用户选定）。**顺序即半径**：永久最内、临时最外。
 * 半径/颜色定义在 `starfield.ts` 的 `RING_STYLE`（渲染器与 UI 共用同一份，避免两处漂移）。
 */
const RING_LABELS: readonly { key: string, label: string, hint: string, color: string }[] = [
  { key: 'permanent', label: '永久', hint: '中心球 · 永不遗忘的纪律与永久事实', color: 'var(--dsw-alias-brand-primary)' },
  { key: 'long', label: '长期', hint: '内核壳 · 1 年，反复用到的事实', color: 'var(--dsw-alias-state-success-primary)' },
  { key: 'short', label: '短期', hint: '中壳 · 3 个月，阶段性结论', color: 'var(--dsw-alias-state-warn-primary)' },
  { key: 'temporary', label: '临时', hint: '外壳 · 2 天，当下上下文', color: 'var(--dsw-alias-label-tertiary)' },
]

/* ── 组件 ─────────────────────────────────────────────────────────── */

/**
 * 一个 Agent 的三维记忆空间。
 *
 * @param props.call - host RPC。
 * @param props.agentId - Agent id（记忆归属）。
 * @param props.agentName - 展示名。
 * @param props.onBack - 返回 Agent 列表。
 * @returns 记忆空间页节点。
 */
export function MemorySpace({ call, agentId, agentName, onBack }: {
  call: MemoryCall
  agentId: string
  agentName: string
  onBack: () => void
}) {
  const [facts, setFacts] = useState<SpaceFact[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  /**
   * hover 命中的记忆 + 它的屏幕坐标（CSS px，相对 canvas）。
   * 带坐标是为了让信息卡**贴着那个光点**渲染（用户口径「在边上渲染记忆信息，
   * 而不是左上角小字 很容易看不到」）。
   */
  const [hover, setHover] = useState<{ id: string, x: number, y: number } | null>(null)
  /** 搜索词（在 fact/entity/source 上做子串匹配）。 */
  const [query, setQuery] = useState('')
  /** 筛选：只显示某一环 / 某重要性阈值以下。 */
  const [ringFilter, setRingFilter] = useState<string>('all')
  const [minImportance, setMinImportance] = useState<number>(0)
  /** 搜索定位到的记忆（镜头飞过去 + 额外高亮）。 */
  const [focusId, setFocusId] = useState<string | null>(null)
  /**
   * 视图模式：`space` = 星云（默认）；`list` = 平铺列表。
   *
   * 为什么要有 list：星云适合「看整体分布」，但**逐条核对/批量比对**时列表更高效
   * （用户要求「加一个列表查看的 tab 项」）。两者共用同一份筛选/搜索/操作，只是呈现不同。
   */
  const [view, setView] = useState<'space' | 'list'>('space')

  const reload = useCallback(async () => {
    setError(null)
    try {
      const list = await call<SpaceFact[], { input: Record<string, unknown> }>(
        'memory', 'listFacts', { input: { scope: 'agent', agentId } },
      )
      setFacts(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setFacts([])
    }
  }, [call, agentId])

  useEffect(() => { void reload() }, [reload])

  /** 按环分桶（图例条数 + 「这条在哪一环」的说明）。 */
  const byRing = useMemo(() => {
    const map: Record<string, SpaceFact[]> = { permanent: [], long: [], short: [], temporary: [] }
    for (const f of facts ?? []) (map[f.retention] ??= []).push(f)
    return map
  }, [facts])

  /**
   * 筛选 + 搜索后的可见事实。
   *
   * 为什么在**渲染前**过滤而不是渲染后降透明度：星空里「不可见」应当是真的从几何里
   * 拿掉（点消失），否则残留的暗淡点会干扰观察者判断「筛选到底生效没有」。
   */
  const visibleFacts = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (facts ?? []).filter(f => {
      if (ringFilter !== 'all' && f.retention !== ringFilter) return false
      if (f.importance < minImportance) return false
      if (q !== '') {
        const hay = `${f.fact} ${f.entity} ${f.source}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [facts, query, ringFilter, minImportance])

  /** 星空点：可见事实 → 球面坐标（纯函数，见 star-points.ts）。 */
  const stars = useMemo(() => toStarPoints(visibleFacts), [visibleFacts])

  /** 搜索结果列表（最多 8 条，点一条即镜头飞过去）。 */
  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    return visibleFacts
      .filter(f => `${f.fact} ${f.entity}`.toLowerCase().includes(q))
      .slice(0, 8)
  }, [visibleFacts, query])

  const sel = useMemo(() => (facts ?? []).find(f => f.id === selected) ?? null, [facts, selected])

  /**
   * 选中一条记忆：**冻结动画** + 镜头拉近使其居中 + 打开详情。
   *
   * 顺序要紧：先冻结再 `focusOn` —— 冻结后点的位置不再变，镜头才能稳稳对住它
   * （否则点在公转，镜头一路追、面板里的坐标也在飘）。用 `fieldRef` 间接调用以避开
   * 「`field` 声明在使用之后」的 TDZ（hook 返回值不能反过来依赖调用它的回调）。
   */
  const fieldRef = useRef<StarfieldHandle | null>(null)

  /** 渲染器（镜头控制 + 拾取 + 搜索定位）。点击光点即选中并居中；点空白处取消。 */
  const field = useStarfield(
    stars,
    selected,
    focusId,
    useCallback((id: string | null) => {
      setSelected(id)
      setFocusId(id)
      const f = fieldRef.current
      if (f === null) return
      if (id === null) { f.setFrozen(false); f.focusOn(null) }
      else { f.setFrozen(true); f.focusOn({ id }) }
    }, []),
    useCallback((id: string | null, x: number, y: number) => {
      setHover(id === null ? null : { id, x, y })
    }, []),
  )
  fieldRef.current = field

  /** 搜索命中 / 列表点击 → 选中该条 + 镜头飞过去 + 打开详情面板。 */
  const locate = useCallback((id: string) => {
    setSelected(id)
    setFocusId(id)
    const f = fieldRef.current
    if (f === null) return
    f.setFrozen(true)
    f.focusOn({ id })
  }, [])

  /** 取消选中：解冻动画 + 镜头回整团视角。 */
  const deselect = useCallback(() => {
    setSelected(null)
    setFocusId(null)
    const f = fieldRef.current
    if (f === null) return
    f.setFrozen(false)
    f.focusOn(null)
  }, [])

  const mutate = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await fn(); await reload() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [reload])

  const total = (facts ?? []).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, position: 'relative' }}>
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {/* ── 工具条：返回 + 身份 + 视角档 ───────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px 10px 16px',
        borderRadius: 16, background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
        border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
      }}>
        <Button onClick={onBack}>‹ Agent 列表</Button>
        <span style={{
          width: 26, height: 26, borderRadius: 8, flex: 'none', display: 'flex',
          alignItems: 'center', justifyContent: 'center', background: 'var(--corum-glass-3, rgba(255,255,255,0.18))',
          fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, fontWeight: 700,
          color: 'var(--dsw-alias-brand-primary)',
        }}>{agentName.slice(0, 2).toUpperCase()}</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{agentName}</span>
          <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
            {visibleFacts.length === total
              ? `${total} 条记忆 · ${RING_LABELS.filter(r => (byRing[r.key] ?? []).length > 0).length} 层有内容`
              : `${visibleFacts.length} / ${total} 条（已筛选）`}
          </span>
        </span>
        <span style={{ flex: 1 }} />
        {/* 视图切换：星云 / 列表（两者共用同一份筛选与操作） */}
        <span style={{
          display: 'flex', alignItems: 'center', gap: 2, padding: 2, flex: 'none',
          borderRadius: 10, border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
          background: 'var(--corum-glass-2, rgba(255,255,255,0.12))',
        }}>
          {([['space', '星云'], ['list', '列表']] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setView(k)}
              style={{
                padding: '3px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: view === k ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                color: view === k ? 'var(--corum-label-on-brand, #fff)' : 'var(--dsw-alias-label-secondary)',
                fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)',
                fontSize: 11, fontWeight: view === k ? 600 : 400,
              }}
            >{label}</button>
          ))}
        </span>
        {/* 镜头控制：拉远 / 复位 / 拉近（滚轮与拖拽也可）；列表视图下无意义，故禁用 */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, flex: 'none', borderRadius: 10, border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))', background: 'var(--corum-glass-2, rgba(255,255,255,0.12))' }}>
          <Button variant="ghost" disabled={!field.ready || view !== 'space'} onClick={() => field.zoomBy(-0.55)} title="拉远（也可滚轮向下）">−</Button>
          <Button variant="ghost" disabled={!field.ready || view !== 'space'} onClick={() => field.reset()} title="复位镜头">复位</Button>
          <Button variant="ghost" disabled={!field.ready || view !== 'space'} onClick={() => field.zoomBy(0.55)} title="拉近（也可滚轮向上）">＋</Button>
        </span>
      </div>

      {/* ── 搜索 + 筛选（快速定位某条记忆）───────────────────────── */}
      {facts !== null && total > 0 && (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 14px 10px 14px',
          borderRadius: 16, background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
          border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TextInput
              value={query}
              onChange={setQuery}
              placeholder="搜索记忆：事实文本 / 实体 / 来源…"
            />
            <Select
              width={120}
              value={ringFilter}
              options={[
                { value: 'all', label: '全部层' },
                ...RING_LABELS.map(r => ({ value: r.key, label: r.label })),
              ]}
              onChange={setRingFilter}
            />
            <Select
              width={140}
              value={String(minImportance)}
              options={[
                { value: '0', label: '全部重要性' },
                { value: '50', label: '重要性 ≥ 50' },
                { value: '70', label: '重要性 ≥ 70' },
                { value: '85', label: '重要性 ≥ 85' },
              ]}
              onChange={v => setMinImportance(Number(v))}
            />
            {(query !== '' || ringFilter !== 'all' || minImportance > 0) && (
              <Button
                variant="ghost"
                onClick={() => { setQuery(''); setRingFilter('all'); setMinImportance(0); setFocusId(null) }}
              >清除</Button>
            )}
          </div>
          {/* 搜索结果：点一条即镜头飞过去并打开详情 */}
          {searchHits.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <Hint>找到 {searchHits.length} 条 · 点一条定位到它（镜头会飞过去）</Hint>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 84, overflowY: 'auto' }}>
                {searchHits.map(f => (
                  <Chip key={f.id} active={selected === f.id} onClick={() => locate(f.id)} title={f.fact}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', flex: 'none',
                        background: RING_LABELS.find(r => r.key === f.retention)?.color ?? 'var(--dsw-alias-label-tertiary)',
                      }} />
                      {f.fact.length > 26 ? `${f.fact.slice(0, 26)}…` : f.fact}
                    </span>
                  </Chip>
                ))}
              </div>
            </div>
          )}
          {query.trim() !== '' && searchHits.length === 0 && (
            <Hint>没有匹配「{query.trim()}」的记忆（当前筛选下）。</Hint>
          )}
        </div>
      )}

      {/* ── 列表视图（与星云共用同一份筛选 / 搜索 / 操作）─────────── */}
      {view === 'list' && (
        <MemoryTable
          facts={visibleFacts}
          selected={selected}
          onSelect={locate}
        />
      )}

      {/* ── 粒子星空（WebGL）───────────────────────────────────── */}
      {view === 'space' && (facts === null ? (
        <Hint>加载记忆…</Hint>
      ) : total === 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
          height: 320, borderRadius: 16, background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
          border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
        }}>
          <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
            {agentName} 还没有任何记忆。
          </span>
          <Hint>记忆来源（Agent 沉淀）接入后，这里会按存续期分成四个星环显示。</Hint>
        </div>
      ) : (
        <div style={{
          position: 'relative', height: 470, borderRadius: 16, overflow: 'hidden',
          // 星空底色：比面板更深，亮点才「发光」（玻璃卡底色上加法混合会发灰）
          background: 'radial-gradient(ellipse at 50% 45%, #14092a 0%, #0a0612 62%, #07040e 100%)',
          border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
        }}>
          <canvas
            ref={field.canvasRef}
            style={{ display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }}
          />

          {/* 环图例（左下图例区）：四环颜色 + 条数；hover 高亮对应环 */}
          <div style={{
            position: 'absolute', left: 16, bottom: 12, display: 'flex', flexDirection: 'column', gap: 4,
            pointerEvents: 'none',
          }}>
            {RING_LABELS.map(r => (
              <span key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flex: 'none',
                  background: r.color, boxShadow: `0 0 6px ${r.color}`,
                }} />
                <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, fontWeight: 700, color: r.color }}>{r.label}</span>
                <span style={{ fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 9, color: 'var(--dsw-alias-label-tertiary)' }}>
                  {(byRing[r.key] ?? []).length} 条
                </span>
              </span>
            ))}
          </div>

          {/* 右上：镜头提示 / 就绪状态 / 初始化失败回退 */}
          <span style={{
            position: 'absolute', right: 14, top: 10, textAlign: 'right',
            fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 9,
            color: 'var(--dsw-alias-label-tertiary)', pointerEvents: 'none',
          }}>
            {field.error !== null
              ? `WebGL 不可用：${field.error}`
              : (field.ready ? '滚轮推拉（可一直放大）· 拖拽旋转 · 点击光点查看' : '初始化渲染器…')}
          </span>

          {/* hover 信息卡：**贴着那个光点**渲染（用户口径：不要左上角小字，很容易看不到） */}
          {hover !== null && (() => {
            const hf = (facts ?? []).find(f => f.id === hover.id)
            if (hf === undefined) return null
            const ring = RING_LABELS.find(r => r.key === hf.retention)
            return (
              <div style={{
                position: 'absolute', left: hover.x + 16, top: hover.y - 12,
                maxWidth: 300, padding: '7px 10px', borderRadius: 10,
                background: 'var(--corum-glass-1, rgba(20,12,35,0.92))',
                border: `1px solid ${ring?.color ?? 'var(--corum-glass-border)'}`,
                boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
                pointerEvents: 'none', zIndex: 5,
                display: 'flex', flexDirection: 'column', gap: 3,
              }}>
                <span style={{
                  fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 11,
                  fontWeight: 600, color: 'var(--dsw-alias-label-primary)', lineHeight: 1.45,
                  // 长文本最多 3 行，避免浮卡盖住整片星空
                  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>{hf.fact}</span>
                <span style={{
                  fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 9,
                  color: ring?.color ?? 'var(--dsw-alias-label-tertiary)',
                }}>
                  {ring?.label ?? hf.retention}层 · 重要 {hf.importance} · 使用 {hf.readCount} 次
                  {hf.expiresAt !== null ? ` · 到期 ${fmtRelative(hf.expiresAt)}` : ' · 永不遗忘'}
                </span>
              </div>
            )
          })()}
        </div>
      ))}

      {facts !== null && total > 0 && view === 'space' && (
        <Hint>
          四层球壳 = 四档存续期：<strong>中心球是永久记忆</strong>，往外依次是长期 / 短期 / 临时壳（各层有厚度）。
          每个发光点是 一条记忆，越大越亮 = 重要性越高；它们各自闪烁并绕中心缓慢公转。
          改存续期会让光点<strong>飞到另一层</strong>。背景细碎星尘只是氛围，不代表记忆。
        </Hint>
      )}

      {/* ── 手动添加（归属即当前 Agent，只需选层）────────────────── */}
      <AddToSpace
        call={call}
        agentId={agentId}
        busy={busy}
        onAdded={reload}
        onError={setError}
      />

      {/* ── 选中详情 + 操作 ──────────────────────────────────────── */}
      {sel !== null && (
        <SelectionPanel
          fact={sel}
          busy={busy}
          onClose={deselect}
          onImportance={n => void mutate(() => call('memory', 'setImportance', { id: sel.id, importance: n }))}
          onRetention={r => void mutate(() => call('memory', 'setRetention', { id: sel.id, retention: r }))}
          onInvalidate={() => void mutate(() => call('memory', 'invalidate', { id: sel.id }))}
          onDelete={() => setConfirmDel(sel.id)}
        />
      )}

      {confirmDel !== null && (
        <ConfirmDialog
          danger
          title="删除这条记忆？"
          desc={`将永久删除「${(facts ?? []).find(f => f.id === confirmDel)?.fact ?? ''}」。硬删除不可恢复（若要保留证据，用「标失效」）。`}
          confirmLabel="确认删除"
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => {
            const id = confirmDel
            setConfirmDel(null); deselect()
            void mutate(() => call('memory', 'deleteFact', { id }))
          }}
        />
      )}
    </div>
  )
}

/* ── 选中详情 + 操作面板 ──────────────────────────────────────────── */

/** 改档选项（与四层一一对应）。 */
const RETENTION_CHOICES = [
  { value: 'permanent', label: '永久 · 不遗忘' },
  { value: 'long', label: '长期 · 1 年' },
  { value: 'short', label: '短期 · 3 个月' },
  { value: 'temporary', label: '临时 · 2 天' },
] as const

/**
 * 选中记忆的详情与操作。
 *
 * 五类操作与底座能力一一对应：重要性 ±10（`setImportance`）、改存续期（`setRetention`，
 * 即「在层之间移动」）、标失效（`invalidate`，可逆）、硬删除（`deleteFact`）。
 */
function SelectionPanel({ fact, busy, onClose, onImportance, onRetention, onInvalidate, onDelete }: {
  fact: SpaceFact
  busy: boolean
  onClose: () => void
  onImportance: (n: number) => void
  onRetention: (r: MemoryRetention) => void
  onInvalidate: () => void
  onDelete: () => void
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 16px 10px 16px',
      borderRadius: 16, background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
      border: '1px solid var(--corum-glass-border-active, var(--dsw-alias-brand-primary))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' }}>
          选中 · {RING_LABELS.find(t => t.key === fact.retention)?.label ?? fact.retention}环
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={onClose}>取消选中</Button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>{fact.fact}</span>
          <span style={{ fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' }}>
            {[
              `重要 ${fact.importance}`,
              `强度 ${Math.round(fact.effectiveScore)}`,
              fact.entity !== '' ? `实体 ${fact.entity}` : '',
              `使用 ${fact.readCount} 次`,
              `创建 ${fmtRelative(fact.createdAt)}`,
              fact.expiresAt !== null ? `到期 ${fmtRelative(fact.expiresAt)}` : '永不遗忘',
            ].filter(s => s !== '').join('  ·  ')}
          </span>
        </span>
        {!fact.applicable && <Badge tone="warn">已失效</Badge>}
        <span style={{ display: 'flex', gap: 5, alignItems: 'center', flex: 'none' }}>
          <Button disabled={busy} onClick={() => onImportance(Math.min(100, fact.importance + 10))} title="重要性 +10">↑ 重要</Button>
          <Button disabled={busy} onClick={() => onImportance(Math.max(0, fact.importance - 10))} title="重要性 -10">↓ 压底</Button>
          <Select
            width={130}
            value={fact.retention}
            options={RETENTION_CHOICES}
            disabled={busy}
            onChange={onRetention}
          />
          {fact.applicable && <Button disabled={busy} onClick={onInvalidate} title="标记为「不再成立」（可逆）">标失效</Button>}
          <Button variant="danger" disabled={busy} onClick={onDelete}>删除</Button>
        </span>
      </div>
      <Hint>
        改存续期 = 把这条记忆在层之间移动。到期时间按<strong>创建时间</strong>重算（不会因为改档而重置寿命）；
        改成更短的档位后若已过期，这条随即被视为已遗忘。
      </Hint>
    </div>
  )
}

/* ── 列表视图（平铺表格）─────────────────────────────────────────── */

/** 表格列宽（%）——固定宽度避免不同行之间列错位。 */
const COLS = [
  { key: 'fact', label: '记忆', w: '46%' },
  { key: 'ring', label: '层', w: '9%' },
  { key: 'importance', label: '重要性', w: '9%' },
  { key: 'readCount', label: '使用', w: '8%' },
  { key: 'createdAt', label: '创建', w: '13%' },
  { key: 'expiresAt', label: '到期', w: '15%' },
] as const

/**
 * 列表视图：把当前筛选结果（{@link visibleFacts}）平铺成表格。
 *
 * 为什么需要它：星云擅长「看整体分布」，但**逐条核对、按列比对、找某条具体记忆**时
 * 列表高效得多（用户要求「加一个列表查看的 tab 项」）。两者共用同一份筛选与选中态
 * ——点表格行与点光点等价（都会定位 + 弹面板），所以切视图不丢上下文。
 *
 * 列是**固定宽度**的：table-like 布局里若各行列宽自适应，同一行不同列会错开，
 * 扫读时很累。用 `tableLayout: fixed` + 百分比宽度保证跨行对齐。
 */
function MemoryTable({ facts, selected, onSelect }: {
  facts: readonly SpaceFact[]
  selected: string | null
  onSelect: (id: string) => void
}) {
  const [hoverRow, setHoverRow] = useState<string | null>(null)
  if (facts.length === 0) {
    return (
      <div style={{
        padding: '18px 16px', borderRadius: 16,
        background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
        border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
      }}>
        <Hint>当前筛选/搜索下没有记忆。</Hint>
      </div>
    )
  }
  return (
    <div style={{
      borderRadius: 16, overflow: 'hidden',
      background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
      border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
    }}>
      <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {COLS.map(c => (
              <th key={c.key} style={{
                width: c.w, padding: '8px 10px', textAlign: 'left',
                borderBottom: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
                fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)',
                fontSize: 10, fontWeight: 700, color: 'var(--dsw-alias-label-tertiary)',
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
      </table>
      {/* 表体独立滚动：表头常驻，长列表（1000 条）滚动时不会丢掉列名 */}
      <div style={{ maxHeight: 430, overflowY: 'auto' }}>
        <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}>
          <tbody>
            {facts.map(f => {
              const ring = RING_LABELS.find(r => r.key === f.retention)
              const active = selected === f.id
              const hover = hoverRow === f.id
              return (
                <tr
                  key={f.id}
                  onClick={() => onSelect(f.id)}
                  onMouseEnter={() => setHoverRow(f.id)}
                  onMouseLeave={() => setHoverRow(null)}
                  style={{
                    cursor: 'pointer',
                    background: active
                      ? 'var(--corum-glass-3, rgba(255,255,255,0.18))'
                      : (hover ? 'var(--corum-glass-2, rgba(255,255,255,0.10))' : 'transparent'),
                    opacity: f.applicable ? 1 : 0.55,
                  }}
                >
                  <td style={{
                    padding: '6px 10px', fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)',
                    fontSize: 11, color: 'var(--dsw-alias-label-primary)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }} title={f.fact}>{f.fact}</td>
                  <td style={{ padding: '6px 10px' }}>
                    <span style={{
                      fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)', fontSize: 10,
                      fontWeight: 600, color: ring?.color ?? 'var(--dsw-alias-label-tertiary)',
                    }}>{ring?.label ?? f.retention}</span>
                  </td>
                  <td style={{
                    padding: '6px 10px', fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 10, color: 'var(--dsw-alias-label-secondary)',
                  }}>{f.importance}</td>
                  <td style={{
                    padding: '6px 10px', fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 10, color: 'var(--dsw-alias-label-tertiary)',
                  }}>{f.readCount}</td>
                  <td style={{
                    padding: '6px 10px', fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)',
                    fontSize: 10, color: 'var(--dsw-alias-label-tertiary)',
                  }}>{fmtRelative(f.createdAt)}</td>
                  <td style={{
                    padding: '6px 10px', fontFamily: 'var(--corum-ui-font-family, Inter, sans-serif)',
                    fontSize: 10, color: 'var(--dsw-alias-label-tertiary)',
                  }}>{f.expiresAt === null ? '永不遗忘' : fmtRelative(f.expiresAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ── 手动往这个 Agent 的记忆里加一条 ──────────────────────────────── */

/**
 * 手动添加一条记忆到**当前 Agent**。
 *
 * 与「项目记忆」页的 AddFactRow 的差别：归属（`agentId`）在这里是**已知的**（就是空间
 * 对应的那个 Agent），故不需要归属选择器，只要「写什么 + 放哪一层」。放在空间页而不是
 * 列表页：用户是「看着这个 Agent 的记忆空间」时想补一条，此时上下文最明确。
 *
 * `author='user'` ⇒ 底座规则 3 落「至少长期」；但**显式选层优先**（写方声明高于推导），
 * 故用户选了「临时」就真的落临时。
 */
function AddToSpace({ call, agentId, busy, onAdded, onError }: {
  call: MemoryCall
  agentId: string
  busy: boolean
  onAdded: () => Promise<void>
  onError: (message: string | null) => void
}) {
  const [text, setText] = useState('')
  const [retention, setRetention] = useState<MemoryRetention>('long')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = useCallback(async () => {
    const fact = text.trim()
    if (fact === '') return
    setSaving(true); onError(null)
    try {
      await call('memory', 'putFact', {
        input: { fact, scope: 'agent', agentId, retention, author: 'user' },
      })
      setText('')
      await onAdded()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [call, text, agentId, retention, onAdded, onError])

  const disabled = busy || saving
  if (!open) {
    return (
      <div style={{ display: 'flex', padding: '2px 0' }}>
        <Button onClick={() => setOpen(true)} disabled={disabled}>＋ 手动添加一条记忆</Button>
      </div>
    )
  }
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 16px 10px 16px',
      borderRadius: 16, background: 'var(--corum-glass-1, rgba(255,255,255,0.08))',
      border: '1px solid var(--corum-glass-border, rgba(255,255,255,0.14))',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <TextInput
          value={text}
          onChange={setText}
          disabled={disabled}
          onEnter={() => { void submit() }}
          placeholder="写一条事实，例如「本项目用 pnpm 而非 npm」…"
        />
        <Select
          width={140}
          value={retention}
          options={RETENTION_CHOICES}
          disabled={disabled}
          onChange={v => setRetention(v as MemoryRetention)}
        />
        <Button variant="primary" disabled={disabled || text.trim() === ''} onClick={() => { void submit() }}>添加</Button>
        <Button variant="ghost" disabled={disabled} onClick={() => { setOpen(false); setText('') }}>收起</Button>
      </div>
      <Hint>直接落到「{RING_LABELS.find(t => t.key === retention)?.label ?? retention}」环，归属就是当前 Agent。</Hint>
    </div>
  )
}
