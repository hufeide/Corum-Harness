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
import { refreshFromSpec } from '../src/builtin-profiles.ts'

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
 * 幂等刷新：**按字段来源**——spec 演进要落地，用户改过的不许被覆盖（2026-09-14）。
 *
 * 两个契约必须同时成立，且它们曾经互相冲突：
 *  ① 2026-09-13 修正的静默失效：「指挥者 → 指挥模式」这类**只改昵称**的演进，
 *     对既有安装必须能落地（否则只有全新 home 拿到新名字）；
 *  ② 2026-09-14 用户拍板原则：「手动改的模型配置属于用户数据，**不应该在程序升级后
 *     被覆盖**」——而旧实现把 nickname/title/dimension/baseMode/prompt/model/
 *     subagentModel/researchModel **八个字段按 spec 无条件覆写**（其注释却写着
 *     「保留用户的模型/能力配置」，代码与注释相反），每次启动都静默回滚用户修改。
 *
 * 修法：`AgentProfile.specBaseline` 记住上一次 spec 写入的值。判据为
 * **当前值 === 基线值 ⇒ 用户没改过 ⇒ 随 spec 刷新；不等 ⇒ 用户改过 ⇒ 保留**。
 *
 * 本用例改为**行为断言**（旧版是对源码做字符串匹配 `existing.X !== spec.X`，那会把
 * 实现细节钉死、重构即误报，也无法验证「用户改过就保留」这一半）。
 */
describe('内置角色的幂等刷新：spec 演进落地 + 用户数据不被覆盖', () => {
  it('用户没改过的字段：spec 改名会落地（2026-09-13 那条契约）', () => {
    const baseline = { nickname: '指挥者', title: '编排指挥', dimension: '研发', baseMode: 'conductor', prompt: 'P1' }
    const existing = { id: 'x', trust: 'system', specBaseline: baseline, nickname: '指挥者', title: '编排指挥', dimension: '研发', baseMode: 'conductor', prompt: 'P1' } as never
    const spec = { id: 'x', nickname: '指挥模式', title: '编排指挥', dimension: '研发', baseMode: 'conductor', prompt: 'P1' } as never
    const r = refreshFromSpec(existing, spec)
    expect(r.changed).toBe(true)
    expect((r.next as { nickname?: string }).nickname).toBe('指挥模式')
    expect(r.baseline.nickname).toBe('指挥模式')
  })

  it('用户改过的字段：spec 不得覆盖（2026-09-14 那条契约）', () => {
    // 基线是 spec 当初写的 deepseek-v4-flash；用户把它改成了本地模型。
    const baseline = { nickname: 'Task 助理', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }
    const existing = { id: 'task', trust: 'system', specBaseline: baseline, nickname: 'Task 助理', model: { provider: 'localhost', model: 'deepseek-v4.1-flash' } } as never
    const spec = { id: 'task', nickname: 'Task 助理', model: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } as never
    const r = refreshFromSpec(existing, spec)
    expect(r.changed).toBe(false)
    expect((r.next as { model?: { model?: string } }).model?.model).toBe('deepseek-v4.1-flash')
  })

  it('老安装（无基线）：首次只播种基线、不改任何现值', () => {
    const existing = { id: 'x', trust: 'system', nickname: '我改过的名字', model: { provider: 'localhost', model: 'mine' } } as never
    const spec = { id: 'x', nickname: 'spec 名字', model: { provider: 'deepseek-official', model: 'spec 模型' } } as never
    const r = refreshFromSpec(existing, spec)
    // 现值一个都不许动（播种不改值）……
    expect((r.next as { nickname?: string }).nickname).toBe('我改过的名字')
    expect((r.next as { model?: { model?: string } }).model?.model).toBe('mine')
    // ……但基线要落盘（= 现值），于是「今后」的修改才能被识别为「用户改过」。
    expect(r.changed).toBe(true)
    expect(r.baseline.nickname).toBe('我改过的名字')
    expect((r.baseline.model as { model?: string }).model).toBe('mine')
  })

  it('播种后再改 spec：未被用户改过的字段随 spec 刷新', () => {
    // 第一次：播种（基线=现值=spec 值）
    const seed = refreshFromSpec(
      { id: 'x', trust: 'system', nickname: '旧名' } as never,
      { id: 'x', nickname: '旧名' } as never,
    )
    // 第二次：spec 改名且用户没动过 ⇒ 必须落地（2026-09-13 那条契约）
    const after = refreshFromSpec(
      { id: 'x', trust: 'system', nickname: '旧名', specBaseline: seed.baseline } as never,
      { id: 'x', nickname: '新名' } as never,
    )
    expect(after.changed).toBe(true)
    expect((after.next as { nickname?: string }).nickname).toBe('新名')
  })

  it('spec 不拥有的字段（skills/mcp/记忆策略）永不被刷新触碰', () => {
    const existing = { id: 'x', trust: 'system', specBaseline: {}, skills: [{ name: 's', versionId: '' }], mcpServers: ['a'], memoryPolicy: { scope: 'agent' } } as never
    const spec = { id: 'x', nickname: 'n' } as never
    const r = refreshFromSpec(existing, spec)
    const next = r.next as { skills?: unknown; mcpServers?: unknown; memoryPolicy?: unknown }
    expect(next.skills).toEqual([{ name: 's', versionId: '' }])
    expect(next.mcpServers).toEqual(['a'])
    expect(next.memoryPolicy).toEqual({ scope: 'agent' })
  })
})
