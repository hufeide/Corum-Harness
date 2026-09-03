/**
 * 供应商品牌徽标：文字缩写 + 品牌色（方案 A，对齐设计稿主页/向导）。
 * dsh 无品牌元数据，所以按 provider route id / settingsNs 映射到 corum 品牌表。
 * 自定义供应商给默认 cpu 图标（返回 undefined，调用方渲染 IconCpu）。
 */

import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'

export interface Brand {
  /** 显示名（中文优先）。 */
  name: string
  /** 徽标文字（缩写/单字）。 */
  mark: string
  /** 品牌色（hex；token 体系外的固定品牌资产，属设计稿既定值）。 */
  color: string
}

/** provider route id / 关键字 → 品牌。匹配用 includes 小写。 */
const BRANDS: ReadonlyArray<readonly [string, Brand]> = [
  ['deepseek', { name: 'DeepSeek', mark: 'DS', color: '#4D6BFE' }],
  ['qwen', { name: '通义千问', mark: '千', color: '#FF6A00' }],
  ['zai', { name: '智谱', mark: 'GLM', color: '#3B5BFD' }],
  ['glm', { name: '智谱', mark: 'GLM', color: '#3B5BFD' }],
  ['moonshot', { name: '月之暗面', mark: 'K', color: '#1A1A1A' }],
  ['kimi', { name: '月之暗面', mark: 'K', color: '#1A1A1A' }],
  ['minimax', { name: 'MiniMax', mark: 'M', color: '#6C5CE7' }],
  ['baidu', { name: '百度文心', mark: '文', color: '#2932E1' }],
  ['wenxin', { name: '百度文心', mark: '文', color: '#2932E1' }],
  ['spark', { name: '讯飞星火', mark: '星', color: '#1E80FF' }],
  ['xfyun', { name: '讯飞星火', mark: '星', color: '#1E80FF' }],
  ['doubao', { name: '字节豆包', mark: '豆', color: '#325AB4' }],
  ['xiaomi', { name: '小米', mark: 'MI', color: '#FF6900' }],
  ['anthropic', { name: 'Anthropic', mark: 'A', color: '#D97757' }],
  ['openai', { name: 'OpenAI', mark: '✦', color: '#10A37F' }],
  ['google', { name: 'Google', mark: 'G', color: '#4285F4' }],
  ['openrouter', { name: 'OpenRouter', mark: 'OR', color: '#6366F1' }],
  ['xai', { name: 'xAI', mark: 'X', color: '#1A1A1A' }],
  ['mistral', { name: 'Mistral', mark: 'M', color: '#FF7000' }],
  ['groq', { name: 'Groq', mark: 'Q', color: '#F55036' }],
  ['bedrock', { name: 'AWS Bedrock', mark: 'B', color: '#FF9900' }],
  ['azure', { name: 'Azure', mark: 'Az', color: '#0078D4' }],
]

/** 常用供应商（配置向导品牌网格展示，国内全部 + 国际常用，按此顺序）。 */
export const COMMON_PROVIDERS: ReadonlyArray<Brand & { id: string }> = [
  { id: 'deepseek', name: 'DeepSeek', mark: 'DS', color: '#4D6BFE' },
  { id: 'qwen', name: '通义千问', mark: '千', color: '#FF6A00' },
  { id: 'zai', name: '智谱', mark: 'GLM', color: '#3B5BFD' },
  { id: 'moonshotai', name: '月之暗面', mark: 'K', color: '#1A1A1A' },
  { id: 'minimax', name: 'MiniMax', mark: 'M', color: '#6C5CE7' },
  { id: 'baidu', name: '百度文心', mark: '文', color: '#2932E1' },
  { id: 'spark', name: '讯飞星火', mark: '星', color: '#1E80FF' },
  { id: 'doubao', name: '字节豆包', mark: '豆', color: '#325AB4' },
  { id: 'anthropic', name: 'Anthropic', mark: 'A', color: '#D97757' },
  { id: 'openai', name: 'OpenAI', mark: '✦', color: '#10A37F' },
  { id: 'google', name: 'Google', mark: 'G', color: '#4285F4' },
  { id: 'openrouter', name: 'OpenRouter', mark: 'OR', color: '#6366F1' },
]

/** 按 provider route id / settingsNs 推品牌。未知返回 undefined（自定义默认图标）。 */
export function brandOf(key: string | undefined): Brand | undefined {
  if (key === undefined) return undefined
  const k = key.toLowerCase()
  for (const [kw, brand] of BRANDS) {
    if (k.includes(kw)) return brand
  }
  return undefined
}

/** 品牌徽标（品牌色方块 + 缩写）。未知品牌调用方传 fallback（IconCpu）。 */
export function BrandLogo({ brand, size = 30, fallback }: {
  brand: Brand | undefined
  size?: number
  fallback?: ReactNode
}): ReactNode {
  if (brand === undefined) {
    return (
      <span className={styles['brandLogo']} style={{ width: size, height: size }}>
        {fallback}
      </span>
    )
  }
  const fontSize = brand.mark.length > 1 ? Math.round(size * 0.34) : Math.round(size * 0.44)
  return (
    <span
      className={styles['brandLogo']}
      style={{ width: size, height: size, background: brand.color, fontSize }}
      aria-hidden
    >
      {brand.mark}
    </span>
  )
}
