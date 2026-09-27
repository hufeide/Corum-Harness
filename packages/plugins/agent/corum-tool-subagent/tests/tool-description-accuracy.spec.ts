/**
 * 工具描述**准确性**门禁（2026-09-27 用户要求「看一下各个工具的描述是否准确」）。
 *
 * 审计结论（主张 → 机制证据 → 判定）与逐条核对见台账
 * `audit.orchestration-tool-descriptions-accuracy`；本文件只钉住**当时修掉的**两处
 * 不一致，防止回潮：
 *
 *  ① 只读实例（`subagent_research`）原先照搬写向描述头（"A write-capable delegation is
 *     ISOLATED by default … Pass `isolation: "main"` …"）——它的 schema 里**没有**
 *     `isolation` 参数 ⇒ 等于教模型用一个不存在的参数（指令与能力矛盾，本仓明令禁止）。
 *  ② 只读实例的 schema 里**仍然暴露** `integrate`/`verify`（它们写在
 *     `corumReadonlyResearch` 条件之外）⇒ 只读子 Agent 被允许走「主树合并+验证+提交」的
 *     整合者路径，与"只读"能力面矛盾。
 *
 * 手法：读源码做**结构断言**（与 `model-policy.spec.ts` / `prompt-mechanism-agreement.spec.ts`
 * 同款）。参数面是条件展开的对象字面量，用"唯一出现 + 位置在条件块之后"来钉，而不是
 * 靠脆弱的长正则。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compilePreset } from '../../corum-agent/src/compile.ts'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
/** 只读实例与写实例共用的"非只读"条件块起始位置。 */
const NON_READONLY_BLOCK = SRC.indexOf('...corumReadonlyResearch ? {} : {')
/** 从条件块之后找第一次出现（用于确认参数确实在块内）。 */
const after = (needle: string): number => SRC.indexOf(needle, NON_READONLY_BLOCK)

describe('工具描述准确性：只读实例（subagent_research）不得继承写向能力面', () => {
  it('描述头按能力面分档：只读实例有自己的只读文案', () => {
    expect(NON_READONLY_BLOCK).toBeGreaterThan(-1)
    expect(SRC).toContain("? 'This tool delegates a READ-ONLY research task")
    expect(SRC).toContain('there is no worktree, no branch, and nothing to merge')
    // 写向头不再无条件拼接（原先它就是 `description: 'A write-capable …' + wording.description`）。
    expect(SRC).not.toMatch(/description: 'A write-capable delegation is ISOLATED by default/)
  })

  it('★ schema：isolation / integrate / verify 的**首次**出现都在非只读块之内（条件块之前不得有它们）', () => {
    // 判据说明：这三个键是**条件展开**的 —— 只要它们没出现在 `...corumReadonlyResearch
    // ? {} : {` **之前**，只读实例的 schema 就不会带上它们。因此断言"首次出现位于块内"，
    // 而不是"全文件唯一"：`orchestrate` 的 `tasks[].isolation` 与 `merge.verify` 是另
    // 一套合法 schema（各出现一次，位置在块之后）。
    for (const needle of ['isolation: {', 'integrate: {', 'verify: {']) {
      const first = SRC.indexOf(needle)
      expect(first, `${needle} 未找到`).toBeGreaterThan(-1)
      expect(first, `${needle} 在非只读条件块之前出现 ⇒ 只读实例也会拿到它`).toBe(after(needle))
    }
  })

  it('写向参数仍完整保留给写实例（不得为了修只读而删掉能力面）', () => {
    expect(SRC).toContain('Set true to merge all isolated worktree branches of this session back into the main working tree')
    expect(SRC).toContain('Do NOT combine with `integrate: true`')
    expect(SRC).toContain('How to build, run, and verify this repository after merging')
  })
})

describe('工具描述准确性：机制主张与实现对齐', () => {
  it('隔离枚举与解析器一致（schema/描述不得出现第五个取值）', () => {
    expect(SRC).toContain('isolation must be one of "worktree" (default), "main", "always", "write-tasks"')
    expect(SRC).toContain("enum: ['worktree', 'main', 'always', 'write-tasks']")
  })

  it('★ 模型路由锁定：脚本模式的 agent() 选项也被明令禁止（引擎支持 provider/model）', () => {
    // 引擎面：workflow-ptc 的 SUPPORTED_AGENT_OPTIONS 含 provider/model ⇒ 若提示词只说
    // 「工具 schema 没有 model 参数」，脚本模式仍可路由子 Agent ⇒ 描述必须额外禁掉它。
    expect(SRC).toContain('passing `provider`/`model` there is still routing a child')
  })

  it('interrupt_agent 的语义按官方原文（请求停止、不等待、其后代继续跑）', () => {
    expect(SRC).toContain('ask it to stop with `interrupt_agent` (a request that returns without waiting; its own children keep running)')
  })
})

/**
 * 编排段重排（2026-09-27 用户要求「整段重新编排」）的结构门禁。
 *
 * 归属划分（重排后）：`tool:subagent`（order 2800，`corumSchedulingSectionText`）只讲**本工具的
 * 调度与生命周期**；跨工具的**形式选择 + 成本判据**全部归 `corum:subagent-orchestration`（2801），
 * 且**最短路径原则置顶**。三条不变式：① 归属不回流；② 同一判据不重复；③ 原则在机制段之前。
 */
describe('编排段重排：归属 / 去重 / 顺序', () => {
  const schedStart = SRC.indexOf('export function corumSchedulingSectionText')
  const schedEnd = SRC.indexOf('\n/**', schedStart)
  const schedBody = schedStart === -1 ? '' : SRC.slice(schedStart, schedEnd)
  const orchestrationStart = SRC.indexOf("name: 'corum:subagent-orchestration'")
  const orchestrationBody = SRC.slice(orchestrationStart)

  it('★ 归属：2800 段（本工具调度）不得再谈别的委派工具', () => {
    expect(schedStart).toBeGreaterThan(-1)
    expect(schedEnd).toBeGreaterThan(schedStart)
    // 正面：本工具的调度事实仍在
    expect(schedBody).toContain('ALWAYS runs in the FOREGROUND')
    expect(schedBody).toContain('Use ${toolName} in the background by default')
    expect(schedBody).toContain('TERMINAL when it settles')
    // 反面：跨工具选择已搬走（旧文案里的这句是重排前唯一的"选 orchestrate"出处）
    expect(schedBody).not.toContain('orchestrate')
    expect(schedBody).not.toContain('final integrator')
  })

  it('★ 最短路径原则置顶，且在机制段之前', () => {
    const principle = orchestrationBody.indexOf('SHORTEST PATH WINS')
    const mechanism = orchestrationBody.indexOf('How the mechanism works')
    expect(principle).toBeGreaterThan(-1)
    expect(mechanism).toBeGreaterThan(principle)
    expect(orchestrationBody).toContain('pick the fewest calls that solve the task')
  })

  it('★ 去重：只读与"一个自洽实现"在工作形态表里各只出现一次', () => {
    // 重排前 `- READ-ONLY work (research, search, fact-finding…` 与 `ONE focused, self-contained`
    // 各出现两遍（无条件清单 + hasResearch/hasOrchestrate 分支）。
    expect((SRC.match(/- READ-ONLY work \(research, search, fact-finding/g) ?? []).length).toBe(1)
    expect((SRC.match(/ONE focused, self-contained/g) ?? []).length).toBe(1)
    // 旧的弱版比较句（把对手设成"串行"）不得回潮——真实对手是 N 个后台并发委派。
    expect(SRC).not.toContain('far better than several sequential')
  })

  it('★ 成本判据完整：工具调用数/通知数/隔离额度/手动集成 四要素 + 选长路的三种例外', () => {
    for (const phrase of [
      'N tool calls',
      'N settlement notices landing in your context',
      'exceeding it FAILS the call',
      'a manual `integrate` afterwards',
    ]) expect(orchestrationBody).toContain(phrase)
    // 2026-09-27 结构化：由一整句改为「表头 + 三条子项」，断言随之按结构拆开。
    expect(orchestrationBody).toContain('Keep N separate `subagent` calls ONLY when:')
    expect(orchestrationBody).toContain('the pieces are genuinely NOT independent')
    expect(orchestrationBody).toContain('steer one mid-flight')
    expect(orchestrationBody).toContain('partial results arriving as they settle')
  })
})

/**
 * 投送门禁（2026-09-27 用户要求「要注入」后的架构）。
 *
 * 两块执行纪律（效率 / 沙箱升级）的读者不只是「能委派的 Agent」：子会话正是沙箱升级纪律的读者
 * （块里写着 "In a DELEGATED CHILD session …"）。故投送路径改为两条：
 *   ① standard / ptc / cordis / conductor 与所有子会话：`corum-agent` 在 **root scope** 注册
 *      `corum:execution-discipline`（所有 corum 会话继承）；
 *   ② minimal：preset 是 `complete`（system-prompt 只渲染 persona）⇒ 段进不去，由 `compile.ts`
 *      把它追加进编译出的人格段。
 * 本组把「不再挂在会被连坐清空的位置」与「minimal 真拿得到」都钉住（后者是**编译级**断言）。
 */
describe('投送：执行纪律段的两条注入路径', () => {
  const SERVICE = readFileSync(join(import.meta.dirname, '../../corum-agent/src/agent-service.ts'), 'utf8')
  const COMPILE = readFileSync(join(import.meta.dirname, '../../corum-agent/src/compile.ts'), 'utf8')

  it('① root scope 段：text 为常量、不依赖任何工具可见性', () => {
    const i = SERVICE.indexOf('name: CORUM_EXECUTION_DISCIPLINE_SECTION,')
    expect(i).toBeGreaterThan(-1)
    const body = SERVICE.slice(i, SERVICE.indexOf('})', i))
    expect(body).not.toContain('tools.get')
    expect(body).toContain('corumEfficiencyDisciplineLines()')
    expect(body).toContain('corumSandboxEscalationLines()')
    // 段的注册范围是 root：写在 corum-agent 的服务里（tool-policy / host-identity 同处）。
    expect(SERVICE).toContain('ctx.systemPrompt.section({')
  })

  it('② minimal：纪律被追加进编译出的人格段（complete 模式唯一通路）', () => {
    expect(COMPILE).toContain('personaTextWithDiscipline')
    expect(COMPILE).toContain('isComplete')
    expect(COMPILE).toContain('text: personaTextWithDiscipline,')
  })

  it('★ minimal 编译产物**真的**含两块纪律（编译级投送证据）', () => {
    const text = JSON.stringify(compilePreset({
      id: 'minimal-discipline-probe',
      nickname: '极简纪律探针',
      title: '探针',
      dimension: '研发',
      baseMode: 'minimal',
      prompt: 'probe',
      model: { provider: 'localhost', model: 'deepseek-v4-pro' },
      skills: [],
      mcpServers: [],
      terminal: { mode: 'sandbox' },
      memoryPolicy: { scope: 'agent' },
      version: 1,
      trust: 'user',
    } as never))
    expect(text).toContain('EFFICIENCY DISCIPLINE')
    expect(text).toContain('SANDBOX DENIALS AND ESCALATION')
    // 2026-09-27（审查员 C 报）：minimal 被裁到 persona/tool-bash/filesystem/tool-fs
    // ⇒ 提示词里**不得**点名它没有的工具（指令与能力矛盾）。
    for (const absent of ['`grep`', '`glob`', '`job_output`', '`job_kill`', 'subagent', 'orchestrate']) {
      expect(text, `minimal 提示词点名了不存在的工具：${absent}`).not.toContain(absent)
    }
    // 沙箱块是工具无关的 ⇒ 必须整段在（单一事实源）。
    expect(text).toContain('sandbox_permissions')
  })

  it('子会话继承前提可审计（preset 生成 join）', () => {
    const childSrc = readFileSync(join(import.meta.dirname, '../../corum-subagent/src/child-agent.ts'), 'utf8')
    expect(childSrc).toContain("'agentPresets')?.composeFrom(childCtx, parent.ctx)")
  })
})
