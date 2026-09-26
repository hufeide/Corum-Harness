/**
 * fork（corum）2026-09-26：**会话级提权授权**（用户三档里的第 2 档「总是允许」）。
 *
 * ## 为什么需要它、以及为什么是这个形状
 *
 * 官方审批结果的词汇表是**封闭**的（`allowed-once | rejected | cancelled | unavailable`），
 * 未知值会被归一为 `unavailable`（fail-closed）。所以「总是允许」**不能**作为一个新的 outcome
 * 回传 —— 照直写会静默变成「拒绝」。用户三档的落地形状因此是：
 *
 * | 档 | 传给官方的 outcome | 机制侧副作用 |
 * |---|---|---|
 * | ① 允许一次 | `allowed-once` | 无 |
 * | ② **总是允许** | **仍然是 `allowed-once`** | **本模块记一条会话级授权** |
 * | ③ 自动 | ——（用户裁定**预留**，UI 禁用占位） | 无 |
 *
 * 「本次仍回 `allowed-once`」是刻意的：本次与「允许一次」在官方语义上**本来就一样**，
 * 差别只在机制侧**多记了一条**「该会话后续同类请求免问」。
 *
 * ## 为什么是「按父会话」而不是「按子 Agent / 按档位」
 *
 * 用户原话把第 2 档定义为「该会话内**后续所有相关请求**」——主体是**用户所在的会话**
 * （发起委派的那个父会话），而不是某一次子 Agent 或某一个档位。所以键 = 父会话 id。
 * 于是同一父会话下**后续任何子 Agent** 的同类提权都免问，符合「后续所有相关请求」。
 *
 * ## 硬天花板**不**被授权绕过
 *
 * 判定顺序恒为「先硬天花板、后授权」：只读研究子 Agent（`hardCeiling = read-only`）
 * 的提权在**到达授权检查之前**就已经被 `decideEscalation` 判成 `refuse`，
 * 永远不会因为一条会话授权而放行。授权只豁免「上呈用户」这一步，不豁免硬约束。
 *
 * ## 为什么是纯类 + 挂到已有的 `subagents` 服务上（而不是模块级 Map）
 *
 * 红线 1：跨 bundle 共享状态必须是 cordis 服务，模块级 Map 会被 dsh 的源码内联切成
 * **每个 bundle 一份**、互不同步。本模块**只放纯状态逻辑**（可单测），真正的持有者是
 * `SubagentRuntime`（`packages/plugins/agent/corum-subagent/src/index.ts`，
 * 即 `super(ctx, 'subagents')` 那个服务）——它的实例唯一性由根 context 的 `reflect.store`
 * 保证，因此跨 bundle 天然同一份。
 *
 * @module @corum/corum-subagent/escalation-grants
 */

/**
 * 授权面的**窄接口**（红线 3：消费方只声明自己用得到的那一小块，不耦合实现包）。
 *
 * 由 `SubagentRuntime` 实现；应答器经 `parent.ctx.get('subagents')` 取用后按本接口使用。
 */
export interface EscalationGrantFace {
  /**
   * 记一条会话级提权授权（用户在审批卡上点了「总是允许」）。
   * @param sessionId - **父会话**的 id（用户所在的会话）。
   */
  grantEscalation: (sessionId: string) => void
  /**
   * 该父会话是否已被授权「后续同类提权免问」。
   * @param sessionId - 父会话 id；`undefined` 一律视为**未授权**（fail-closed）。
   */
  isEscalationGranted: (sessionId: string | undefined) => boolean
}

/**
 * 会话级授权的**纯状态**（无 cordis 依赖 ⇒ 可直接单测）。
 *
 * 只增不减是有意的：用户说的是「**后续所有**相关请求」，所以一次「总是允许」在整个会话
 * 生命周期内持续有效（会话结束即随服务实例消亡）。若将来要做「撤销」，加 `revoke` 即可。
 */
export class EscalationGrants {
  readonly #granted = new Set<string>()

  /**
   * 记一条授权。
   * @param sessionId - 父会话 id；空值被忽略（不允许出现「空键授权」这种 fail-open）。
   */
  grant(sessionId: string | undefined): void {
    if (sessionId === undefined || sessionId === '') return
    this.#granted.add(sessionId)
  }

  /**
   * 是否已授权。
   * @param sessionId - 父会话 id。
   * @returns 已授权为 `true`；`undefined`/空串恒为 `false`（**朝关闭倒**）。
   */
  isGranted(sessionId: string | undefined): boolean {
    if (sessionId === undefined || sessionId === '') return false
    return this.#granted.has(sessionId)
  }

  /** 已授权的会话数（仅用于测试与诊断）。 */
  get size(): number {
    return this.#granted.size
  }
}
