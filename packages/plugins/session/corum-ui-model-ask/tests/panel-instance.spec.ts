/**
 * 决定面板的**组件身份**与**回传失败**守卫（J+K 实机复现的根因）。
 *
 * 为什么用源码断言而不是渲染测试：这两个缺陷**都不会让构建或 typecheck 报错**，
 * 也不会在单次渲染里显形——它们只在「同一个会话里出现**第二次**询问」时才暴露，
 * 而两次询问之间隔着一次真实的子 Agent 失败与重跑。渲染快照测不到这个时序，
 * 但 `key` 的有无是可以逐字断言的事实。
 *
 * ## 缺陷 A：面板缺 `key` ⇒ React 复用组件实例
 *
 * `ModelAskDock` 直接渲染 `<ModelAskPanel pending={pending} />`。**没有 key 时**，
 * 同位置的新询问会被 React 按「同类型同位置」复用上一个实例的组件 state：上一轮点击
 * 留下的 `applying=true`（以及 kind / picked）会带进新面板 ⇒ 新面板一出生就只能渲染
 * `disabled` 的「应用中…」，用户永远点不动。
 *
 * **实机证据（:9333，2026-09-22）**：子 Agent 失败 → 面板出现 → 选「临时用主模型」→
 * 点「应用并继续」→ 重跑（子 Agent 跑满 `sleep 240`）→ **重跑都 `turn/end` 了，面板
 * 仍停在「应用中…」**；而那一刻读到的 pending 实例 `#settled === false`（它从未被
 * `answer()` 过）——即界面显示的那个 pending 和用户点击结算的**不是同一个**。
 * 手动对该实例调一次 `answer()`，面板**立刻消失** ⇒ 摘除管线正常，问题在实例被复用。
 *
 * 官方对照：`ui-user-questions` 的 `QuestionComposer.tsx` 正是
 * `<PlanReviewPanel key={question.key} pending={question} ... />` —— 同一个手法。
 *
 * ## 缺陷 B：`void pending.answer(...)` 吞掉 rejection ⇒ 同样的卡死
 *
 * `PendingModelAsk.answer()` 对一个**已结算**的实例会 reject（`already settled`）。
 * 原实现用 `void` 丢弃该 promise，`setApplying(true)` 已经生效且再无任何代码路径把它
 * 放回 false ⇒ 按钮**永久 disabled**，界面上看不到任何异常，只表现为「应用中…」。
 * 故 `apply()` 必须 `.catch(() => setApplying(false))` 把按钮放开。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX = readFileSync(join(import.meta.dirname, '../src/client/index.tsx'), 'utf8')
const PANEL = readFileSync(join(import.meta.dirname, '../src/client/ModelAskPanel.tsx'), 'utf8')

/** 剥掉注释（`/* … *​/` 与行内 `//`），避免说明性文字被当成代码判据。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('决定面板的组件身份（缺陷 A：缺 key ⇒ 实例复用）', () => {
  it('ModelAskDock 渲染面板时按 pending 身份绑定 key', () => {
    const code = stripComments(INDEX)
    // 精确到「渲染 ModelAskPanel 的那一处」——只断言文件里出现过 key= 是不够的，
    // 那可能是别的元素上的 key，而面板本身仍然没有。
    expect(code).toMatch(/<ModelAskPanel\s+key=\{pending\.key\}\s+pending=\{pending\}/)
  })

  it('面板未被无 key 渲染（防回退）', () => {
    const code = stripComments(INDEX)
    expect(code).not.toMatch(/<ModelAskPanel\s+pending=\{pending\}\s*\/>/)
  })

  it('pending 的 key 是逐次递增的稳定身份（复用判据的来源）', () => {
    const contract = stripComments(
      readFileSync(join(import.meta.dirname, '../src/client/contract.ts'), 'utf8'),
    )
    expect(contract).toContain('nextModelAskKey += 1')
    expect(contract).toMatch(/this\.key = `model-ask:\$\{String\(nextModelAskKey\)\}`/)
  })
})

describe('回传失败不得把按钮锁死（缺陷 B：void 吞掉 rejection）', () => {
  it('apply() 对 answer() 的 rejection 有 catch 兜底', () => {
    const code = stripComments(PANEL)
    const at = code.indexOf('const apply = ')
    expect(at, '找不到 apply()').toBeGreaterThan(-1)
    const body = code.slice(at, code.indexOf('\n  }', at))
    expect(body).toContain('pending.answer(')
    // 关键：必须 catch——裸 `void pending.answer(...)` 会让 applying 永久停在 true。
    expect(body).toMatch(/\.catch\(/)
    expect(body).toMatch(/setApplying\(false\)/)
  })

  it('applying 只在 apply() 里被置 true（其它路径不得误锁）', () => {
    const code = stripComments(PANEL)
    expect(code.match(/setApplying\(true\)/g) ?? []).toHaveLength(1)
  })
})
