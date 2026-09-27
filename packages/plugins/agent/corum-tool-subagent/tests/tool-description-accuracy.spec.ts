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
