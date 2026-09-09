/**
 * P2-2（.dbg/event-bus-audit-2026-09.md）：折叠态从 grid.ts 的模块级 Set 改为
 * 显式参数后，grid 数学（leafMinSize / subtreeMinSize / rescaleGrid / resizeBranch）
 * 必须继续按 collapsedWidth 处理折叠叶子。本 spec 钉死这条链路。
 */
import { describe, expect, it } from 'vitest'
import {
  leafNode, registerSlot, rescaleGrid, resizeBranch, rowBranch, subtreeMinSize,
  type GridNode,
} from '../src/client/grid.ts'

// 折叠态槽位声明（56px 图标轨）。
registerSlot('spec.sidebar', { label: '侧栏', defaultWeight: 300, minWidth: 300, collapsedWidth: 56 })
registerSlot('spec.main', { label: '主区', defaultWeight: 500, minWidth: 400 })
registerSlot('spec.other', { label: '其它', defaultWeight: 200, minWidth: 100 })

const COLLAPSED: ReadonlySet<string> = new Set(['spec.sidebar'])
const NONE: ReadonlySet<string> = new Set()

function tree(): GridNode {
  return rowBranch([leafNode('spec.sidebar'), leafNode('spec.main'), leafNode('spec.other')], [300, 500, 200])
}

describe('subtreeMinSize — 折叠态取 collapsedWidth', () => {
  it('未折叠 → 声明 minWidth', () => {
    expect(subtreeMinSize(leafNode('spec.sidebar'), true, NONE)).toBe(300)
  })

  it('折叠 → collapsedWidth（row 轴）', () => {
    expect(subtreeMinSize(leafNode('spec.sidebar'), true, COLLAPSED)).toBe(56)
  })

  it('column 轴不受折叠影响（折叠只收宽）', () => {
    expect(subtreeMinSize(leafNode('spec.sidebar'), false, COLLAPSED)).toBe(200 /* 无 minHeight → 兜底 */)
  })

  it('缺省 collapsed 参数 = 未折叠', () => {
    expect(subtreeMinSize(leafNode('spec.sidebar'), true)).toBe(300)
  })
})

describe('rescaleGrid — 窗口缩放时折叠叶子按折叠宽让位', () => {
  // 语义说明：折叠叶子的**渲染宽**由 GridView 的 lockedSlots 固定为 collapsedWidth
  // （见 GridView.computeCellSizes）；grid 数学里 collapsedWidth 是该叶子的 min，
  // 作用是让它在缩放/sash 传导中不再按展开 min(300) 占位。故这里断言
  // 「≥56 且 <300，且比未折叠时更窄」，而不是恒等于 56。
  it('折叠态 + 窄窗口：折叠叶子权重 ≥56 且 < 展开 min(300)', () => {
    const next = rescaleGrid(tree(), 700, 800, COLLAPSED)
    const branch = next.type === 'branch' ? next : null
    const w0 = branch?.weights[0] ?? 0
    expect(w0).toBeGreaterThanOrEqual(56)
    expect(w0).toBeLessThan(300)
  })

  it('折叠比未折叠让出更多宽度', () => {
    const collapsed = rescaleGrid(tree(), 700, 800, COLLAPSED)
    const plain = rescaleGrid(tree(), 700, 800, NONE)
    const cw = collapsed.type === 'branch' ? collapsed.weights[0] : 0
    const pw = plain.type === 'branch' ? plain.weights[0] : 0
    expect(cw).toBeLessThan(pw)
  })
})

describe('resizeBranch — sash 拖拽时折叠叶子不被压过/拉过折叠宽', () => {
  it('折叠叶子在 min 夹取下保持 56（向左拖到底）', () => {
    const root = tree()
    const branchId = root.type === 'branch' ? root.id : ''
    const next = resizeBranch(root, branchId, 0, -10_000, undefined, COLLAPSED)
    const branch = next.type === 'branch' ? next : null
    expect(branch?.weights[0]).toBeGreaterThanOrEqual(56)
  })
})
