/**
 * fork #10 双实例编译产物对账（PLAN-subagent-isolation §1.1/§3）：
 *   1. delegation 组含 worker（subagent）+ research（subagent_research）双行，
 *      provider=corum-spawn、name=@corum/corum-tool-subagent；
 *   2. research 实例恒只读：readonlyResearch + deny 全写工具（不可移除）；
 *   3. 模型锁：subagentModel/researchModel → config.model（research 缺省同 worker）；
 *   4. parallelWork 显式键才进 config（缺省省略，由 host settings 兜底）；
 *   5. 写工具清单与 fork #10 常量逐字对账（防 mount fail-loud）。
 */
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../src/compile.ts'
import type { AgentProfile } from '../src/profile.ts'

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'test-dual',
    baseMode: 'standard',
    prompt: '测试 Agent',
    model: { provider: 'local', model: 'deepseek-v4-flash' },
    skills: [],
    mcpServers: [],
    terminal: { mode: 'sandbox' },
    memoryPolicy: { scope: 'agent' },
    version: 1,
    trust: 'user',
    ...overrides,
  }
}

/** 与 fork #10（corum-tool-subagent/src/index.ts）常量逐字一致——改任一侧需同步。 */
const FORK10_WRITE_TOOLS = ['str_replace_editor', 'write', 'edit', 'bash', 'pwsh']

/** fork（corum）：research 实例要 deny 的变异工具（shell 保留，2026-09-12）。 */
const FORK10_MUTATION_TOOLS = ['str_replace_editor', 'write', 'edit']

function dualRows(yml: string): { worker: string; research: string } {
  // 双实例行在 delegation 组的 config 里（缩进 `    - id: `），按行首 id 切分。
  const rows = yml.split(/\n {4}- id: /)
  const worker = rows.find(r => r.startsWith('tool-subagent\n'))
  const research = rows.find(r => r.startsWith('tool-subagent-research\n'))
  expect(worker, 'worker row missing').toBeDefined()
  expect(research, 'research row missing').toBeDefined()
  return { worker: worker!, research: research! }
}

describe('compilePreset — fork #10 双实例行', () => {
  it('双实例恒输出（research 不可移除），provider=corum-spawn', () => {
    const { worker, research } = dualRows(compilePreset(profile()).cordisYml)
    expect(worker).toContain('name: "@corum/corum-tool-subagent"')
    expect(worker).toContain('provider: "corum-spawn"')
    expect(worker).toContain('toolName: "subagent"')
    expect(research).toContain('toolName: "subagent_research"')
    expect(research).toContain('readonlyResearch: true')
  })

  // fork（corum）2026-09-12 用户定调：research **开放 shell**（调研要跑命令），
  // 只读性改由子会话沙箱 read-only 保证（见 corum-subagent 的 readonlySandbox）——
  // 因此科研实例只 deny 变异工具（write/edit/str_replace_editor），**不再 deny bash**。
  it('research 预 deny 变异工具、保留 shell（与 fork #10 清单对账）', () => {
    const { research } = dualRows(compilePreset(profile()).cordisYml)
    for (const tool of FORK10_MUTATION_TOOLS) {
      expect(research).toContain(`"${tool}"`)
    }
    expect(research).not.toContain('"bash"')
    if (process.platform !== 'win32') {
      // 非 win32 不 deny 未装载的 pwsh（tools.restrict 未知名 fail loud）。
      expect(research).not.toContain('"pwsh"')
    }
  })

  it('模型锁：subagentModel 进 worker config.model；research 缺省同 worker', () => {
    const { worker, research } = dualRows(compilePreset(profile({
      subagentModel: { provider: 'local', model: 'deepseek-v4-flash' },
    })).cordisYml)
    expect(worker).toContain('model:')
    expect(worker).toContain('provider: "local"')
    expect(research).toContain('provider: "local"')
  })

  it('researchModel 独立配置时覆盖 research 实例模型', () => {
    const { research } = dualRows(compilePreset(profile({
      subagentModel: { provider: 'local', model: 'deepseek-v4-flash' },
      researchModel: { provider: 'pi-ai', model: 'kimi-k3-1' },
    })).cordisYml)
    expect(research).toContain('provider: "pi-ai"')
    expect(research).toContain('model: "kimi-k3-1"')
  })

  it('parallelWork 显式键才进 config；缺省省略', () => {
    const bare = dualRows(compilePreset(profile()).cordisYml)
    expect(bare.worker).not.toContain('isolation:')
    expect(bare.worker).not.toContain('maxParallelChildren')
    const full = dualRows(compilePreset(profile({
      parallelWork: { maxParallelChildren: 2 },
    })).cordisYml)
    expect(full.worker).toContain('maxParallelChildren: 2')
  })

  it('2026-09-21：隔离/合并键不再透传（preset 无法覆盖机制）', () => {
    // 结构上已无法表达（见 profile.ts 的 ParallelWorkPolicy）：这里只断言产物侧不留痕。
    const { worker } = dualRows(compilePreset(profile({
      parallelWork: { maxParallelChildren: 3 },
    })).cordisYml)
    expect(worker).not.toContain('isolation:')
    expect(worker).not.toContain('integrateChecks')
    expect(worker).not.toContain('merger')
    expect(worker).not.toContain('worktreeRoot')
    expect(worker).not.toContain('branchPrefix')
    expect(worker).not.toContain('autoCleanup')
    expect(worker).not.toContain('denyDirectFs')
  })
})

/**
 * fork（corum）2026-09-27：**workflow 引擎行必须挂**（用户拍板：「指挥模式就是希望用
 * orchestrate 才设计的，一定要挂」）。
 *
 * 由来：Phase 5 把官方 workflow 全家退役，注释写的理由是「方案甲用 orchestrate 取代官方
 * 通用脚本引擎」——但该理由**对 orchestrate 本身不成立**：orchestrate 的 script 模式正是
 * 构建在这个引擎上。`corum-tool-subagent` 里 `runtimeCtx.get('workflowEngine', false)`
 * 取不到就抛 `orchestrate script mode requires the workflow engine; this preset does not
 * mount @deepseek-ai/dsh-workflow-worker-thread`。只留 `isolate: { workflowEngine: true }`
 * 的 realm 而不挂 provider ⇒ **工具在列、一调用即失败**（实测会话 `corum-task-56b7d485`：
 * 主 Agent 按 orchestrate 做计划，第一次派发即抛错，只能退化成单发 subagent，整轮多烧
 * 20 次派发）。本用例把「引擎行真的在编译产物里」钉死，防它被再次静默退役。
 */
describe('compilePreset — workflow 引擎行（orchestrate script 模式的机制前提）', () => {
  it('★ delegation 组挂 workflow-worker-thread 且未 disabled（走 corum provider）', () => {
    const yml = compilePreset(profile()).cordisYml
    const row = yml.split(/\n {4}- id: /).find(r => r.startsWith('workflow-worker-thread\n'))
    expect(row, 'workflow-worker-thread row missing').toBeDefined()
    expect(row!).toContain('name: "@deepseek-ai/dsh-workflow-worker-thread"')
    expect(row!).toContain('provider: "corum-spawn"')
    expect(row!).not.toContain('disabled: true')
  })

  it('模型面的第二个自撰编排语言仍退役（tool-workflow 不进产物），ralph 同理', () => {
    const yml = compilePreset(profile()).cordisYml
    expect(yml).not.toContain('- id: tool-workflow')
    expect(yml).not.toContain('- id: tool-ralph')
  })
})
