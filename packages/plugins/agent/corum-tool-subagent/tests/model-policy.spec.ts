/**
 * fork（corum）子 Agent 模型策略的机器化对账（2026-09-18 用户定调）。
 *
 * ## 用户策略（四条，逐条落成断言）
 *
 * 1. **子 Agent 使用模型必须唯一，不给 LLM 候选列表**——成本考量；菜单表达要一致，
 *    用户设了子 Agent 路由到哪个模型就跑哪个模型。
 * 2. **子 Agent 默认路由跟随主 Agent**；若子 Agent **模型调用出错**，则退回主 Agent
 *    路由确保任务完成，并**通知用户该情况的处理方式**。
 * 3. **搜索（research）与工作（worker）两种 Agent 都必须遵守**上述策略。
 * 4. **orchestrate 也不能豁免**——严格遵守同一条策略。
 *
 * ## 为什么用「源码扫描式」对账
 *
 * 本仓先例：`prompt-discipline.spec.ts`（决策点分工）、`corum-agent/tests/builtin-roles.spec.ts`
 * （`indexOf` 切片钉规则顺序）。理由是这些约束住在**模型读到的文本面**与**工具 schema 面**里，
 * 一旦被悄悄改回去（例如有人「顺手」把 `tasks[i].model` 加回来），只有实机重启并读工具描述
 * 才看得出来。本 spec 把四条策略变成断言，回潮即红。
 *
 * 覆盖边界：本 spec 只做**文本/schema 面**断言，不改任何机制语义；运行期行为由实机取证。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
const COMPILE_SRC = readFileSync(
  join(import.meta.dirname, '../../corum-agent/src/compile.ts'),
  'utf8',
)
const LIST_MODELS_SRC = readFileSync(join(import.meta.dirname, '../src/list-models.ts'), 'utf8')

/** 取一段源码：从 `from` 到其后第一个 `to`（不含）。顺序即语义锚点。 */
function between(from: string, to: string): string {
  const start = SRC.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0)
  const end = SRC.indexOf(to, start + from.length)
  expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

/**
 * 剥掉注释后的源码——用于「这段代码还在不在」类断言。
 *
 * 为什么需要：本文件给被移除的机制留了说明性注释（例如「`taskModel` 已按用户策略
 * 移除」），裸子串判会把**注释**也算成通路，于是断言在「代码已删干净」时反而变红。
 * 第一次写 §策略①② 的第三条断言时正是这么红的——留下这条纪律：判「代码有没有」
 * 先剥注释，判「文案有没有」才用原文。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('策略①② 模型唯一：LLM 无法表达子 Agent 模型偏好', () => {
  it('subagent 工具 schema 不含模型参数（官方条件展开块恒不展开）', () => {
    // 官方 modelSelectionEnabled 门禁恒 false ⇒ provider/model/reasoning_effort 不展开。
    // 断言锚点：模型锁注释仍在，且 parameters 段里没有这三个字段名。
    const params = between('parameters: {', 'integrate: {')
    expect(params).not.toMatch(/\bprovider\s*:/)
    expect(params).not.toMatch(/\breasoning_effort\s*:/)
  })

  it('★ orchestrate 的 tasks[].model 已从 LLM 可见 schema 剔除（策略④）', () => {
    // 2026-09-18：此前 `tasks[i].model` 是 LLM 可见参数（描述还写着 "mechanism lock"），
    // 主 Agent 可据此把子 Agent 换到任意模型——正是策略禁止的「让 LLM 决定子 Agent 模型」。
    expect(SRC).not.toContain('Fixed model for this task')
    // 反向：tasks 段的 properties 里不得再出现 model 键。
    const tasksBlock = between('tasks: {', 'merge: {')
    expect(tasksBlock, 'orchestrate tasks 段又出现了 model 参数').not.toMatch(/\n\s{20,}model:\s*\{/)
  })

  it('★ 工具描述也不再宣告 model（schema 删了、描述还写着 = 教模型用不存在的参数）', () => {
    // 实测踩到：schema 剔了 model，但 DECLARATIVE 那行描述仍列着 `model`，
    // 模型会照着描述去传 ⇒ 未知参数。描述与 schema 必须同口径。
    expect(SRC).not.toContain('`label`, `isolation`, `research`, `model`')
  })

  it('★ per-task 模型的接线（taskModel）已彻底移除，不留半条通路', () => {
    // schema 删了但接线还在 = 仍可被内部调用方注入。判据必须**只看代码不看注释**
    // （本文件留了「已移除」的说明性注释，若按裸子串判会与注释一起变红——第一次
    // 写这条断言时就踩了，故这里剥掉注释再判）。
    const code = stripComments(SRC)
    expect(code).not.toMatch(/taskModel/)
    expect(code).not.toMatch(/task\.model/)
  })

  it('模型路由**始终两档**：预设配的模型 > 跟随主 Agent（运行期无全局兜底档）', () => {
    // 用户 2026-09-18 澄清：「跟随主 Agent 就是主 Agent 当前预设哪个，子 Agent 也预设哪个。
    // 全局页面的配置只是说你创建一个新预设的时候默认使用这套配置……**始终是两档**」。
    // ⇒ 运行期**不得**读 `corum-subagent` 的 defaultModel/defaultResearchModel。
    expect(SRC).toContain('const corumEffectiveModel = config.model')
    expect(SRC, '运行期又读了全局兜底档（它应只是「新建预设的模板」）')
      .not.toMatch(/corumGlobal\(\)\.default(Research)?Model/)
  })

  it('候选列表工具（list_subagent_models）存在，但只在 modelSelectionSettings 开启时注册', () => {
    // 策略①：不给 LLM 候选列表。corum 的 preset 编译恒关该开关 ⇒ 该工具不上工具面。
    expect(LIST_MODELS_SRC).toContain("name: 'list_subagent_models'")
    expect(SRC).toContain('if (modelSelectionPolicy !== undefined) registerListSubagentModels(runtimeCtx, modelSelectionPolicy)')
  })

  it('★ corum preset 编译恒关 modelSelectionSettings（候选列表工具因此不可达）', () => {
    expect(COMPILE_SRC).toContain('modelSelectionSettings: false')
  })
})

describe('策略② 失败回退：模型调用出错 ⇒ 退回主 Agent 路由重试一次 + 通知用户', () => {
  it('★ 回退只在「用的是用户配置的模型」时触发（跟随父时不重复跑）', () => {
    const route = between('const configuredRoute =', 'const modelFailureOf =')
    // 必须同时要求 corumEffectiveModel 存在、且父路由可解析。
    expect(route).toContain('corumEffectiveModel !== undefined')
    expect(route).toContain('parentOptions.provider !== undefined')
    expect(route).toContain('parentOptions.model !== undefined')
  })

  it('★ 判定用官方契约 stopReason === "error"（不是错误串匹配）', () => {
    const fn = between('const modelFailureOf =', 'const startRun =')
    expect(fn).toContain("stopReason === 'error'")
  })

  it('★ 回退路由 = 父 Agent 真实路由（清掉 agentOptions ⇒ 官方 seam 跟随父）', () => {
    // 第二轮（attempt === 1）必须清掉角色锁的 agentOptions，让官方 seam 用父路由。
    const block = between('for (let attempt = 0; attempt < attempts; attempt++)', 'const run = await startRun()')
    expect(block).toContain('delete request.agentOptions')
  })

  it('★ 首轮先对「配置的路由」做真路由预检（spawn 期解析失败也走回退，不直接抛）', () => {
    // 锁定路径不走 `if (corumLockedOptions === undefined)` 里的预检 ⇒ 配错的模型若只靠
    // settle 兜，会在 spawn 期直接抛出去、用户看到「任务失败」而非「已回退」。
    const block = between('if (attempt === 0) {', 'const run = await startRun()')
    expect(block).toContain('preflightChildLlmRoute')
    expect(block).toContain('fallbackReason =')
    expect(block).toContain('continue')
  })

  it('★ 回退只做一次（不递归：重试分支内不再 catch 回退）', () => {
    // 重试后的 settle 不在 try 里再包一层回退 —— 出现第二次 delete request.agentOptions 即回潮。
    const all = SRC.split('delete request.agentOptions').length - 1
    expect(all, '回退逻辑出现了多处，可能被改成了递归重试').toBe(1)
  })

  it('★ 回退后通知用户，且通知里含「处理方式」（可执行下一步）', () => {
    const notify = between('function corumNotifyModelFallback(', 'function corumNotifySettleCommitFailures')
    // 用户策略原文要求「通知用户该情况的处理方式」⇒ 必须给出可执行的下一步。
    expect(notify).toContain('Configured child model')
    expect(notify).toContain('Retried on (main Agent route)')
    expect(notify).toContain('What this means')
    expect(notify).toMatch(/Agent presets|Settings/)
  })
})

describe('策略③④ 两种 Agent 一致 + 提示词诚实', () => {
  it('★ worker 与 research 由同一 config 工厂生成（策略③：同一套策略）', () => {
    expect(COMPILE_SRC).toContain("corumSubagentConfig('worker', profile, mcpDenyNames)")
    expect(COMPILE_SRC).toContain("corumSubagentConfig('research', profile, mcpDenyNames)")
  })

  it('★ 机制提示词不再宣告 per-task model（否则等于教模型用已删的参数）', () => {
    expect(SRC).not.toContain('a per-task `model` on an `orchestrate` task wins')
  })

  it('★ 机制提示词如实说明：子 Agent 模型不由模型选 + 失败会自动回退', () => {
    const anchor = 'Child model routing is NOT yours to choose'
    const start = SRC.indexOf(anchor)
    expect(start, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0)
    const line = SRC.slice(start, SRC.indexOf('\n', start))
    expect(line).toContain('never try to route a child elsewhere')
    // 承诺了「自动重试一次 + 通知用户」⇒ 实现必须存在（上面三组断言已在钉它）。
    expect(line).toContain('automatically retries that child once on YOUR route')
  })
})
