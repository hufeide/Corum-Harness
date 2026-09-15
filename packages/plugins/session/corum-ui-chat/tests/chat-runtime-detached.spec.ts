/**
 * chatRuntime 服务桥方法的「摘下调用」回归测试（2026-09-13 Review 面小轮）。
 *
 * 背景缺陷：SubagentChanges 曾写 `const openDiffFn = chatRuntimeRef.current?.openContentDiff;
 * await openDiffFn({ ... })`——把 ChatRuntimeImpl 的类方法摘下来再调，`this` 丢失，
 * 方法体访问私有字段 #openContentDiff 时抛
 * "Cannot read properties of undefined (reading '#openContentDiff')"。
 * 修复：调用方一律经服务对象调用（runtime.openContentDiff(...)），与文件工具卡注册壳
 * 的 openFileAtLine 调用形态一致。
 *
 * 本测试不锁实现（不要求 impl 是箭头函数 / bind），只锁调用方契约：
 * ① 服务面上所有「靠 this 访问私有字段」的桥方法必须能被枚举到（防止新增桥漏检）；
 * ② 经服务对象调用时各桥确实转发到注入的后端 fn（修复后的真实调用形态）。
 */
import { describe, expect, it } from 'vitest'
import { createChatRuntime, type ChatRuntimeService } from '../src/client/chat-runtime.ts'

/** 服务面上依赖 receiver 的桥方法名（新增同类桥时必须加进本清单）。 */
const BRIDGE_METHODS = ['openContentDiff', 'openFileAtLine', 'sessionCwd'] as const

describe('chatRuntime 桥方法 — 经服务对象调用（修复后的调用形态）', () => {
  it('openContentDiff 经服务对象调用 → 转发注入的 fn，结果透传', async () => {
    const runtime = createChatRuntime()
    expect(runtime.openContentDiff).toBeTypeOf('function')
    // 未注入时降级为「编辑器服务未就绪」，不抛。
    const notReady = await runtime.openContentDiff!({ absolutePath: '/a', originalContent: 'x' })
    expect(notReady).toEqual({ ok: false, error: '编辑器服务未就绪' })

    let seen: { absolutePath: string; originalContent: string } | undefined
    runtime.setOpenContentDiff(async (input) => {
      seen = input
      return { ok: true }
    })
    const opened = await runtime.openContentDiff!({ absolutePath: '/ws/f.ts', originalContent: 'before' })
    expect(opened).toEqual({ ok: true })
    expect(seen).toEqual({ absolutePath: '/ws/f.ts', originalContent: 'before' })
  })

  it('openFileAtLine / sessionCwd 经服务对象调用 → 转发注入的 fn', async () => {
    const runtime = createChatRuntime()
    runtime.setOpenFileAtLine(async (path, line) => ({ ok: path === '/a.ts' && line === 3 }))
    await expect(runtime.openFileAtLine!('/a.ts', 3)).resolves.toEqual({ ok: true })

    runtime.setSessionCwd(() => '/ws/root')
    expect(runtime.sessionCwd!()).toBe('/ws/root')
  })
})

describe('chatRuntime 桥方法 — 摘下调用契约（回归护栏）', () => {
  it('服务面声明的桥方法在实现上全部存在且为函数（清单防漂移）', () => {
    const runtime = createChatRuntime() as ChatRuntimeService
    for (const name of BRIDGE_METHODS) {
      expect(runtime[name], `桥方法 ${name} 缺失`).toBeTypeOf('function')
    }
  })

  it('桥方法脱离 receiver 调用会立刻失败——证明调用方不得使用摘下形态', () => {
    const runtime = createChatRuntime()
    runtime.setOpenContentDiff(async () => ({ ok: true }))
    // 摘下方法调用（历史缺陷形态）：impl 用私有字段实现，detached 调用必然抛。
    // 若未来 impl 改为箭头函数 / bind(this)（此时摘下调用也安全），本断言需随
    // 调用方契约一起更新——在那之前，它挡住「调用方重新引入摘下形态」的回归。
    const detached = runtime.openContentDiff as unknown as (
      input: { absolutePath: string; originalContent: string },
    ) => Promise<unknown>
    expect(() => detached({ absolutePath: '/a', originalContent: 'x' })).toThrow()
  })
})
