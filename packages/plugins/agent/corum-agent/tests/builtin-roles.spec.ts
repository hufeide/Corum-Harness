/**
 * 内置岗位与维度的机器化对账（2026-09-10 用户需求：岗位要有一个「全能/通用助手」，
 * 不能只限于编程）。
 *
 * 覆盖：
 *   1. 新增「通用」维度在**后端校验**与**UI 下拉**两处同步（漏一处 → 保存被静默丢弃
 *      或编辑器里选不到）；
 *   2. 内置岗位「全能助手」（`general-assistant`）存在且用 `dimension: '通用'`；
 *   3. 岗位 persona 的语言纪律由 `prompt-language.spec.ts` 覆盖（本 spec 不重复）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isValidAgentDimension } from '../src/profile.ts'

const AGENT_SRC = join(import.meta.dirname, '../src')
const UI_SRC = join(import.meta.dirname, '../../../../plugins/ui/corum-ide-ui/src/client/settings/sections/SettingsAgentPresetsSection.tsx')

describe('岗位维度「通用」— 后端与 UI 同步', () => {
  it('isValidAgentDimension 接受「通用」并继续拒绝未知值', () => {
    expect(isValidAgentDimension('通用')).toBe(true)
    for (const known of ['研发', '产品', '设计', '市场', '自媒体', '创作']) {
      expect(isValidAgentDimension(known)).toBe(true)
    }
    expect(isValidAgentDimension('不存在')).toBe(false)
  })

  it('AgentDimension 联合类型含「通用」', () => {
    const src = readFileSync(join(AGENT_SRC, 'profile.ts'), 'utf8')
    const union = src.match(/export type AgentDimension = ([^\n]+)/)?.[1] ?? ''
    expect(union).toContain("'通用'")
  })

  it('Agent 预设编辑器的维度选项含「通用」（否则编辑器里选不到）', () => {
    const src = readFileSync(UI_SRC, 'utf8')
    expect(src).toMatch(/AGENT_DIMENSIONS = \[[^\]]*'通用'/)
  })
})

describe('内置岗位「全能助手」', () => {
  const src = readFileSync(join(AGENT_SRC, 'builtin-profiles.ts'), 'utf8')

  it('存在 general-assistant 岗位，昵称/标题为全能助手 / 通用助手', () => {
    const block = src.slice(src.indexOf("id: 'general-assistant'"))
    expect(block).not.toBe('')
    const head = block.slice(0, 400)
    expect(head).toContain("nickname: '全能助手'")
    expect(head).toContain("title: '通用助手'")
  })

  it('使用通用维度 + 标准模式（不限编程，能力面与标准模式同级）', () => {
    const head = src.slice(src.indexOf("id: 'general-assistant'")).slice(0, 400)
    expect(head).toContain("dimension: '通用'")
    expect(head).toContain("baseMode: 'standard'")
  })

  it('persona 覆盖编程之外的领域（写作/研究/规划/数据/翻译/编码）', () => {
    const head = src.slice(src.indexOf("id: 'general-assistant'")).slice(0, 900)
    for (const domain of ['writing', 'research', 'planning', 'data work', 'translation', 'coding']) {
      expect(head, domain).toContain(domain)
    }
  })
})
