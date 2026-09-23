/**
 * 星空**数据映射** —— `事实 → 星点` 的纯函数层（**不依赖 react / WebGL，可单测**）。
 *
 * 为什么单独成文件：`starfield.ts` 是 React hook + WebGL 渲染器，在 Node 测试环境里
 * import 它会去 require `react` 而失败。把纯计算抽出来既解决可测性，也让「映射规则」
 * 与「渲染实现」各自独立演进。
 *
 * ## 几何：球壳套球壳（不是平面圆环）
 *
 * 用户 2026-09-21 口径：「不同层级的星光在外围凝聚成圆形球体并且有一定厚度，中心是
 * 永久记忆的光点组成的球体」。故：
 *
 * ```
 *          ╭───────────╮   temporary 壳（最外，最厚）
 *        ╭─┤  ╭─────╮  ├─╮  short 壳
 *        │ │ ╭───╮ │   │   long 壳
 *        │ │ │ ●●● │ │   │  permanent 核（实心小球）
 *        │ │ ╰───╯ │   │
 *        ╰─┤  ╰─────╯  ├─╯
 *          ╰───────────╯
 * ```
 *
 * 每档存续期 = 一层**球壳**（有厚度的球面）；`permanent` 不占壳而占**中心实心球**
 * —— 语义即「核心 = 永不忘记的」。
 *
 * ## 球面分布用「按 id 哈希」而不是 fibonacci 下标
 *
 * 两个理由：
 *   1. **稳定性**：用下标（fibonacci 球）时，用户增删一条记忆会让**所有**点的位置重排
 *      —— 整片星空跳一下。哈希只影响新增/删除的那一个点。
 *   2. **可测**：给定 id 必有确定的 (θ, φ, r)，单测能断言「同输入同输出」。
 *
 * 分布在球面上要**面积均匀**，否则点会聚成两团。用逆变换采样：
 * `z = 1-2u₁`（均匀于 [-1,1]）＋ `θ = 2πu₂` ⇒ 球面均匀（Archimedes 投影定理）。
 *
 * @module @corum/corum-memory/client/star-points
 */

/** 一个待渲染的记忆点（球坐标 + 动画参数；实际位置由渲染器按时间算）。 */
export interface StarPoint {
  /** 事实 id（拾取回传、选中比对）。 */
  id: string
  /** 所属层（0=permanent 核 … 3=temporary 最外壳）。 */
  ring: 0 | 1 | 2 | 3
  /** 极径（已含壳厚度抖动）。 */
  radius: number
  /** 方位角 θ（弧度）。 */
  theta: number
  /** 极角 φ（弧度，0=+Y 极）。 */
  phi: number
  /** 闪烁相位（弧度）——决定这颗星何时最亮。 */
  phase: number
  /** 自转速度（弧度/秒，含正负）——内层快、外层慢。 */
  spin: number
  /** 重要性 0-100 ⇒ 亮点大小与基础亮度。 */
  importance: number
  /** 是否适用（失效的点显著变暗）。 */
  applicable: boolean
}

/**
 * 四层球壳的展示配置。**顺序即半径**：permanent 核在最内 → temporary 壳在最外。
 *
 * `radius` 是壳的**基准半径**，`thickness` 是壳的**厚度**（用户要的「有一定厚度」）。
 * `spin` 是该壳的自转基准速度（内快外慢，像行星系）。
 *
 * ⚠️ 相邻层基准半径比刻意保持 **> 1.4**（用户口径「它们的间距更加宽松」）：比这更近时，
 * 密集的 1000 点在投影后会糊成一片连续壳层，看不出「一层一层」——这条由
 * `tests/starfield.spec.ts` 的「层间距够宽松」断言守住。
 * 颜色选**深色底上够亮**的值（渲染是加法混合，暗色会看不见）。
 */
export const RING_STYLE = [
  // permanent：中心**实心球**（不是壳）——厚度 = 半径本身，故 thickness 与 radius 同量级
  { key: 'permanent', label: '永久', radius: 0.34, thickness: 0.34, spin: 0.155, rgb: [0.42, 0.80, 1.0] },
  { key: 'long', label: '长期', radius: 1.12, thickness: 0.18, spin: 0.052, rgb: [0.30, 0.92, 0.70] },
  { key: 'short', label: '短期', radius: 2.00, thickness: 0.24, spin: 0.031, rgb: [1.0, 0.70, 0.32] },
  { key: 'temporary', label: '临时', radius: 3.00, thickness: 0.32, spin: 0.019, rgb: [0.68, 0.64, 0.86] },
] as const

/** 32 位稳定字符串哈希（FNV-1a）。同输入必得同输出 —— 「不重排」的前提。 */
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * 从一个哈希取第 `n` 路 [0,1) 随机数（各路独立）。
 *
 * 为什么要「多路」：一个点需要 4 个独立随机量（θ、φ、r 抖动、闪烁相位）。若都从同一个
 * 哈希值切位取，会引入相关性 —— 实测表现是同相位、同半径的点连成可见的螺旋线。
 * 这里用「哈希(哈希(id) + salt)」给每路独立的雪崩，代价是几次乘加。
 *
 * @param base - 基础哈希值。
 * @param salt - 路号。
 * @returns [0, 1) 的确定值。
 */
function randOf(base: number, salt: number): number {
  let h = (base ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * 事实列表 → 星点。
 *
 * @param facts - 事实（需含 id / retention / importance / applicable）。
 * @returns 星点数组（与输入等长、同序）。
 */
export function toStarPoints(facts: readonly {
  id: string
  retention: string
  importance: number
  applicable: boolean
}[]): StarPoint[] {
  const ringOf = (retention: string): 0 | 1 | 2 | 3 => {
    const i = RING_STYLE.findIndex(r => r.key === retention)
    // 未知档位（老数据 / 未来新增）落最外壳：宁可位置不准，也不丢点。
    return (i < 0 ? 3 : i) as 0 | 1 | 2 | 3
  }
  return facts.map(f => {
    const base = hash(f.id)
    const style = RING_STYLE[ringOf(f.retention)]!
    // 面积均匀的球面采样：z 均匀 ⇒ 球面均匀（Archimedes）；避开正极点（±1）防止
    // sinφ=0 处点挤成一点。
    const u1 = randOf(base, 0)
    const z = (u1 * 1.998) - 0.999
    const phi = Math.acos(z)
    const theta = randOf(base, 1) * Math.PI * 2
    // 半径抖动：permanent 核是**实心球**（向心填充），其余层是**壳**（面附近抖动）
    const u3 = randOf(base, 2)
    const radius = style.key === 'permanent'
      // 实心球：r = R·u^(1/3) 才是体积均匀；用 u^(1/2) 会向外偏（球壳感）
      ? style.radius * Math.cbrt(u3)
      : style.radius + (u3 - 0.5) * style.thickness
    return {
      id: f.id,
      ring: ringOf(f.retention),
      radius: Math.max(0.02, radius),
      theta,
      phi,
      phase: randOf(base, 3) * Math.PI * 2,
      // 自转速度：壳基准 ± 30% 抖动，方向也允许相反（星系里外圈反向的观感）
      spin: style.spin * (0.7 + randOf(base, 4) * 0.6) * (randOf(base, 5) < 0.25 ? -1 : 1),
      importance: f.importance,
      applicable: f.applicable,
    }
  })
}

/**
 * 算某点在时刻 `t`（秒）的三维位置。
 *
 * 单点运动 = **绕 Y 轴公转**（自转速度随层递减）＋ **垂直轻微起伏**（让「一片静止的球
 * 壳」变成「活的星云」）。
 *
 * ⚠️ 渲染器（GPU）与拾取（CPU 反投影）**必须调同一个函数**，否则点击位置会与看到的
 * 亮点错位——这类 bug 在视觉上不明显但在交互上是致命的。
 *
 * @param p - 星点。
 * @param t - 时间（秒）。
 * @param out - 输出三元组（复用数组避免每帧分配）。
 */
export function positionAt(p: StarPoint, t: number, out: [number, number, number]): void {
  const theta = p.theta + p.spin * t
  const sinPhi = Math.sin(p.phi)
  // 起伏：幅度 ∝ 半径（外圈摆得更大），频率与自转错开（避免整体同步脉动）
  const bob = Math.sin(t * 0.35 + p.phase) * 0.035 * p.radius
  out[0] = p.radius * sinPhi * Math.cos(theta)
  out[1] = p.radius * Math.cos(p.phi) + bob
  out[2] = p.radius * sinPhi * Math.sin(theta)
}
