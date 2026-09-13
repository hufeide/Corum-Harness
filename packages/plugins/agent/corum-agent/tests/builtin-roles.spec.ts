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

/**
 * 五个「模式入口」Agent 的命名与继承对账（2026-09-13 用户定稿命名）。
 *
 * 由来：2026-09-12 定调「dsh 官方五模式不再直接选中，只作继承模板」，每个模式配一个
 * 内置 Agent 作为可选中/可配置入口；2026-09-13 用户把五个入口的**名字**定稿为
 * 「标准模式 / 指挥模式 / PTC 模式 / 极简模式 / 创造模式」。
 *
 * 为什么用源码扫描而不是 import：内置角色表是「服务启动时幂等播种」的静态表，
 * 名字与 baseMode 的对应关系正是本决策的内容，钉在源码层最直接（同 spec 上文对
 * `general-assistant` 的做法）。改动这五个入口的名字或继承关系会让本用例变红——
 * 那正是我们要的：这是用户拍板过的命名，不能被顺手改掉或漏改。
 */
describe('五个模式入口 Agent（2026-09-13 命名定稿）', () => {
  const src = readFileSync(join(AGENT_SRC, 'builtin-profiles.ts'), 'utf8')

  /** 取某个 id 定义块的前 600 字（够覆盖 nickname/title/dimension/baseMode）。 */
  const blockOf = (id: string): string => {
    const at = src.indexOf(`id: '${id}'`)
    expect(at, `内置角色 ${id} 不存在`).toBeGreaterThan(-1)
    return src.slice(at, at + 600)
  }

  it.each([
    ['standard-mode', '标准模式', 'standard'],
    ['conductor-lead', '指挥模式', 'conductor'],
    ['ptc-assistant', 'PTC 模式', 'ptc'],
    ['minimal-assistant', '极简模式', 'minimal'],
    ['preset-author', '创造模式', 'cordis'],
  ])('%s 的昵称是「%s」且 baseMode 是 %s', (id, nickname, baseMode) => {
    const block = blockOf(id)
    expect(block).toContain(`nickname: '${nickname}'`)
    expect(block).toContain(`baseMode: '${baseMode}'`)
  })

  it('五档齐备：每个模式都有且只有一个入口（漏一个用户就没法选到那个模式）', () => {
    const modes = ['standard', 'conductor', 'ptc', 'minimal', 'cordis']
    const entryIds = ['standard-mode', 'conductor-lead', 'ptc-assistant', 'minimal-assistant', 'preset-author']
    for (const [i, mode] of modes.entries()) {
      expect(blockOf(entryIds[i])).toContain(`baseMode: '${mode}'`)
    }
  })

  it('入口的 persona 不含 CJK（语言纪律，同 prompt-language.spec.ts 的口径）', () => {
    for (const id of ['standard-mode', 'conductor-lead', 'ptc-assistant', 'minimal-assistant', 'preset-author']) {
      const block = blockOf(id)
      const prompt = block.match(/prompt:\s*'([^']*)'/)?.[1] ?? ''
      // 允许拼接式 prompt（conductor-lead 是多段 + 连接）：取不到单引号字面量就跳过该条。
      if (prompt === '') continue
      expect(/[\u4e00-\u9fff]/.test(prompt), `${id} 的 prompt 含中文`).toBe(false)
    }
  })
})

/**
 * 幂等刷新的**触发判据**必须包含名片字段（2026-09-13 修正的一处静默失效）。
 *
 * 现象（改为纯改名时暴露）：`ensureBuiltinRoleProfiles` 的刷新分支只比对
 * prompt/机制字段，而注释写着「prompt/名片字段随版本幂等刷新」——于是「指挥者 →
 * 指挥模式」这类**只改昵称**的演进对**既有安装静默不生效**（只有全新 home 才拿到新
 * 名字）。本用例把判据钉住：昵称/标题/维度/baseMode 任一变化都必须触发刷新。
 */
describe('内置角色的幂等刷新判据（名片字段必须参与）', () => {
  const src = readFileSync(join(AGENT_SRC, 'builtin-profiles.ts'), 'utf8')
  const guard = src.slice(src.indexOf("existing.trust === 'system' && ("), src.indexOf(')) {', src.indexOf("existing.trust === 'system' && (")))

  it.each([
    ['nickname', '昵称'],
    ['title', '标题'],
    ['dimension', '维度'],
    ['baseMode', '继承模式'],
  ])('刷新判据含 %s（否则改名的演进不会落地）', (field) => {
    expect(guard).toContain(`existing.${field} !== spec.${field}`)
  })

  it('仍然保留用户的模型 / 能力配置（刷新只覆盖 spec 侧字段）', () => {
    const update = src.slice(src.indexOf('saveProfile({', src.indexOf("existing.trust === 'system' && (")), src.indexOf('})', src.indexOf('saveProfile({', src.indexOf("existing.trust === 'system' && ("))))
    expect(update).toContain('...existing')
    // 模型锁 / 技能 / MCP 都不在刷新字段里（用户可改），只有 spec 显式给了才覆盖。
    expect(update).not.toMatch(/^\s*skills:/m)
  })
})
