/**
 * fork（corum）：**指挥模式运行时**——从 `agent-service.ts` 按关注点抽出（2026-09-20）。
 *
 * ## 为什么独立成文件
 *
 * 用户 2026-09-20 定调：「整个 `agent-service` 混入了太多业务能力……各个模块**至少要在
 * 文件层面切分清晰**，方便维护。」
 *
 * 指挥模式是**一整个关注点**：它持有两张按 sessionId 索引的内存表、在 5 处被调用
 * （创建 / 恢复 / 切 preset / 复用泳道），并且是**权限约束的声明方**。把它与
 * 「权限档位」放在同一个类里，正是 2026-09-20 那个漏洞的结构性成因：
 *
 * > `applyTaskPermission`（写用户档位）与 `applyConductorMode`（写模式只读）
 * > 相隔 74 行、各自写同一份会话沙箱、**互不知情**，而沙箱是 last-write-wins
 * > ⇒ 谁最后写谁赢 ⇒ 用户切「完全权限」5 秒内即覆盖只读。
 *
 * 抽出后两者的边界变成**显式接口**：本模块只声明「指挥模式要求什么」，
 * 不碰权限状态；权限由 `permission-policy.ts` 的合成规则裁决。
 *
 * ## 状态归属
 *
 * 两张表随本模块一起搬走（原先挂在 `CorumAgentService` 上）：
 * - `modes`：sessionId → 生效形态（`off` / `profile` / `preset`）
 * - `effects`：sessionId → 撤销器（切出指挥模式 / 切 preset 时先撤销上一次注册）
 *
 * ⚠️ **纯内存，不落盘**。因此**不得**用于决定任何需要跨重启稳定的事实——
 * 实测教训：子 Agent 人格曾因本表在宿主重启后为空而整段漏替换（见
 * `docs/PENDING-conductor-readonly-bash-and-progressive-research.md`）。
 *
 * @module @corum/corum-agent/conductor-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import { corumNarrowDenyFilter, corumVisibleToolNames } from '@corum/corum-orchestration'
import {
  CONDUCTOR_PERSONA,
  CONDUCTOR_SECTION,
  CONDUCTOR_STALE_SECTIONS,
  conductorExecutionDeny,
  type ConductorMode,
} from './conductor.ts'
import { conductorMainReadonlyGuard } from './permission-policy.ts'
import { TOOL_POLICY_SECTION } from './tool-policy.ts'

/**
 * 指挥模式的运行时状态机（每个 `CorumAgentService` 持有一个实例）。
 *
 * 只负责「主 Agent 自己的 scope 上注册什么」与「何时撤销」。它**不写权限状态**：
 * 主 Agent 的只读约束由 `tools.guard` 表达（单调、不可被用户操作覆盖），
 * 而用户选的档位仍由权限层如实记录（worker 子 Agent 要读它）。
 */
export class ConductorRuntime {
  /** sessionId → 撤销器（切出指挥模式或切 preset 时先撤销上一次注册）。 */
  private readonly effects = new Map<string, () => void>()

  /** sessionId → 当前生效形态。 */
  private readonly modes = new Map<string, ConductorMode>()

  /** 该会话此刻是否处于指挥模式（供 `corumConductor` 服务消费）。 */
  isConductor(sessionId: string): boolean {
    return (this.modes.get(sessionId) ?? 'off') !== 'off'
  }

  /**
   * 生效/撤销指挥模式（幂等：同一 sessionId 再次调用先撤销上一次注册）。
   *
   * 在原 `agent-service.ts` 的注释里保留的三条理由仍然成立（此处重述要点）：
   *   ① 为什么在**运行时**裁而不是 preset 里裁——preset 的 standing mount 是所有 join
   *      它的 Agent（含子 Agent）的父 scope，scope 链上的 restriction 会把子 Agent 一起
   *      裁掉（实机证实，见 PLAN-deepseek-orchestrator-agent §3.2 路线 B）。故只在**主
   *      Agent 自己的 scope** 注册，子 Agent 不受影响；
   *   ② deny 名单必须按该 scope **真实可见**的工具名收敛（`corumNarrowDenyFilter` +
   *      `corumVisibleToolNames`）——`tools.restrict()` 对未知名 fail-loud，而
   *      `str_replace_editor` 只在挂 str-replace-editor 行的 preset 里存在
   *      （2026-09-10 官方三模式全崩的根因，见 docs/LESSONS.md §6.18）；
   *   ③ 撤销器按 sessionId 存内存表，**不落盘**（blank 泳道切换 Agent 时口径必须跟随
   *      新 preset，不能残留旧限制）。
   *
   * @param sessionId - 泳道 id（撤销键）。
   * @param agentCtx - 主 Agent 的 scoped 创建/存活上下文。
   * @param mode - 生效形态（`off` / `profile` / `preset`）。
   */
  apply(sessionId: string, agentCtx: Context, mode: ConductorMode): void {
    const previous = this.effects.get(sessionId)
    if (previous !== undefined) {
      this.effects.delete(sessionId)
      previous()
    }
    this.modes.set(sessionId, mode)
    if (mode === 'off') return
    const disposers: Array<() => void> = []
    // 指挥者没有 write/edit/bash 之外的写通路：工具策略段（「用专用工具而不是 bash」）
    // 对它只会误导，用空文本覆盖（与 CONDUCTOR_STALE_SECTIONS 清 tool:write/tool:edit 同一手法）。
    disposers.push(agentCtx.systemPrompt.section({
      name: TOOL_POLICY_SECTION,
      order: agentCtx.systemPrompt.getSectionOrder('TOOL_BASH') - 50,
      text: '',
    }))
    const deny = corumNarrowDenyFilter(
      { deny: conductorExecutionDeny() },
      corumVisibleToolNames(agentCtx),
    )
    if (deny?.deny !== undefined && deny.deny.length > 0) disposers.push(agentCtx.tools.restrict({ deny: deny.deny }))
    for (const staleToolSection of CONDUCTOR_STALE_SECTIONS) {
      disposers.push(agentCtx.systemPrompt.section({
        name: staleToolSection,
        order: agentCtx.systemPrompt.getSectionOrder('TOOL_WRITE'),
        text: '',
      }))
    }
    // 基准模式（preset）追加指挥者角色段——部署人格（`deployment:persona`）保留；
    // orchestrator profile 的人格来自它自己的 preset（persona 行），不再追加（否则重复）。
    if (mode === 'preset') {
      disposers.push(agentCtx.systemPrompt.section({
        name: CONDUCTOR_SECTION,
        order: agentCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA') + 1,
        text: CONDUCTOR_PERSONA,
      }))
    }
    /**
     * ⚠️ **只读约束走 agent-scoped 门禁，不再碰沙箱**（2026-09-20 实测漏洞修复）。
     *
     * 早先实现是在这里 append 一条 `sandbox/mode: read-only`。**那是错的** —— 它让本方法与
     * `applyTaskPermission` 成为**同一份会话沙箱的两个无协调写入者**，而沙箱投影是
     * last-write-wins（`sandbox-policy/src/index.ts:137`）⇒ 谁后写谁赢。实测用户切
     * 「完全权限」5 秒内即覆盖只读（会话 `corum-task-e72b1a8f`），全会话普查 conductor
     * 会话 read-only **存活 0 次** —— 护栏实际上从未生效。
     *
     * 现在：约束放在 guard 上（单调、不可覆盖），且因注册在 `agentCtx` 上而**不泄漏给
     * 子 Agent** ⇒ 用户选的完全权限对 worker 依然生效（用户定调的分档）。
     */
    disposers.push(agentCtx.tools.guard(conductorMainReadonlyGuard()))
    this.effects.set(sessionId, () => { for (const dispose of disposers) dispose() })
  }

  /** 撤销某会话的指挥模式效果（用于服务销毁 / 测试清理）。 */
  dispose(sessionId: string): void {
    const previous = this.effects.get(sessionId)
    if (previous === undefined) return
    this.effects.delete(sessionId)
    previous()
  }
}
