/**
 * 提示词语言纪律单测（2026-09-10 用户要求「将提示词都以英文编写」）。
 *
 * 规则：**模型可见提示词一律英文**——系统提示词 / 人格段 / 工具描述 / 工具参数描述 /
 * 注入给 Agent 的消息；UI 文案、错误信息、日志、审计事件摘要保持中文（它们不进模型上下文）。
 *
 * 本 spec 以「源文件扫描」的方式把规则机器化：模型可见位置出现 CJK 即失败。这样任何
 * 后续新增的中文提示词都会被拦下，而不是靠人肉 review。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONDUCTOR_PERSONA } from '../src/conductor.ts'

const SRC = join(import.meta.dirname, '../src')
const CJK = /[\u4e00-\u9fff]/

function source(name: string): string {
  return readFileSync(join(SRC, name), 'utf8')
}

/** 抽出所有 `description: '…'` / `description: "…"` 单行字面量（工具与参数描述）。 */
function descriptionLiterals(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/description:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)) {
    out.push(m[1])
  }
  return out
}

describe('模型可见提示词必须全英文（用户 2026-09-10 定调）', () => {
  it('指挥者人格段（CONDUCTOR_PERSONA）无 CJK', () => {
    expect(CONDUCTOR_PERSONA).not.toMatch(CJK)
  })

  it('内置角色 persona（PM / task / 25 岗位 / 指挥者）无 CJK', () => {
    const src = source('builtin-profiles.ts')
    // 只取 BUILTIN_ROLES 区域 + 两个具名 prompt 常量，避免把昵称/标题（UI 文案）算进来。
    const rolesStart = src.indexOf('const BUILTIN_ROLES')
    const roles = src.slice(rolesStart)
    const promptLiterals = [...roles.matchAll(/prompt:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g)].map(m => m[1])
    expect(promptLiterals.length).toBeGreaterThanOrEqual(26)
    for (const literal of promptLiterals) expect(literal, literal).not.toMatch(CJK)

    const pm = src.match(/const PM_PROMPT = \[([\s\S]*?)\]\.join/)
    expect(pm?.[1], 'PM_PROMPT').toBeDefined()
    expect(pm?.[1]).not.toMatch(CJK)
    const task = src.match(/const TASK_PROMPT = '([\s\S]*?)'\n/)
    expect(task?.[1], 'TASK_PROMPT').toBeDefined()
    expect(task?.[1]).not.toMatch(CJK)
  })

  it('团队调度器工具与参数描述无 CJK', () => {
    for (const literal of descriptionLiterals(source('runtime.ts'))) {
      expect(literal, literal).not.toMatch(CJK)
    }
  })

  it('项目数据工具与参数描述无 CJK', () => {
    for (const literal of descriptionLiterals(source('project-data-service.ts'))) {
      expect(literal, literal).not.toMatch(CJK)
    }
  })

  it('注入给执行者的任务消息模板无 CJK（结构标记保持英文大写）', () => {
    const src = source('runtime-task.ts')
    expect(src).toContain('[TASK]')
    expect(src).toContain('[ROUTE]')
    expect(src).toContain('[CONTEXT]')
    const injection = src.slice(src.indexOf('export function renderTaskMessage'))
    expect(injection).not.toMatch(CJK)
  })

  it('工作区 AGENTS.md 模板无 CJK（会被 dsh-agent-instructions 注入每个会话）', () => {
    const src = source('workspace-agents.ts')
    const template = src.slice(src.indexOf('const AGENTS_TEMPLATE'), src.indexOf('`\n\n/**', src.indexOf('const AGENTS_TEMPLATE')))
    expect(template).not.toMatch(CJK)
    expect(template).toContain('workspace instructions')
  })

  it('润色 / 翻译系统提示词无 CJK', () => {
    const src = source('agent-service.ts')
    for (const marker of ['You are a prompt-polishing assistant', 'You are a translation assistant']) {
      expect(src).toContain(marker)
    }
    // 旧中文系统提示词不得回潮。
    expect(src).not.toContain('你是提示词润色助手')
    expect(src).not.toContain('你是翻译助手')
  })

  it('隔离 / 编排机制段与前台 settlement notice 保持英文（回归）', () => {
    const src = source('../../corum-tool-subagent/src/index.ts')
    expect(src).toContain('[corum isolation]')
    expect(src).toContain('final report:')
    expect(src).not.toMatch(/description:\s*'[^']*[\u4e00-\u9fff]/)
  })
})
