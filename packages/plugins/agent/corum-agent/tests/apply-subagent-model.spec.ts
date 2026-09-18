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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CorumAgentService } from '../src/agent-service.ts'
import type { AgentProfile } from '../src/profile.ts'
import { compilePreset } from '../src/compile.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'corum-agent-sam-'))
  process.env.CORUM_HOME = home
  // resolveDshHome 会先展开 ~ 再 resolve；home 已是绝对路径，直接生效。
  process.env.DSH_HOME = home
})

afterAll(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

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
  const dir = join(home, '.agent-presets', p.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.json'), JSON.stringify(p, null, 2))
}

/** CorumAgentService 最小测试台：只喂构造器必须的服务；存活会话表按内部形状造。 */
function makeService(): CorumAgentService {
  const svc = Object.create(CorumAgentService.prototype) as CorumAgentService
  const live = new Map<string, unknown>()
  const sessions = new Map<string, unknown>()
  Object.defineProperty(svc, 'taskAgents', { value: live })
  Object.defineProperty(svc, 'typeAgents', { value: sessions })
  Object.defineProperty(svc, 'agents', { value: new Map<string, unknown>() })
  return svc
}

/** 把一个存活会话登记进 taskAgents 表（agent 为最小 stub：projection 只读 id）。 */
function registerSession(svc: CorumAgentService, sessionId: string, presetId: string): void {
  const session = Session.create(SessionId(sessionId))
  const projections = {
    stateOf: (_s: Session, key: string): unknown => (key === 'agentPreset' ? presetId : undefined),
  }
  const agent = { session } as unknown as Agent
  ;(svc as unknown as { taskAgents: Map<string, unknown> }).taskAgents.set(sessionId, { agent, sessionId, cwd: '/tmp/x', profileId: presetId })
  ;(svc as unknown as { ctx: unknown }).ctx = {
    sessionProjections: projections,
    logger: { warn: (): void => {}, info: (): void => {}, error: (): void => {} },
  }
}

describe('applySubagentModelForSession — 委派机制模型永久切换', () => {
  it("(a) worker 写 subagentModel 且预设其他字段全部保留（saveProfile 部分保存陷阱防线）", () => {
    const p = profile()
    writeProfile(p)
    const svc = makeService()
    registerSession(svc, 'sess-a', p.id)

    const result = svc.applySubagentModelForSession('sess-a', 'worker', { provider: 'pi-ai', model: 'glm-5.3' })

    expect(result).toEqual({ presetId: p.id, applied: { provider: 'pi-ai', model: 'glm-5.3' } })
    const saved = JSON.parse(readFileSync(join(home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
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
    expect(readFileSync(join(home, '.agent-presets', p.id, 'agent.cordis.yml'), 'utf8')).toBe(compiled.cordisYml)
    expect(readFileSync(join(home, '.agent-presets', p.id, 'preset.yml'), 'utf8')).toBe(compiled.presetYml)
    expect(existsSync(join(home, '.agent-presets', p.id, 'agent.json'))).toBe(true)
  })

  it('(a2) reasoningEffort 透传写入', () => {
    const p = profile()
    writeProfile(p)
    const svc = makeService()
    registerSession(svc, 'sess-a2', p.id)

    const result = svc.applySubagentModelForSession('sess-a2', 'worker', { provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
    expect(result.applied).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
    const saved = JSON.parse(readFileSync(join(home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.subagentModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3', reasoningEffort: 'high' })
  })

  it("(b) route=undefined 清除键本身（磁盘 JSON 无该键，而非 undefined 占位）", () => {
    const p = profile({ subagentModel: { provider: 'pi-ai', model: 'glm-5.3' } })
    writeProfile(p)
    const svc = makeService()
    registerSession(svc, 'sess-b', p.id)

    const result = svc.applySubagentModelForSession('sess-b', 'worker', undefined)
    expect(result.applied).toBeUndefined()

    const raw = readFileSync(join(home, '.agent-presets', p.id, 'agent.json'), 'utf8')
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
    writeProfile(p)
    const svc = makeService()
    registerSession(svc, 'sess-c', p.id)

    const result = svc.applySubagentModelForSession('sess-c', 'research', { provider: 'pi-ai', model: 'glm-5.3' })
    expect(result).toEqual({ presetId: p.id, applied: { provider: 'pi-ai', model: 'glm-5.3' } })

    const saved = JSON.parse(readFileSync(join(home, '.agent-presets', p.id, 'agent.json'), 'utf8')) as AgentProfile
    expect(saved.researchModel).toEqual({ provider: 'pi-ai', model: 'glm-5.3' })
    expect(saved.subagentModel).toEqual({ provider: 'local', model: 'keep-worker' })
  })

  it('(d1) 未知会话（不在任何存活表）→ fail-loud 抛错', () => {
    const svc = makeService()
    expect(() => svc.applySubagentModelForSession('no-such-session', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/no-such-session/)
  })

  it('(d2) agentPreset 投影为空（解析不到预设）→ 抛错且不写盘', () => {
    const p = profile()
    writeProfile(p)
    const svc = makeService()
    registerSession(svc, 'sess-d2', p.id)
    // 把投影换掉：agentPreset 恒 undefined（agentPreset 投影缺席/为空形态）
    const svcWithEmptyProjection = svc as unknown as { ctx: { sessionProjections: { stateOf: () => undefined } } }
    svcWithEmptyProjection.ctx.sessionProjections = { stateOf: (): undefined => undefined }

    expect(() => svc.applySubagentModelForSession('sess-d2', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/sess-d2/)
    // 未写盘：agent.json 未被改写
    const raw = readFileSync(join(home, '.agent-presets', p.id, 'agent.json'), 'utf8')
    expect(raw).not.toContain('glm-5.3')
  })

  it("(d3) 预设目录存在但 agent.json 缺失 → 抛错（不静默造预设）", () => {
    const svc = makeService()
    registerSession(svc, 'sess-d3', 'ghost-preset')

    expect(() => svc.applySubagentModelForSession('sess-d3', 'worker', { provider: 'pi-ai', model: 'glm-5.3' }))
      .toThrowError(/ghost-preset/)
  })
})
