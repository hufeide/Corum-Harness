/**
 * Deepseek 编排专用 Agent 编译产物对账（PLAN-deepseek-orchestrator-agent.md）。
 *
 * 路线 B（实机修正）：orchestrator 的「主 Agent 裁执行工具」**不在 preset 编译裁行**——
 * fork #9 applyChildComposition 让子 Agent composeFrom(parent.ctx) 复用父 preset，preset
 * 裁行会连带子 Agent 也没工具（实机暴露：裁 filesystem/tool-fs 后子 Agent 没写工具
 * 无法执行）。所以 preset 恒全量编译；主 Agent 的裁剪走运行时 tools.restrict（agent-service
 * createAgentForTask 的 orchestrator 分支），只作用于主 Agent scope。
 *
 * 本 spec 对账：
 *   1. orchestrator 模式 preset **仍全量**（含 bash/filesystem/tool-fs 执行行）——
 *      子 Agent join 后才能全功能执行；
 *   2. orchestrator 收紧 worker maxDepth=1（子 Agent 只执行不再派活）；
 *   3. 'full' / 缺省模式行为不变（无 maxDepth 收紧）。
 */
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../src/compile.ts'
import type { AgentProfile } from '../src/profile.ts'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-orch',
    baseMode: 'standard',
    prompt: '编排者',
    model: { provider: 'localhost', model: 'deepseek-v4-pro' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...overrides,
  }
}

describe('compile orchestrator 模式 — preset 恒全量（路线 B：裁剪在运行时 restrict）', () => {
  const yml = compilePreset(profile({ executionTools: 'orchestrator' })).cordisYml

  it('preset 保留全部执行工具行（子 Agent join 后才能全功能执行）', () => {
    expect(yml).toContain('id: tool-bash')
    expect(yml).toContain('id: filesystem')
    expect(yml).toContain('id: tool-fs\n')
    // 2026-09-11 用户定调：str_replace_editor 退场（写面收敛到官方 fs 的 write/edit）。
    // 原断言是退役前的遗留、一直红着（2026-09-12 修），改为反向断言。
    expect(yml).not.toContain('str-replace-editor')
    expect(yml).toContain('dsh-fs-local')
  })

  it('保留只读调查（tool-fs-search）+ 编排全家 + 规划辅助', () => {
    expect(yml).toContain('id: tool-fs-search')
    expect(yml).toContain('id: tool-subagent\n')
    expect(yml).toContain('id: tool-subagent-research')
    expect(yml).toContain('id: tool-subagent-control')
    expect(yml).toContain('id: tool-todo')
  })

  it('收紧 worker maxDepth=1（子 Agent 只执行不再派活）', () => {
    const workerRow = yml.split(/\n {4}- id: /).find(r => r.startsWith('tool-subagent\n'))
    expect(workerRow, 'worker row missing').toBeDefined()
    expect(workerRow).toContain('maxDepth: 1')
  })

  it('research 实例不收 maxDepth（仍恒只读预 deny）', () => {
    const researchRow = yml.split(/\n {4}- id: /).find(r => r.startsWith('tool-subagent-research\n'))
    expect(researchRow, 'research row missing').toBeDefined()
    expect(researchRow).toContain('readonlyResearch: true')
    expect(researchRow).not.toContain('maxDepth')
  })
})

describe('compile full / 缺省模式 — 无回归', () => {
  it("executionTools:'full' 全量 + 无 maxDepth 收紧", () => {
    const yml = compilePreset(profile({ executionTools: 'full' })).cordisYml
    expect(yml).toContain('id: tool-bash')
    expect(yml).toContain('id: filesystem')
    const workerRow = yml.split(/\n {4}- id: /).find(r => r.startsWith('tool-subagent\n'))
    expect(workerRow).not.toContain('maxDepth')
  })

  it('缺省 executionTools（undefined）= full 行为', () => {
    const yml = compilePreset(profile()).cordisYml
    expect(yml).toContain('id: tool-bash')
    expect(yml).toContain('id: filesystem')
    const workerRow = yml.split(/\n {4}- id: /).find(r => r.startsWith('tool-subagent\n'))
    expect(workerRow).not.toContain('maxDepth')
  })
})


describe("compile baseMode 'conductor' — 继承指挥模式（2026-09-10）", () => {
  const yml = compilePreset(profile({ baseMode: 'conductor' })).cordisYml

  it('preset 仍全量（工具面同标准模式，裁剪在运行时）', () => {
    expect(yml).toContain('id: tool-bash')
    expect(yml).toContain('id: filesystem')
    expect(yml).toContain('id: tool-fs\n')
    expect(yml).toContain('id: tool-subagent\n')
    expect(yml).toContain('id: tool-subagent-research')
  })

  it('人格含指挥者核心身份（compile 的 MODE_CORE_IDENTITY.conductor）', () => {
    expect(yml).toContain('you cannot edit files or run commands')
    // 2026-09-20：阶段 1 由 Investigate 改名 Frame（调研改为委派优先，见 conductor.spec.ts）。
    expect(yml).toContain('Frame:')
    expect(yml).toContain('Verify:')
    expect(yml).toContain('Decide:')
  })
})
