/**
 * 磁贴墙（Mosaic）React 组件 —— 集成中心三个内容页共用的展示骨架。
 * 算法在 `./mosaic.ts`、几何在 `./mosaic.module.css`；本文件把两者接成组件。
 *
 * ## 为什么抽出来
 *
 * 插件 / MCP / 技能三页原本各持一份「块生成器 + 排布 CSS + 磁贴本体 + 详情面板」
 * 的副本（跨包 CSS module 不能直接 import 的历史约束）。三份副本必然分叉，实测
 * 已经分叉过：插件页列宽走 `[data-col]` 属性选择器、另两页走 `.mosaicCol264`
 * 类名，且后者漏了块行的 `width: 100%` ⇒ MCP 页的每张贴被拉成整行 808×128，
 * 完全不是磁贴。收敛到本模块后只有一个几何实现。
 *
 * ## 用法
 *
 * ```tsx
 * const blocks = buildMosaic(items.length)      // 或 flattenMosaic 取尺寸序列
 * <MosaicWall items={items} blocks={blocks} renderTile={(item, size, i) => ...} />
 * ```
 *
 * @module corum-ui-base/client/Mosaic
 */
import { Fragment, type ReactNode } from 'react'
import css from './mosaic.module.css'
import type { MosaicBlock, MosaicSize } from './mosaic.ts'

/** 磁贴底色四档（design.pen 磁贴 fill 的四色，token 见 theme.css）。 */
export type MosaicTint = 'violet' | 'deep' | 'slate' | 'mauve'

/** 档位 → 样式类名（消费方按语义挑档，不再自己拼类名）。 */
const TINT_CLASS: Readonly<Record<MosaicTint, string>> = {
  violet: css.tileTintViolet,
  deep: css.tileTintDeep,
  slate: css.tileTintSlate,
  mauve: css.tileTintMauve,
}

/** 磁贴墙：把块序列渲染成块行 + 列 + 贴。 */
export interface MosaicWallProps<T> {
  /** 贴的数据源（按渲染顺序，与 {@link flattenMosaic} 的顺序一致）。 */
  readonly items: readonly T[]
  /** 块序列（`buildMosaic` 的输出）。 */
  readonly blocks: readonly MosaicBlock[]
  /**
   * 渲染单张贴。
   * @param item - 对应位置的数据。
   * @param size - 该位置应使用的尺寸档（已由算法决定，消费方按它调字号/图标）。
   * @param index - 在整面墙里的序号（0 起；入口贴通常在第 0 位）。
   */
  readonly renderTile: (item: T, size: MosaicSize, index: number) => ReactNode
}

/**
 * 磁贴墙（块行 → 列 → 贴）。
 *
 * @param props - 见 {@link MosaicWallProps}。
 * @returns 磁贴墙元素。
 */
export function MosaicWall<T>({ items, blocks, renderTile }: MosaicWallProps<T>): ReactNode {
  let cursor = 0
  return (
    <div className={css.tileGrid}>
      {blocks.map((block, bi) => (
        <div key={`block:${bi}`} className={css.mosaicBlock} data-mosaic-block={block.kind}>
          {block.cols.map((col, ci) => (
            <div key={`col:${bi}:${ci}`} className={css.mosaicCol} data-col={col.width}>
              {col.sizes.map((size, si) => {
                const index = cursor++
                const item = items[index]
                if (item === undefined) return null
                return (
                  <Fragment key={`tile:${bi}:${ci}:${si}`}>
                    {renderTile(item, size, index)}
                  </Fragment>
                )
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * 取某一张贴该挂的属性（消费方展开到自己的 `<button>` 上）。
 *
 * 贴必须是列的**直接子元素**（CSS 靠 `.mosaicCol > [data-tile-size]` 分档列高），
 * 故这里不包壳层元素，只把类名与 data 属性交给消费方。
 *
 * @param props - 见 {@link MosaicTileProps}。
 * @returns 可展开的属性对象。
 */
export function mosaicTileAttrs(props: MosaicTileProps): {
  className: string
  'data-tile-size': MosaicSize
} {
  return {
    className: mosaicTileClass(props),
    'data-tile-size': props.size,
  }
}

/** 磁贴按钮的属性集（消费方直接展开到自己的 `<button>`/`<div>` 上）。 */
export interface MosaicTileProps {
  /** 尺寸档（算法给的，决定字号/图标/是否独占列高）。 */
  readonly size: MosaicSize
  /** 底色档。 */
  readonly tint: MosaicTint
  /** 是否选中（进详情面板的那一张）。 */
  readonly active?: boolean
  /** 是否加品牌色 glow（大贴/主推）。 */
  readonly glow?: boolean
  /** 额外类名。 */
  readonly className?: string
}

/** 拼磁贴的类名（`size` 走 data 属性，其余走类名）。 */
export function mosaicTileClass({ tint, active, glow, className }: MosaicTileProps): string {
  return [
    css.tile,
    TINT_CLASS[tint],
    active === true ? css.tileActive : '',
    glow === true ? css.tileGlow : '',
    className ?? '',
  ].filter(Boolean).join(' ')
}

/** 共享样式表的窄化面（消费方拼自己的结构时按需取这些类名）。 */
export interface MosaicStyleSheet {
  readonly tileGrid: string
  readonly mosaicBlock: string
  readonly mosaicCol: string
  readonly tile: string
  readonly tileTop: string
  readonly tileIcon: string
  readonly tileCorner: string
  readonly tileBottom: string
  readonly tileNameRow: string
  readonly tileName: string
  readonly tileVersion: string
  readonly tileSub: string
  readonly tileDesc: string
  readonly tileDot: string
  readonly tileDotOff: string
  readonly tileSwitch: string
  readonly tileSwitchKnob: string
  readonly tilePlaceholder: string
  readonly tilePlaceholderIcon: string
  readonly tilePlaceholderText: string
  readonly hotRow: string
}

/**
 * 共享样式表：三个页面拼贴内结构（图标行 / 名称行 / 小字…）时取这里的类名，
 * 不再各持一份 CSS。返回的是本模块自己 import 的那份 CSS module 对象。
 */
export const mosaicStyles: MosaicStyleSheet = {
  tileGrid: css.tileGrid,
  mosaicBlock: css.mosaicBlock,
  mosaicCol: css.mosaicCol,
  tile: css.tile,
  tileTop: css.tileTop,
  tileIcon: css.tileIcon,
  tileCorner: css.tileCorner,
  tileBottom: css.tileBottom,
  tileNameRow: css.tileNameRow,
  tileName: css.tileName,
  tileVersion: css.tileVersion,
  tileSub: css.tileSub,
  tileDesc: css.tileDesc,
  tileDot: css.tileDot,
  tileDotOff: css.tileDotOff,
  tileSwitch: css.tileSwitch,
  tileSwitchKnob: css.tileSwitchKnob,
  tilePlaceholder: css.tilePlaceholder,
  tilePlaceholderIcon: css.tilePlaceholderIcon,
  tilePlaceholderText: css.tilePlaceholderText,
  hotRow: css.hotRow,
}

export { mosaicStyles as css }
