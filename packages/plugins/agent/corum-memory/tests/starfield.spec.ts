/**
 * 星点映射测试（`toStarPoints` / `positionAt`，纯函数）。
 *
 * 几何模型（用户 2026-09-21 口径）：四档存续期 = **四层球壳**，`permanent` 是**中心
 * 实心球**。测试要守住三件在视觉上不明显、坏了却很难查的事：
 *   ① **稳定性**：位置由 `id` 哈希决定，不由数组下标 —— 否则增删一条记忆会让整片星空
 *      重排（用户看起来就是「闪了一下」）；
 *   ② **球面均匀**：θ/φ 必须各自独立均匀，否则点会聚成两团或螺旋线；
 *   ③ **CPU/GPU 一致**：`positionAt` 是渲染与拾取共用的唯一位置函数 —— 它若与渲染
 *      不一致，点击位置就会与看到的光点错位（视觉看不出来，交互致命）。
 */
import { describe, expect, it } from 'vitest'
import { RING_STYLE, positionAt, toStarPoints } from '../src/client/star-points.ts'

/** 造一条最小事实。 */
function fact(id: string, retention: string, importance = 50, applicable = true) {
  return { id, retention, importance, applicable }
}

describe('toStarPoints：事实 → 星点', () => {
  it('层与存续期一一对应（permanent=0 中心 … temporary=3 最外壳）', () => {
    const pts = toStarPoints([
      fact('a', 'permanent'), fact('b', 'long'), fact('c', 'short'), fact('d', 'temporary'),
    ])
    expect(pts.map(p => p.ring)).toEqual([0, 1, 2, 3])
  })

  it('未知 retention 落最外壳（不抛错、不丢点）', () => {
    const pts = toStarPoints([fact('x', 'legacy-tier')])
    expect(pts).toHaveLength(1)
    expect(pts[0]!.ring).toBe(3)
  })

  it('**稳定哈希**：同一组事实无论顺序，每个 id 的坐标不变', () => {
    const a = fact('mem-1', 'long', 70)
    const b = fact('mem-2', 'long', 40)
    const c = fact('mem-3', 'short', 55)
    const forward = toStarPoints([a, b, c])
    const reversed = toStarPoints([c, b, a])
    const pick = (list: ReturnType<typeof toStarPoints>, id: string) => {
      const p = list.find(x => x.id === id)!
      return [p.ring, p.theta, p.phi, p.radius, p.phase]
    }
    for (const id of ['mem-1', 'mem-2', 'mem-3']) {
      expect(pick(reversed, id)).toEqual(pick(forward, id))
    }
  })

  it('不同 id 得到不同 θ（否则同层全叠在一个点上）', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `fact-${i}`)
    const thetas = new Set(toStarPoints(ids.map(i => fact(i, 'long'))).map(p => p.theta.toFixed(6)))
    expect(thetas.size).toBeGreaterThanOrEqual(22)
  })

  it('不同 id 得到不同 φ（否则点会全部落在同一个纬圈上）', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `fact-${i}`)
    const phis = new Set(toStarPoints(ids.map(i => fact(i, 'long'))).map(p => p.phi.toFixed(6)))
    expect(phis.size).toBeGreaterThanOrEqual(22)
  })

  it('θ ∈ [0,2π)、φ ∈ (0,π)、phase ∈ [0,2π)', () => {
    const pts = toStarPoints(Array.from({ length: 80 }, (_, i) => fact(`f${i}`, 'short')))
    for (const p of pts) {
      expect(p.theta).toBeGreaterThanOrEqual(0)
      expect(p.theta).toBeLessThan(Math.PI * 2 + 1e-9)
      // 避开正极点：sinφ=0 处会把点挤成一个点
      expect(p.phi).toBeGreaterThan(0)
      expect(p.phi).toBeLessThan(Math.PI)
      expect(p.phase).toBeGreaterThanOrEqual(0)
      expect(p.phase).toBeLessThan(Math.PI * 2 + 1e-9)
    }
  })

  it('壳层半径落在「基准 ± 厚度/2」内（壳有厚度但不越界）', () => {
    const pts = toStarPoints(Array.from({ length: 200 }, (_, i) => fact(`s${i}`, 'short')))
    const style = RING_STYLE.find(r => r.key === 'short')!
    for (const p of pts) {
      expect(p.radius).toBeGreaterThanOrEqual(style.radius - style.thickness / 2 - 1e-6)
      expect(p.radius).toBeLessThanOrEqual(style.radius + style.thickness / 2 + 1e-6)
    }
  })

  it('permanent 是**实心球**：半径分布在 (0, R] 内且明显向心（不是壳）', () => {
    const pts = toStarPoints(Array.from({ length: 400 }, (_, i) => fact(`p${i}`, 'permanent')))
    const R = RING_STYLE[0]!.radius
    for (const p of pts) {
      expect(p.radius).toBeGreaterThan(0)
      expect(p.radius).toBeLessThanOrEqual(R + 1e-6)
    }
    // 若误写成「壳」，半径会几乎全部集中在 R 附近 ⇒ 用「小于半半径的占比」判据。
    // 体积均匀时 P(r < R/2) = (1/2)³ = 12.5%；壳则接近 0。
    const inner = pts.filter(p => p.radius < R / 2).length / pts.length
    expect(inner).toBeGreaterThan(0.05)
  })

  it('importance 与 applicable 原样透传（渲染器据此定大小/亮度）', () => {
    const pts = toStarPoints([fact('a', 'long', 88, false), fact('b', 'long', 12, true)])
    expect(pts[0]).toMatchObject({ importance: 88, applicable: false })
    expect(pts[1]).toMatchObject({ importance: 12, applicable: true })
  })

  it('自转速度：内层比外层快（行星系观感），且都非零', () => {
    const [permanent, long, short, temporary] = ['permanent', 'long', 'short', 'temporary']
      .map(k => toStarPoints([fact(`x-${k}`, k)])[0]!)
    const speed = (p: typeof permanent) => Math.abs(p.spin)
    expect(speed(permanent)).toBeGreaterThan(speed(long))
    expect(speed(long)).toBeGreaterThan(speed(short))
    expect(speed(short)).toBeGreaterThan(speed(temporary))
  })

  it('空输入 → 空输出（不抛错）', () => {
    expect(toStarPoints([])).toEqual([])
  })
})

describe('positionAt：位置随时间变化', () => {
  it('t 相同 ⇒ 位置相同（确定性）', () => {
    const p = toStarPoints([fact('a', 'long')])[0]!
    const a: [number, number, number] = [0, 0, 0]
    const b: [number, number, number] = [0, 0, 0]
    positionAt(p, 3.5, a)
    positionAt(p, 3.5, b)
    expect(a).toEqual(b)
  })

  it('t 变化 ⇒ 位置变化（真的在动，不是静止星图）', () => {
    const p = toStarPoints([fact('a', 'long')])[0]!
    const a: [number, number, number] = [0, 0, 0]
    const b: [number, number, number] = [0, 0, 0]
    positionAt(p, 0, a)
    positionAt(p, 5, b)
    const moved = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    expect(moved).toBeGreaterThan(0.01)
  })

  it('公转保持半径量级（不会飞出去，也不是原地抖）', () => {
    const p = toStarPoints([fact('a', 'short')])[0]!
    const out: [number, number, number] = [0, 0, 0]
    for (const t of [0, 1.3, 4.7, 11.1, 30]) {
      positionAt(p, t, out)
      const r = Math.hypot(out[0], out[1], out[2])
      // 起伏幅度只有 3.5%·radius，故半径应与 p.radius 同量级
      expect(r).toBeGreaterThan(p.radius * 0.9)
      expect(r).toBeLessThan(p.radius * 1.1)
    }
  })
})

describe('RING_STYLE：四层球壳配置', () => {
  it('恰好四层且半径严格递增（中心 → 外壳）', () => {
    expect(RING_STYLE).toHaveLength(4)
    const radii = RING_STYLE.map(r => r.radius)
    for (let i = 1; i < radii.length; i++) expect(radii[i]!).toBeGreaterThan(radii[i - 1]!)
  })

  it('层间距够宽松（相邻层基准半径比 > 1.4）——用户要求「间距更加宽松」', () => {
    for (let i = 1; i < RING_STYLE.length; i++) {
      const ratio = RING_STYLE[i]!.radius / RING_STYLE[i - 1]!.radius
      expect(ratio).toBeGreaterThan(1.4)
    }
  })

  it('每个壳都有非零厚度（用户要求「有一定厚度」）', () => {
    for (const r of RING_STYLE) expect(r.thickness).toBeGreaterThan(0)
  })

  it('相邻壳的厚度不重叠（层与层之间可分辨）', () => {
    for (let i = 1; i < RING_STYLE.length; i++) {
      const inner = RING_STYLE[i - 1]!
      const outer = RING_STYLE[i]!
      // permanent 是实心球：它的外缘就是 radius
      const innerEdge = inner.key === 'permanent' ? inner.radius : inner.radius + inner.thickness / 2
      const outerEdge = outer.radius - outer.thickness / 2
      expect(outerEdge).toBeGreaterThan(innerEdge)
    }
  })

  it('层序与底座 retention 语义一致（永久在中心）', () => {
    expect(RING_STYLE.map(r => r.key)).toEqual(['permanent', 'long', 'short', 'temporary'])
  })

  it('自转速度内快外慢（单调递减）', () => {
    for (let i = 1; i < RING_STYLE.length; i++) {
      expect(RING_STYLE[i]!.spin).toBeLessThan(RING_STYLE[i - 1]!.spin)
    }
  })

  it('每个层都有合法 rgb（0..1 三分量）', () => {
    for (const r of RING_STYLE) {
      expect(r.rgb).toHaveLength(3)
      for (const c of r.rgb) {
        expect(c).toBeGreaterThanOrEqual(0)
        expect(c).toBeLessThanOrEqual(1)
      }
    }
  })
})
