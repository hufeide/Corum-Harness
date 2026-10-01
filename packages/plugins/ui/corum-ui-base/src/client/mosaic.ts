/**
 * 磁贴墙排布算法（Mosaic）—— 集成中心三个内容页（插件 / MCP / 技能）共用的
 * 「错落有致」块生成器。**这是排布算法的单一事实源**：三个页面不再各持一份副本
 * （副本分叉过一次，见文件末「为什么抽出来」）。
 *
 * ## 几何（design.pen 四帧逐帧读实）
 *
 * 设计稿的磁贴墙**不是 CSS grid**，而是「若干等宽 808 的块」上下堆叠；每块内部
 * 一行 flex、各列等高。块只有两种高度：
 *
 * - **高 264 的块**：四列，宽度是 `[264,264,128,128]` 的某个排列。
 *   264 宽列装「一张大贴」或「两条宽贴竖叠」；128 宽列装「一张高贴」或
 *   「两条小贴竖叠」。宽度校验：264+8+264+8+128+8+128 = **808** ✓
 * - **高 128 的块**：列宽模式三选一，均为 808：
 *   `[128×6]` = 768+40 / `[264,128×4]` = 776+32 / `[264,264,128×2]` = 784+24。
 *
 * 列宽 128 与「两条小贴竖叠」的关系：128+8+128 = 264，故 128 宽的列与 264 宽的
 * 列在纵向能装下同样多的贴，两种块的列高都自洽。
 *
 * ## 为什么是「固定种子伪随机」而不是逐块手写
 *
 * 设计稿每帧只画两行，谈不上覆盖真实数据量（插件市场可能几十条）。排布若按
 * 固定序号循环，每块会排得一模一样——用户反馈「当前这种每一列都一种排列方式
 * 是不好看的」。故逐块抽型：**种子为常量 ⇒ 同一份数据每次渲染完全一致**（可
 * 复现、可对账），同时块与块之间形态不同，呈现错落。
 *
 * 曾经的做法是 `display:grid; grid-auto-flow:dense` + 固定序号循环，实测空洞率
 * 6.3%（大贴跨两行时自动放置填不满）且每块同形；改块生成器后整块恰好铺满。
 *
 * @module corum-ui-base/client/mosaic
 */

/** 磁贴尺寸档（与 design.pen 的 264×264 / 264×128 / 128×264 / 128×128 对应）。 */
export type MosaicSize = 'big' | 'wide' | 'tall' | 'small'

/** 块高度档：264 块装大/高贴，128 块装宽/小贴。 */
export type MosaicBlockKind = '264' | '128'

/**
 * 固定种子：**换掉它就换一整套图案**，同一份数据下恒定。
 * 取值本身无深意（任意常量），只承担「可复现」这一个职责。
 */
export const MOSAIC_SEED = 0x5a17

/**
 * 相邻块同型时的重抽上限。几何上两型等概率，5 次仍同型就直接取相
 * 反型——保证「相邻不同型」这条硬约束不会因随机而破。
 */
const BLOCK_RETYPE_MAX = 5

/** 块内一列：宽度档 + 该列自上而下的贴尺寸序列。 */
export interface MosaicCol {
  /** 列宽（px，未乘密度缩放）：264 或 128。 */
  readonly width: 264 | 128
  /** 该列的贴尺寸序列（自上而下 1~2 张）。 */
  readonly sizes: readonly MosaicSize[]
}

/** 一个块行：高度档 + 列序列。 */
export interface MosaicBlock {
  readonly kind: MosaicBlockKind
  readonly cols: readonly MosaicCol[]
}

/** mulberry32：小而稳定的 32 位 PRNG（纯函数式状态推进，无外部依赖）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates 洗牌（消费同一 PRNG，保证整条序列可复现）。 */
function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/**
 * 高 264 的块：四列宽 `[264,264,128,128]` 洗牌后，每列随机取单元。
 *
 * 约束（保证整块有视觉锚点、不会退化成一整片同尺寸）：
 * 至少一张大贴；264 宽列不得全为「两条宽贴」；128 宽列不得全为「两条小贴」。
 * 违反即重抽，最多 {@link BLOCK_RETYPE_MAX} 次；耗尽后退到设计稿首帧的原始排法
 * （大 | 双宽 | 高 | 双小），保证仍有锚点。
 *
 * @param rng - 该次渲染的 PRNG。
 * @param pinFirstTwoSmalls - 首列钉成「两条小贴竖叠」——集成中心把入口（添加 /
 *   安装本地包等）固定放在左上角第一张贴，故需要这枚钉子。插件市场无入口贴时传 false。
 */
export function buildBlock264(rng: () => number, pinFirstTwoSmalls = false): MosaicBlock {
  for (let attempt = 0; attempt < BLOCK_RETYPE_MAX; attempt++) {
    const widths = shuffled(rng, [264, 264, 128, 128] as const)
    if (pinFirstTwoSmalls) widths[0] = 128
    let hasBig = false
    let allWide = true
    let allSmall2 = true
    const cols: MosaicCol[] = widths.map((w) => {
      if (w === 264) {
        allSmall2 = false
        if (rng() < 0.5) { hasBig = true; return { width: 264, sizes: ['big'] } }
        return { width: 264, sizes: ['wide', 'wide'] }
      }
      allWide = false
      if (rng() < 0.5) return { width: 128, sizes: ['tall'] }
      return { width: 128, sizes: ['small', 'small'] }
    })
    if (hasBig && !allWide && !allSmall2) return { kind: '264', cols }
  }
  return {
    kind: '264',
    cols: [
      { width: 264, sizes: ['big'] },
      { width: 264, sizes: ['wide', 'wide'] },
      { width: 128, sizes: ['tall'] },
      { width: 128, sizes: ['small', 'small'] },
    ],
  }
}

/** 高 128 的块：三种列宽模式（均 808）三选一，再洗牌 264 宽列的位置。 */
export function buildBlock128(rng: () => number): MosaicBlock {
  const roll = rng()
  const base: MosaicCol[] = roll < 1 / 3
    ? [128, 128, 128, 128, 128, 128].map(w => ({ width: w as 128, sizes: ['small'] as const }))
    : roll < 2 / 3
      ? [
          { width: 264, sizes: ['wide'] },
          ...Array.from({ length: 4 }, () => ({ width: 128 as const, sizes: ['small'] as const })),
        ]
      : [
          { width: 264, sizes: ['wide'] },
          { width: 264, sizes: ['wide'] },
          { width: 128, sizes: ['small'] },
          { width: 128, sizes: ['small'] },
        ]
  return { kind: '128', cols: shuffled(rng, base) }
}

/** 取一个块能容纳的贴数。 */
function blockCapacity(block: MosaicBlock): number {
  return block.cols.reduce((n, c) => n + c.sizes.length, 0)
}

/** 按列顺序保留能铺满的列前缀（不留空占位），返回裁剪后的块。 */
function trimCols(block: MosaicBlock, room: number): MosaicBlock {
  const cols: MosaicCol[] = []
  let used = 0
  for (const col of block.cols) {
    if (used + col.sizes.length > room) break
    cols.push(col)
    used += col.sizes.length
  }
  return { kind: block.kind, cols }
}

/**
 * 把 `count` 张贴排进块序列。
 *
 * 流程：首块可选钉死（{@link MosaicOptions.pinFirstTwoSmalls} 由调用方转给
 * {@link buildBlock264}）→ 逐块抽型（相邻不同型）→ 整块放得下就整块收，
 * 否则列级裁剪收尾（末块允许窄于 808，属裁剪形态而非空洞）。
 *
 * 裁剪后若一列都放不下（剩余贴数小于任一列的张数），退化为**单张贴窄块**
 * 收尾——早期实现在这里直接退出循环，导致剩余贴被静默丢弃（实测 2 张贴只渲染
 * 出 1 张，即少显示一个条目），故必须继续消费到 `count` 用尽。
 *
 * @param count - 要塞进去的贴数（调用方按数据条数计算，含入口贴）。
 * @param options - 见 {@link MosaicOptions}。
 * @returns 块序列，块的列内 sizes 是「该位置该用哪一档尺寸」，由调用方按序遍历取数据。
 */
export interface MosaicOptions {
  /**
   * 首块首列钉成「两条小贴竖叠」：集成中心三个页面的入口贴（添加服务器 /
   * 添加技能 / 安装本地包）都固定落在左上角第一张，故需要这枚钉子。
   */
  readonly pinFirstTwoSmalls?: boolean
}

export function buildMosaic(count: number, options: MosaicOptions = {}): MosaicBlock[] {
  if (count <= 0) return []
  const rng = mulberry32(MOSAIC_SEED)
  const blocks: MosaicBlock[] = []
  let left = count

  const emit = (block: MosaicBlock): boolean => {
    const trimmed = trimCols(block, left)
    if (trimmed.cols.length === 0) return false
    blocks.push(trimmed)
    left -= blockCapacity(trimmed)
    return true
  }

  if (options.pinFirstTwoSmalls === true && count >= 2) {
    emit(buildBlock264(rng, true))
  } else if (count === 1) {
    emit({ kind: '128', cols: [{ width: 128, sizes: ['small'] }] })
  }

  while (left > 0) {
    let kind: MosaicBlockKind = rng() < 0.5 ? '264' : '128'
    const last = blocks.length === 0 ? null : blocks[blocks.length - 1]!.kind
    if (last !== null) {
      for (let i = 0; i < BLOCK_RETYPE_MAX && kind === last; i++) {
        kind = rng() < 0.5 ? '264' : '128'
      }
      if (kind === last) kind = last === '264' ? '128' : '264'
    }
    if (!emit(kind === '264' ? buildBlock264(rng) : buildBlock128(rng))) {
      // 剩余贴装不下任何整块：单张贴窄块收尾（型取与上一块相反，维持相邻不同型）。
      const tailKind: MosaicBlockKind = last === '264' ? '128' : '264'
      emit({ kind: tailKind, cols: [{ width: 128, sizes: [tailKind === '264' ? 'tall' : 'small'] }] })
      left -= 1
      if (left > 0) {
        // 理论上不可达（单张块容量为 1，emit 后 left 必为 0）；留此以防未来改容量时漏改。
        continue
      }
    }
  }
  return blocks
}

/**
 * 块序列 → 扁平贴序列（按「块 → 列 → 列内自上而下」的渲染顺序）。
 *
 * 三个页面都按这个顺序把自己的数据贴上去，故顺序必须与 CSS 的视觉顺序一致：
 * 块内是横向 flex（列），列内是纵向 flex（贴）。
 */
export function flattenMosaic(blocks: readonly MosaicBlock[]): MosaicSize[] {
  const out: MosaicSize[] = []
  for (const block of blocks) {
    for (const col of block.cols) {
      for (const size of col.sizes) out.push(size)
    }
  }
  return out
}
