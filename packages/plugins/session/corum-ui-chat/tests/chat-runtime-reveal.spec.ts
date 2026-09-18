/**
 * `chatRuntime.revealSubagentCard` 的服务契约测试（2026-09-18 跳转按钮）。
 *
 * 背景需求（用户实测）：「主 Agent 的会话瀑布会冲走这些卡片」——详情卡「子 Agent」/
 * 「并行工作区」那些行原本只有「进入子会话」，用户还需要一个「就在这一页里带我去看那张卡」
 * 的入口。跨 bundle（`corum-ide-ui` → `corum-ui-chat`）只能走 cordis 服务（红线 1），
 * 故能力加在 `chatRuntime` 上，本文件锁它的**服务契约**：
 *   ① 未注入实现时如实报 `not-ready`（调用方据此退化，绝不假装成功）；
 *   ② 注入后按子会话 id 转发，结果原样透传（含 `pagesLoaded` 与失败原因）；
 *   ③ 撤销注入后回到 `not-ready`（视图卸载不留悬挂实现）。
 *
 * 为什么值得单独测：这个方法的失败形态**必须**可区分 —— 「点了没反应」正是用户报的
 * 痛点，`ok:false` + `reason` 是调用方给出可执行下一步（退化进子会话）的唯一依据。
 */
import { describe, expect, it } from 'vitest'
import { createChatRuntime, type ChatRuntimeService } from '../src/client/chat-runtime.ts'

describe('chatRuntime.revealSubagentCard — 服务契约', () => {
  it('未注入实现 ⇒ not-ready（不抛、不假装成功）', async () => {
    const runtime: ChatRuntimeService = createChatRuntime()
    expect(await runtime.revealSubagentCard('child-1')).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('注入后按 childSessionId 转发，结果（含翻页数与原因）原样透传', async () => {
    const runtime = createChatRuntime()
    const seen: string[] = []
    runtime.setRevealSubagentCard(async (childSessionId) => {
      seen.push(childSessionId)
      return { ok: true, pagesLoaded: 3 }
    })
    expect(await runtime.revealSubagentCard('ede7a455')).toEqual({ ok: true, pagesLoaded: 3 })
    expect(seen).toEqual(['ede7a455'])

    runtime.setRevealSubagentCard(async () => ({ ok: false, reason: 'not-loaded', pagesLoaded: 8 }))
    expect(await runtime.revealSubagentCard('x')).toEqual({ ok: false, reason: 'not-loaded', pagesLoaded: 8 })
  })

  it('撤销注入 ⇒ 回到 not-ready（视图卸载不留悬挂实现）', async () => {
    const runtime = createChatRuntime()
    runtime.setRevealSubagentCard(async () => ({ ok: true, pagesLoaded: 0 }))
    expect((await runtime.revealSubagentCard('a')).ok).toBe(true)
    runtime.setRevealSubagentCard(undefined)
    expect(await runtime.revealSubagentCard('a')).toEqual({ ok: false, reason: 'not-ready' })
  })

  it('★ 摘下调用也安全（本条刻意比老桥更强：它要被另一个 bundle 经窄化能力面消费）', async () => {
    // 与 openContentDiff 那批老桥不同：老桥的契约是「必须经服务对象调用」，而本方法被
    // `corum-ide-ui` 拿到的是一个**函数引用**，摘下调用极易发生 —— 所以它写成实例箭头属性
    // （绑定了 receiver），摘不摘都安全。老桥的坑见同目录 chat-runtime-detached.spec.ts。
    const runtime = createChatRuntime()
    const detached = runtime.revealSubagentCard
    await expect(detached('x')).resolves.toEqual({ ok: false, reason: 'not-ready' })
    runtime.setRevealSubagentCard(async () => ({ ok: true, pagesLoaded: 1 }))
    await expect(detached('x')).resolves.toEqual({ ok: true, pagesLoaded: 1 })
  })
})
