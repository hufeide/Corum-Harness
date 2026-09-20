/**
 * resolveDefaultTaskProfileId — task 模式默认 Agent 预设解析的机器验证。
 *
 * 覆盖四条（对应任务规格）：
 *   ① 未传 profileId 且 settings 无配置 ⇒ TASK_PROFILE_ID；
 *   ② settings `agent-presets.default` 配了存在的 corum profile ⇒ 用它；
 *   ③ 配了官方 preset id ⇒ 走 isOfficialPreset 分支（放行，不抛）；
 *   ④ 配了不在 corum 目录的 id ⇒ 放行（warn，mount 处校验，不回落 TASK_PROFILE_ID）。
 *
 * 通路：`resolveDefaultTaskProfileId` 是 private 方法，但 harness 经
 * `Object.create(CorumAgentService.prototype)` 创建被测服务 ⇒ 原型方法可直调。
 * settings 走 `provideGet('settings', { get })` 模拟（与生产 `ctx.get('settings')`
 * 同形，参照 harness 的 provideGet 先例：只提供 `ctx.get`，不挂原始属性）。
 *
 * 真实落盘验证：CORUM_HOME 指向 tmpdir，profile 写在 harness home 里、
 * `loadProfile` 走真实 profile-store 路径（不做 mock）。
 *
 * @module @corum/corum-agent/tests/default-preset
 */
import { describe, expect, it } from 'vitest'
import { makeHarness, type Harness } from './harness.ts'
import type { AgentProfile } from '../src/profile.ts'
import { TASK_PROFILE_ID } from '../src/builtin-profiles.ts'

/** 模拟 settings 服务：返回一个形如 `{ get: (ns) => view }` 的窄面。 */
function mockSettingsView(view: { value?: { default?: string }; user?: { default?: string } } | undefined): unknown {
  if (view === undefined) return undefined
  return { get: (_ns: string) => view }
}

/** 造一个最小 AgentProfile（与既有 spec 同口径）。 */
function profile(id: string): AgentProfile {
  return {
    id,
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
  }
}

describe('resolveDefaultTaskProfileId', () => {
  it('① settings 无配置 ⇒ TASK_PROFILE_ID', () => {
    const h = makeHarness()
    // settings 服务未挂载（ctx.get('settings') 返回 undefined）—— boot 早期容忍。
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
    h.cleanup()
  })

  it('①b settings 挂载但 agent-presets 段无 default 键 ⇒ TASK_PROFILE_ID', () => {
    const h = makeHarness()
    h.provideGet('settings', mockSettingsView({ value: {}, user: {} }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
    h.cleanup()
  })

  it('② agent-presets.default 配了存在的 corum profile ⇒ 用它', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provideGet('settings', mockSettingsView({ user: { default: 'corum-dev' } }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })

  it('②b value 层有 default 但 user 层没有 ⇒ 仍读 value 层', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provideGet('settings', mockSettingsView({ value: { default: 'corum-dev' } }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })

  it('③ 配了官方 preset id（不在 corum profile 目录里）⇒ 放行（走 isOfficialPreset 分支）', () => {
    const h = makeHarness()
    // 'standard' 是官方 preset id，loadProfile 查不到 ⇒ resolveDefaultTaskProfileId
    // 放行它（不在 corum 目录、但可能存在于 agentPresets 官方目录，mount 时再校验）。
    h.provideGet('settings', mockSettingsView({ user: { default: 'standard' } }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('standard')
    h.cleanup()
  })

  it('④ 配了不存在的 corum id（非官方 preset）⇒ 放行 id（warn，mount 处校验）', () => {
    const h = makeHarness()
    // 'ghost-agent' 既不是 corum profile（未落盘）也不像官方 preset id。
    // resolveDefaultTaskProfileId 无法同步区分「无效 id」与「官方 preset id」
    // ⇒ 放行（同 isOfficialPreset 分支），失效的官方 id 会在 mount 处抛
    // agent-preset/not-found。这是设计取舍：建任务链路不该被一条可能有效的
    // 官方 preset id 卡死（与官方 defaultId 的「找不到就抛」不同）。
    h.provideGet('settings', mockSettingsView({ user: { default: 'ghost-agent' } }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('ghost-agent')
    h.cleanup()
  })

  it('④b 配置值为空白字符串 ⇒ 回落 TASK_PROFILE_ID', () => {
    const h = makeHarness()
    h.provideGet('settings', mockSettingsView({ user: { default: '   ' } }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe(TASK_PROFILE_ID)
    h.cleanup()
  })

  it('④c 配置值前后有空白 ⇒ trim 后解析', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provideGet('settings', mockSettingsView({ user: { default: '  corum-dev  ' } }))
    const result = (h.service as unknown as { resolveDefaultTaskProfileId: () => string }).resolveDefaultTaskProfileId()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })
})

describe('readConfiguredDefaultPreset（UI 透传面：不做 TASK_PROFILE_ID 回落）', () => {
  it('未配置 ⇒ undefined（UI 侧回落列表第一项）', () => {
    const h = makeHarness()
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBeUndefined()
    h.cleanup()
  })

  it('settings 挂载但无 default 键 ⇒ undefined', () => {
    const h = makeHarness()
    h.provideGet('settings', mockSettingsView({ value: {}, user: {} }))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBeUndefined()
    h.cleanup()
  })

  it('配了存在 corum profile 的 default ⇒ 返回该 id（不回落 TASK_PROFILE_ID）', () => {
    const h = makeHarness()
    h.writeProfile(profile('corum-dev'))
    h.provideGet('settings', mockSettingsView({ user: { default: 'corum-dev' } }))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBe('corum-dev')
    h.cleanup()
  })

  it('配了官方 preset id（不在 corum 目录里）⇒ 仍返回该 id（UI 侧 list.some 判定）', () => {
    const h = makeHarness()
    h.provideGet('settings', mockSettingsView({ user: { default: 'standard' } }))
    const result = (h.service as unknown as { readConfiguredDefaultPreset: () => string | undefined }).readConfiguredDefaultPreset()
    expect(result).toBe('standard')
    h.cleanup()
  })
})
