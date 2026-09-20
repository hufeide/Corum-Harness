/**
 * 官方基础模式的**覆盖**必须体现在 `listProfiles` 投影里（2026-09-21 修复的回归）。
 *
 * ## 实机缺陷
 *
 * 用户报障原话：
 * > 在会话的空态页面（输入指令，开始新的任务这个页面），选择一个**开启了自定义模型覆盖
 * > 机制**的 Agent，模型仍然是**默认智能体设置**中的那个。并没有变为这个 Agent 预设的
 * > 覆盖设置。
 *
 * 根因：`listProfilesRemote` 的官方预设分支把 `model` **硬写成**
 * `agentDefaultModel.currentSelection()`（注释还写着「official preset 不绑定固定模型」），
 * 而用户覆盖存于 `.agent-presets/_official-overrides.json` ——
 * `loadOfficialOverrides` **全库零消费方**（只被它自己的 `saveOfficialOverride` 调用，
 * 而后者零调用点）⇒ 覆盖「保存后任何地方都不生效」。
 *
 * 空态表单的默认模型链路是 `listProfiles.model → AgentOption.defaultModel →`
 * `EmptyStateHero` 的 `effectiveModelSel`，所以这一支不合并覆盖，用户就永远看到部署默认。
 *
 * ## 断言什么
 *
 * ① 有覆盖 ⇒ 投影出**覆盖的**模型（含 reasoningEffort）；
 * ② 有覆盖 ⇒ 子 Agent 模型一并投影（这是「自定义模型覆盖」的另一半）；
 * ③ 无覆盖 ⇒ **回落部署默认**（旧行为不能变，否则是另一个回归）；
 * ④ 覆盖的是 A、问的是 B ⇒ B 不受影响（不能把覆盖串到别的模式上）。
 *
 * @module @corum/corum-agent/tests/official-override-projection
 */

import { describe, expect, it } from 'vitest'
import { makeHarness } from './harness.ts'
import { saveOfficialOverride } from '../src/profile-store.ts'

/** 官方 preset 目录的最小 stub（`agentPresets.list()` 的形状）。 */
const OFFICIAL = [
  { id: 'standard', name: '标准模式', description: '标准', trust: 'system' as const },
  { id: 'cordis', name: '精简', description: '精简', trust: 'system' as const },
]

/** 建一个能驱动 listProfilesRemote 的测试台。 */
function setup() {
  const h = makeHarness()
  h.provide('agentPresets', { list: async () => OFFICIAL })
  h.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' }),
  })
  return h
}

describe('listProfiles —— 官方基础模式的覆盖必须生效', () => {
  it('① 有覆盖 ⇒ 投影覆盖的模型（不是部署默认）', async () => {
    const h = setup()
    try {
      saveOfficialOverride('standard', {
        model: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'xhigh' },
      })
      const { profiles } = await h.service.listProfilesRemote()
      const std = profiles.find(p => p.id === 'standard')
      expect(std?.source).toBe('official')
      expect(std?.model).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'xhigh' })
    } finally {
      h.cleanup()
    }
  })

  it('② 有覆盖 ⇒ 子 Agent 模型一并投影', async () => {
    const h = setup()
    try {
      saveOfficialOverride('standard', {
        subagentModel: { provider: 'localhost', model: 'glm-5.3-flash', reasoningEffort: 'high' },
      })
      const { profiles } = await h.service.listProfilesRemote()
      expect(profiles.find(p => p.id === 'standard')?.subagentModel)
        .toEqual({ provider: 'localhost', model: 'glm-5.3-flash', reasoningEffort: 'high' })
    } finally {
      h.cleanup()
    }
  })

  it('③ 无覆盖 ⇒ 回落部署默认（旧行为不变）', async () => {
    const h = setup()
    try {
      const { profiles } = await h.service.listProfilesRemote()
      const std = profiles.find(p => p.id === 'standard')
      expect(std?.model).toEqual({ provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' })
      // 未覆盖的字段按契约是「不带该键」（跟随主 Agent），不是 undefined 占位。
      expect(std === undefined ? true : 'subagentModel' in std).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('④ 覆盖只作用于被覆盖的那个模式（不串到别的）', async () => {
    const h = setup()
    try {
      saveOfficialOverride('standard', { model: { provider: 'p-a', model: 'm-a' } })
      const { profiles } = await h.service.listProfilesRemote()
      expect(profiles.find(p => p.id === 'standard')?.model).toEqual({ provider: 'p-a', model: 'm-a' })
      // cordis 未被覆盖 ⇒ 仍是部署默认
      expect(profiles.find(p => p.id === 'cordis')?.model)
        .toEqual({ provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' })
    } finally {
      h.cleanup()
    }
  })

  it('⑤ 覆盖文件损坏/缺失 ⇒ 不抛错、回落默认（防一次坏 JSON 打挂整个列表）', async () => {
    const h = setup()
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { join } = await import('node:path')
      const dir = join(h.home, '.agent-presets')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '_official-overrides.json'), '{ not json')
      const { profiles } = await h.service.listProfilesRemote()
      expect(profiles.find(p => p.id === 'standard')?.model)
        .toEqual({ provider: 'localhost', model: 'kimi-k3-1', reasoningEffort: 'high' })
    } finally {
      h.cleanup()
    }
  })
})
