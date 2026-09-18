/**
 * agent 重建风暴护栏的纯策略单测（2026-09-18 真机取证）。
 *
 * 背景：打包实例上实测「整套 MCP（pencil + `npx chrome-devtools-mcp`）每秒重启一次、持续
 * 10+ 分钟」。官方的 MCP 重连退避覆盖不到这个形态（日志里一条重连话术都没有），真凶是
 * **agent 被反复重建**（`createAgent` 有缓存 ⇒ 每秒一次只能来自缓存未命中；三处销毁点里
 * `saveProfile` 每次都会 `agents.delete`）。
 *
 * 这个护栏只有两种失效方式，都必须被测试挡住：
 *   ① 阈值算错 ⇒ 风暴期间**不报警**（日志里什么都没有，等于没护栏）；
 *   ② 窗口算错 ⇒ 正常使用（保存一次 profile、切换 profile）**误报**，噪音淹没真信号。
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_RECREATE_WARN_COUNT,
  AGENT_RECREATE_WINDOW_MS,
  agentRecreateWarning,
  noteAgentRecreate,
} from '../src/agent-lifecycle-guard.ts'

describe('noteAgentRecreate — 重建风暴判据', () => {
  it('第一次创建不报警', () => {
    const v = noteAgentRecreate([], 1000)
    expect(v.recent).toEqual([1000])
    expect(v.warn).toBe(false)
  })

  it('窗口内连续重建：恰好到阈值才报警（阈值 - 1 次不报）', () => {
    let history: readonly number[] = []
    const warns: boolean[] = []
    for (let i = 0; i < AGENT_RECREATE_WARN_COUNT + 1; i += 1) {
      const v = noteAgentRecreate(history, 1000 + i * 1000)
      history = v.recent
      warns.push(v.warn)
    }
    // 第 1..3 次不报，第 4 次（= 阈值）起报
    expect(warns.slice(0, AGENT_RECREATE_WARN_COUNT - 1)).toEqual([false, false, false])
    expect(warns[AGENT_RECREATE_WARN_COUNT - 1]).toBe(true)
    expect(warns[AGENT_RECREATE_WARN_COUNT]).toBe(true)
  })

  it('★ 真机形态：每秒一次 ⇒ 必然报警', () => {
    let history: readonly number[] = []
    let warned = 0
    for (let i = 0; i < 30; i += 1) {
      const v = noteAgentRecreate(history, i * 1000)
      history = v.recent
      if (v.warn) warned += 1
    }
    expect(warned).toBeGreaterThan(20) // 持续风暴会持续报警，而不是只报一次
  })

  it('★ 过期时刻被剔除：慢节奏重建不误报（窗口外的旧记录不留着凑数）', () => {
    const windowMs = AGENT_RECREATE_WINDOW_MS
    const old = [0, 1, 2, 3, 4].map(i => i * 1000)
    // 很久之后才重建一次：窗口内只有本次 ⇒ 不报
    const v = noteAgentRecreate(old, windowMs * 10)
    expect(v.recent).toEqual([windowMs * 10])
    expect(v.warn).toBe(false)
  })

  it('边界：恰好等于窗口宽度的旧记录算过期，窗口内的仍然计数（`< windowMs` 语义）', () => {
    const now = AGENT_RECREATE_WINDOW_MS
    // t=0 距 now 恰好一整个窗口 ⇒ 过期剔除；t=1、t=2 仍在窗口内 ⇒ 保留
    const v = noteAgentRecreate([0, 1, 2], now)
    expect(v.recent).toEqual([1, 2, now])
    // 3 条 < 阈值 4 ⇒ 不报警（防误报：慢节奏重建不该触发）
    expect(v.warn).toBe(false)
  })

  it('不同 profile 各自计数（护栏按 profile 分组，调用方传各自的 history）', () => {
    const a = noteAgentRecreate([], 0)
    const b = noteAgentRecreate([], 0)
    expect(a.recent).toEqual([0])
    expect(b.recent).toEqual([0])
  })
})

describe('agentRecreateWarning — 报警必须点名驱动者', () => {
  it('文案带 profile、次数与调用栈帧（没有栈就如实写「无栈」）', () => {
    const stack = ['Error', '    at saveProfileRemote (/x/agent-service.ts:1462:5)', '    at dispatch (/y/gateway.ts:1:1)'].join('\n')
    const text = agentRecreateWarning('corum-dev', 5, stack)
    expect(text).toContain('"corum-dev"')
    expect(text).toContain('5 次')
    expect(text).toContain('saveProfileRemote')
    expect(text).toContain('agent-service.ts:1462')
  })

  it('stack 为 undefined 时不抛、如实标注', () => {
    expect(agentRecreateWarning('p', 4, undefined)).toContain('(无栈)')
  })

  it('栈帧数量受 frames 限制（日志别被一条 warn 塞满）', () => {
    const stack = ['Error', ...Array.from({ length: 30 }, (_, i) => `    at f${i} (/x.ts:${i}:1)`)].join('\n')
    const text = agentRecreateWarning('p', 4, stack, 3)
    expect(text).toContain('f0')
    expect(text).toContain('f2')
    expect(text).not.toContain('f3 (')
  })
})
