/**
 * applySubagentModelForSession — 委派机制「子 Agent 模型永久切换」能力面的机器验证。
 *
 * 覆盖（对应任务规格的四条）：
 *   (a) role='worker' 写入 preset 的 `subagentModel`，且 **预设其他字段全部保留**
 *       ——saveProfile 只浅拷贝入参整体落盘、不与存量合并，直接传部分对象会静默丢
 *       memoryPolicy（台账 lesson.profile.saveProfile-needs-full-input-and-summary-
 *       omits-memoryPolicy：档案加载不能、listProfiles 全体失败）。本测试显式断言
 *       memoryPolicy / skills / mcpServers / terminal / prompt / model 这些
 *       「部分保存就会丢」的字段；
 *   (b) route=undefined 清除键本身（磁盘 JSON 无该键，非 undefined 占位）；
 *   (c) role='research' 写 `researchModel` 而不是 `subagentModel`；
 *   (d) 未知会话 / 解析不到预设 → fail-loud 抛错（绝不静默回落默认预设——写错预设
 *       = 用户以为改了 A 实际改了 B）。
 *
 * 真实落盘验证：CORUM_HOME 指向 tmpdir，agent.json / agent.cordis.yml /
 * preset.yml 走 profile-store + compilePreset 的真实路径（不做 mock——本能力的
 * 价值全在「完整入参 + 真实写盘」语义对得上）。Agent/会话按 CorumAgentService
 * 内部表的最小形状 stub，不拉官方 host 组装（那是 runtime-task 级联的重装置）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeHarness, projectionsOf, type Harness } from './harness.ts'
import type { AgentProfile } from '../src/profile.ts'
import { compilePreset } from '../src/compile.ts'

// ⚠️ 不再需要本文件自建 home：`makeHarness()` 每建一个测试台就建一个临时 home 并把
// `CORUM_HOME` / `DSH_HOME` 指过去（且每个测试台**独占**一个）。此前本文件与 harness
// 各建一个 home，profile 写在 A、断言读 B —— 迁移时实测踩到（ENOENT）。
// 纪律：临时 home 的所有权只属于 harness，spec 一律经 `h.home` 读。

/** 最小可用 AgentProfile（与 compile-subagent.spec 同口径，另补 trap 哨兵字段）。 */
function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'sam-test-agent',
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [{ name: 'pen-dev', versionId: '2026-09-18-01' }],
    mcpServers: ['pencil-mcp'],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...overrides,
  }
}

function writeProfile(p: AgentProfile): void {
  const dir = join(h.home, '.agent-presets', p.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(p, null, 2))
}

/**
 * 本套的测试台一律来自 `tests/harness.ts`（**唯一**知道怎么造服务的地方）。
 *
 * ⚠️ 2026-09-21（P3-a）迁移：本文件原先自带一个 `makeService()`，用
 * `Object.create(prototype)` + `Object.defineProperty(svc, 'taskAgents', …)` **按状态表
 * 名字**造表。状态搬进 `AgentRegistry` 之后那种写法会**静默失真**——`defineProperty`
 * 照样成功、被测代码却读自己的空表，测试随后以「不是本进程存活的 Agent 会话」这种
 * 假绿/假红呈现，指不到真因。改用 harness 后契约断裂会 **fail-loud**。
 */
function setup(): Harness {
  const h = makeHarness()
  h.provide('sessionProjections', { stateOf: (): undefined => undefined })
  h.provide('agents', { get: (): undefined => undefined })
  return h
}

/** 把一个存活会话登记进 task 表（含 `agentPreset` 投影，本能力的解析源）。 */
function registerSession(h: Harness, sessionId: string, presetId: string): void {
  h.registerTaskAgent(sessionId, { profileId: presetId })
  h.provide('sessionProjections', projectionsOf({ [sessionId]: presetId }))
}

describe('★ 服务取用纪律（2026-09-18 实机事故的回归门禁）', () => {
  it('sessionProjections 必须走 ctx.get()——属性访问在未 inject 时抛 cannot get … without inject', () => {
    // 实机事故：永久档第一次点「跟随主 Agent」死在
    // `cannot get property "sessionProjections" without inject`
    // （corum-agent 的 static inject 里没有它；vendor/cordis/src/reflect.ts:144）。
    // 修法 = 改用 `ctx.get('sessionProjections')`（get 无 inject 门禁，同文件 233-243）。
    const src = readFileSync(join(import.meta.dirname, '../src/agent-service.ts'), 'utf8')
    // 切到下一个顶层成员（`\n  private ` / `\n  @Remote` / `\n}`）为止——不能拿
    // `persistProfileAndRecompile(` 当终点（它在文件里定义在本方法**之前**，会切出空串）。
    const start = src.indexOf('applySubagentModelForSession(')
    expect(start).toBeGreaterThan(-1)
    const rest = src.slice(start)
    const endMatch = /\n  (?:private |public |@Remote|\})/.exec(rest.slice(1))
    const body = endMatch === null ? rest : rest.slice(0, endMatch.index + 1)
    expect(body).toContain("this.ctx.get('sessionProjections'")
    expect(body).not.toMatch(/\.sessionProjections\b\s*(\?\?)?\s*[;,\n]/)
  })
})

describe('applySubagentModelForSession — 委派机制模型永久切换', () => {
  it("(a) worker 写 subagentModel 且预设其他字段全部保留（saveProfile 部分保存陷阱防线）", () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-a', p.id)

    const result = h.service.applySubagentModelForSession('sess-a', 'worker', { provider: 'pi-ai', model: 'glm-5.3' })

    expect(result).toEqual({ presetId: p.id, applied: { provider: 'pi-ai', model: 'glm-5.3' } })
    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    // 目标键写入
    expect(saved.subagentModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
    // trap 哨兵：这些字段被部分保存丢掉过 / 会直接让档案加载不能
    expect(saved.memoryPolicy).toEqual({ scope: 'agent' })
    expect(saved.skills).toEqual([{ name: 'pen-dev', versionId: '2026-09-18-01' }])
    expect(saved.mcpServers).toEqual(['pencil-mcp'])
    expect(saved.terminal).toEqual({ mode: 'sandbox' })
    expect(saved.prompt).toBe('测试 Agent')
    expect(saved.model).toEqual({ provider: 'local', model: 'deepseek-v4-flash' })
    expect(saved.baseMode).toBe('standard')
    // version 自增（saveProfile 语义：存量 version + 1）
    expect(saved.version).toBe(2)
    // 编译产物同步刷新（写 agent.json 不重编译 = 半更新）
    const compiled = compilePreset(saved as AgentProfile)
    expect(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.cordis.yml'), 'utf8')).toBe(compiled.cordisYml)
    expect(readFileSync(join(h.home, '.agent-presets', p.id, 'preset.yml'), 'utf8')).toBe(compiled.presetYml)
    expect(existsSync(join(h.home, '.agent-presets', p.id, 'agent.json'))).toBe(true)
  })

  it('(a2) reasoningEffort 透传写入', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-a2', p.id)

    const result = h.service.applySubagentModelForSession('sess-a2', 'worker', { provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
    expect(result.applied).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.subagentModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
  })

  it("(b) route=undefined 清除键本身（磁盘 JSON 无该键，而非 undefined 占位）", () => {
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3' } })
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-b', p.id)

    const result = h.service.applySubagentModelForSession('sess-b', 'worker', undefined)
    expect(result.applied).toBeUndefined()

    const raw = readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')
    const saved = JSON.parse(raw) as AgentProfile
    expect(saved.subagentModel).toBeUndefined()
    // 键必须**不存在**（undefined 占位 ≠ 删除；磁盘上不能留 null/空占位）
    expect('subagentModel' in saved).toBe(false)
    expect(raw).not.toContain('subagentModel')
    // researchModel 不被误伤
    expect(saved.memoryPolicy).toEqual({ scope: 'agent' })
  })

  it("(c) role='research' 写 researchModel，不碰 subagentModel", () => {
    const p = profile({ subagentModel: { provider: 'local', model: 'keep-worker' } })
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-c', p.id)

    const result = h.service.applySubagentModelForSession('sess-c', 'research', { provider: 'pi-ai', model: 'glm-5.3' })
    expect(result).toEqual({ presetId: p.id, applied: { provider: 'pi-ai', model: 'glm-5.3' } })

    const saved = JSON.parse(readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.researchModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
    expect(saved.subagentModel).toEqual({ provider: 'local', model: 'keep-worker' })
  })

  it('(d1) 未知会话（不在任何存活表）→ fail-loud 抛错', () => {
    const h = setup()
    h.provide('agents', { get: (): undefined => undefined })
    expect(() => h.service.applySubagentModelForSession('no-such-session', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/no-such-session/)
  })

  it('(d2) agentPreset 投影为空（解析不到预设）→ 抛错且不写盘', () => {
    const p = profile()
    const h = setup()
    h.writeProfile(p)
    registerSession(h, 'sess-d2', p.id)
    // 把投影换掉：agentPreset 恒 undefined（投影缺席/为空形态）。
    // ⚠️ 必须走 `provideGet`（只提供 `ctx.get`）——生产代码走 `ctx.get('sessionProjections')`，
    // 而未 inject 的**属性访问**在真实 cordis 上会抛错；只换属性会让本用例测到 mock 的
    // 旧闭包而不是被测行为。
    h.provideGet('sessionProjections', { stateOf: (): undefined => undefined })

    expect(() => h.service.applySubagentModelForSession('sess-d2', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/sess-d2/)
    // 未写盘：agent.json 未被改写
    const raw = readFileSync(join(h.home, '.agent-presets', p.id, 'agent.json'), 'utf8')
    expect(raw).not.toContain('glm-5.3')
  })

  it("(d3) 预设目录存在但 agent.json 缺失 → 抛错（不静默造预设）", () => {
    const h = setup()
    registerSession(h, 'sess-d3', 'ghost-preset')

    expect(() => h.service.applySubagentModelForSession('sess-d3', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/ghost-preset/)
  })
})
