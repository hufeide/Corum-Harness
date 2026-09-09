/**
 * corum isolated provider 单测（`@corum/corum-subagent/isolated`，2026-09-10）。
 *
 * 背景：`orchestrate` 的 script 模式把脚本交给官方 workflow 引擎执行，引擎里的
 * `agent()` **不经过 corum 工具层**——本 provider 把隔离机制搬到 provider 层，让
 * 脚本子会话也建 worktree + 进台账。本 spec 用假编排服务锁定可测内核
 * （`prepareIsolatedChild`）的四件事：
 *   1. 建 worktree 并把 `cwd` 指向它；
 *   2. prompt 前缀注入隔离纪律（与工具层同一文本）；
 *   3. start 成功后 `bindRunId`（settle 精确匹配）；
 *   4. start 失败后 `discardEntry`（否则台账留下永不结算的 active 条目）。
 * 端到端（真实 worktree + 隔离子会话）由 dev 实例实机验证覆盖。
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedSubagentStartRequest } from '../src/index.ts'
import { describe, expect, it } from 'vitest'
import { Config, prepareIsolatedChild } from '../src/isolated/index.ts'

interface Call { readonly kind: string; readonly args: readonly unknown[] }

/** 假编排服务：记录 createWorktreeChild / bindRunId / discardEntry 的调用。 */
function fakeContext(calls: Call[]): Context {
  const ctx = new Context()
  const root = {
    get: (name: string): unknown => name === 'corumOrchestration'
      ? {
          createWorktreeChild: (sessionId: string, parentCwd: string, options: unknown) => {
            calls.push({ kind: 'create', args: [sessionId, parentCwd, options] })
            return { slug: 'wt-spec01', branch: 'wt/wt-spec01', path: '/repo/.corum-worktrees/wt-spec01' }
          },
          bindRunId: (sessionId: string, slug: string, runId: string) => { calls.push({ kind: 'bind', args: [sessionId, slug, runId] }) },
          discardEntry: (sessionId: string, slug: string) => { calls.push({ kind: 'discard', args: [sessionId, slug] }) },
        }
      : undefined,
  }
  ;(ctx as unknown as { root: unknown }).root = root
  return ctx
}

function request(): ResolvedSubagentStartRequest {
  return {
    parent: {
      session: { id: 'session-parent', header: { cwd: '/repo' } },
    } as unknown as Agent,
    prompt: [{ type: 'text', text: 'do the thing' }],
    label: 'spec',
    signal: new AbortController().signal,
  } as unknown as ResolvedSubagentStartRequest
}

describe('prepareIsolatedChild — workflow 脚本子会话的隔离内核', () => {
  it('建 worktree 并把请求 cwd 指向它（父会话 cwd 作为基准）', () => {
    const calls: Call[] = []
    const prepared = prepareIsolatedChild(fakeContext(calls), request(), Config({} as never))
    expect(calls[0]?.kind).toBe('create')
    expect(calls[0]?.args[0]).toBe('session-parent')
    expect(calls[0]?.args[1]).toBe('/repo')
    expect(prepared.request.cwd).toBe('/repo/.corum-worktrees/wt-spec01')
  })

  it('prompt 前缀注入隔离纪律（与工具层同一文本）', () => {
    const prepared = prepareIsolatedChild(fakeContext([]), request(), Config({} as never))
    const text = prepared.request.prompt.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('[corum isolation]')
    expect(text).toContain('branch wt/wt-spec01')
    expect(text).toContain('RELATIVE path only')
    expect(text).toContain('write-denied by the sandbox')
    expect(text.endsWith('do the thing')).toBe(true)
  })

  it('bind(runId) 绑定台账条目；rollback() 回滚', () => {
    const calls: Call[] = []
    const prepared = prepareIsolatedChild(fakeContext(calls), request(), Config({} as never))
    prepared.bind('run-42')
    prepared.rollback()
    expect(calls.map(call => call.kind)).toEqual(['create', 'bind', 'discard'])
    expect(calls[1]?.args).toEqual(['session-parent', 'wt-spec01', 'run-42'])
    expect(calls[2]?.args).toEqual(['session-parent', 'wt-spec01'])
  })

  it('缺 corumOrchestration 服务时 fail loud（不静默降级成不隔离）', () => {
    const ctx = new Context()
    ;(ctx as unknown as { root: unknown }).root = { get: () => undefined }
    expect(() => prepareIsolatedChild(ctx, request(), Config({} as never))).toThrow(/corumOrchestration/)
  })

  it('默认配置：provider 名 corum-isolated、mode always、并发上限 4', () => {
    const config = Config({} as never)
    expect(config.providerName).toBe('corum-isolated')
    expect(config.mode).toBe('always')
    expect(config.maxParallelChildren).toBe(4)
  })
})
