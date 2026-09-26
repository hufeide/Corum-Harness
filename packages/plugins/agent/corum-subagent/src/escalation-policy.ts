/**
 * fork（corum）2026-09-26：**子 Agent 沙箱提权**的策略核（纯函数，安全关键，可单测）。
 *
 * ## 由来（用户 2026-09-14 需求 + 2026-09-26 拍板）
 *
 * 用户 2026-09-14：「子 Agent 需要请求全新[提权]，子 Agent 需要通知主 Agent 向用户请求权限。」
 * 当时这条通路**完全不存在**：子会话的 `approvalPolicy` 被钉成 `never`
 * （官方语义 ⇒ 任何 ask 在到达任何应答者之前就确定性 `rejected`），于是子 Agent 撞到沙箱墙时
 * **既拿不到权限、也无人知晓**。实测基线（会话 `bca632cd-…`）：4 次沙箱拒绝、**0 次提权尝试**、
 * **0 条审批事件**，子 Agent 自述「本会话已禁用审批提示，我无法从内部申请提权」。
 *
 * 用户 2026-09-26 拍板的口径（见台账 `decision.sandbox.child-escalation-three-tiers`）：
 * - 「P > C 时主 Agent 依自身权限自行决策」由**机制**执行 —— **不给 LLM 开批准工具**
 *   （同 2026-09-18「不给 LLM 开坏口子」）；
 * - 放行分三档：「允许一次」「总是允许（会话内）」「自动（预留）」。
 *
 * ## 核心规则（用户三情形收敛成一条，本文件即其唯一事实源）
 *
 * 设 `X` = 本次请求的档位，`P` = **主 Agent 当前生效**档位，`C` = 子 Agent 派发时快照。
 * 档位序：`read-only < workspace-write < danger-full-access`。
 *
 * > **`X ≤ P` ⇒ 机制自动批准（不打扰用户）；`X > P` ⇒ 上呈用户。**
 *
 * 为什么一条就够（逐条对照用户 9-14 原话）：
 *
 * | 用户情形 | 由官方「提权必须严格更宽」推得 | 本规则给出 | 与用户原话 |
 * |---|---|---|---|
 * | ① P == C | `X > C = P` ⇒ `X > P` | 上呈用户 | ✅「不得自行批准」 |
 * | ② P > C | `X ≤ P` 批准 / `X > P` 上呈 | 够则同意、不足转交 | ✅ 原文 |
 * | ③ P < C | `X > C > P` ⇒ `X > P` | 上呈用户 | ✅「必须上呈」 |
 *
 * 关键性质：**上限恒为 `P`，绝不可能授予超过主 Agent 自身所持的权限**。用户 9-14 记的
 * 加分副作用自动成立：用户收紧主 Agent 权限 ⇒ `P` 变小 ⇒ 子请求不再被自动批准。
 *
 * ## 隔离子 Agent 的额外天花板（安全关键，2026-09-26 交叉审查发现）
 *
 * 官方 `resolve()` 的取值序是 **已批准的显式档位 > 会话 `sandbox/mode` 事件 > 部署默认**
 * （`dsh/packages/sandbox/sandbox-policy/src/index.ts`：*"An approved explicit mode
 * **outranks** the session's last `sandbox/mode` event"*）。而隔离子会话的沙箱正是**用
 * `sandbox/mode` 事件（`source:'delegation'`）钉住的**。
 *
 * ## ⚠️ 2026-09-26 用户裁定：这两个轴要分开，我此前混淆了
 *
 * 我最初的实现把「批准提权会解掉隔离钉」当成「提权威胁隔离」，于是给隔离子也夹了一层天花板。
 * 用户纠正：「**隔离只是工作区隔离**……但若子 Agent 需要访问或者执行一些指令，**需要权限还是合理的**。」
 *
 * 即：
 * - **工作区写边界**由 `confinementGuard` 独立守住（**按路径**判定，**不读档位**）⇒ 提权动不了它；
 * - **沙箱档位**本就是权限面 ⇒ 提权放开它是**本意**，不是漏洞。
 *
 * 故隔离**不构成**档位天花板（见 {@link hardCeilingFor}）。唯一保留的硬天花板是
 * **只读研究**：它本来就不隔离、cwd 就是父工作区，放开写就等于直接写主树。
 * 台账：`risk.sandbox.escalation-outranks-delegation-isolation-pin`（结论已按其裁定修正）。
 *
 * @module @corum/corum-subagent/escalation-policy
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** 档位由窄到宽的全序（与官方 `SANDBOX_MODES` 同序）。 */
export const SANDBOX_MODE_ORDER: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access']

/** 官方提权目标词汇表（`read-only` 是地板，不提权到它）——用来判定「这是不是一个提权」。 */
const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * 判定一个字符串是否是合法的**提权目标**档位。
 *
 * 用途：从子会话 `tool/call` 事件的 `arguments.sandbox_permissions` 里取值时，必须验证它
 * 落在封闭词汇表里 —— 否则 `undefined`/垃圾值会被当成一次提权去处理（fail-open 风险）。
 * @param value - 待判定的值（来自工具参数，类型不可信）。
 * @returns 是否是受支持的提权目标档位。
 */
export function isEscalationTarget(value: unknown): value is SandboxMode {
  return typeof value === 'string' && (ESCALATION_TARGETS as readonly string[]).includes(value)
}

/** 档位序号（越小越窄）；未知值返回 -1。 */
export function sandboxModeRank(mode: string): number {
  return SANDBOX_MODE_ORDER.indexOf(mode as SandboxMode)
}

/**
 * 一次提权请求的**判定输入**（全部是机制可自查的事实，不含任何 prompt 文本）。
 */
export interface EscalationDecisionInput {
  /** 本次请求的档位（`X`）。**调用方必须先用 {@link isEscalationTarget} 验证过**。 */
  readonly requested: SandboxMode
  /** 主 Agent **当前生效**档位（`P`）：`ctx.sandboxPolicy.resolve({ session: parent.session }).mode`。 */
  readonly parentMode: SandboxMode
  /**
   * 该子 Agent 的**硬天花板**（不可逾越，连问都不问）——三类子 Agent 各有其值：
   *
   * | 子 Agent 类别 | `hardCeiling` | 理由 |
   * |---|---|---|
   * | 普通（无隔离、非只读） | `danger-full-access` | 无硬约束，只受 `P` 软约束 |
   * | **隔离期**（`confined`） | `workspace-write` | 隔离是用户裁定的硬不变式；批准更宽档位会**解除隔离钉** |
   * | **只读研究**（`pinReadOnly`） | `read-only` | 只读是用户裁定的硬不变式；批准即破坏「只读研究不落盘」 |
   *
   * 为什么用「天花板」而不是布尔：两类硬约束（隔离 / 只读）性质相同——都是**用户已裁定的
   * 硬不变式**，不该由一次提权绕过。收敛成一个 `SandboxMode` 上界，判定逻辑就只有一条，
   * 也避免「新增一类受限子 Agent 时忘了加分支」。
   */
  readonly hardCeiling: SandboxMode
}

/** 判定结果：机制自行批准、上呈用户、或直接拒绝。 */
export type EscalationVerdict =
  /**
   * 机制自动批准：`X ≤ P`（且未越过硬天花板）。**不打扰用户**。
   */
  | { readonly kind: 'auto-approve' }
  /** 上呈用户决定（`X > P`，但请求本身合法、未越硬天花板）。 */
  | { readonly kind: 'ask-user'; readonly reason: 'exceeds-parent-mode' }
  /**
   * **直接拒绝，连问都不问**：`X` 越过硬天花板（隔离期 / 只读研究）。
   *
   * 为什么不走 `ask-user`：「要不要解除隔离 / 要不要让只读研究落盘」这两个提问本身就
   * 不该存在 —— 用户当初的裁定就是「不需要问」（`PLAN-subagent-isolation.md` §1.3）。
   * 让子 Agent 带着一个注定被拒的请求去打扰用户，只会浪费一次交互，并给模型
   * 「这条路还通」的错觉。
   */
  | { readonly kind: 'refuse'; readonly reason: 'exceeds-hard-ceiling' }

/**
 * **提权判定的唯一事实源**（纯函数，安全关键）。
 *
 * 判定顺序（两条都必须过）：
 * 1. **隔离天花板**（仅 `confined`）：`X` 宽于 `workspace-write` ⇒ 直接上呈用户，
 *    **不得**因为 `P` 很宽就自动批准（否则批准即解除隔离，见模块头注）。
 * 2. **主 Agent 上限**：`X ≤ P` ⇒ 自动批准；否则上呈用户。
 *
 * 为什么第 1 条先于第 2 条：`P` 是**用户可改**的状态（用户在指挥模式切「完全权限」即
 * `P = danger-full-access`），而隔离是**硬不变式**。若先看 `P`，切完全权限后隔离子 Agent
 * 就能自我解除隔离 —— 那正是 2026-09-22 的实测漏洞。故隔离天花板**恒优先**。
 *
 * @param input - 判定输入（见 {@link EscalationDecisionInput}）。
 * @returns 机制批准或上呈用户（见 {@link EscalationVerdict}）。
 */
export function decideEscalation(input: EscalationDecisionInput): EscalationVerdict {
  // ① 硬天花板（隔离 / 只读研究）：越界一律**直接拒绝**，连问都不问。
  if (sandboxModeRank(input.requested) > sandboxModeRank(input.hardCeiling)) {
    return { kind: 'refuse', reason: 'exceeds-hard-ceiling' }
  }
  // ② 主 Agent 上限：X ≤ P ⇒ 机制自己就能做主（绝不超出主 Agent 自身所持）。
  if (sandboxModeRank(input.requested) <= sandboxModeRank(input.parentMode)) {
    return { kind: 'auto-approve' }
  }
  return { kind: 'ask-user', reason: 'exceeds-parent-mode' }
}

/** 最宽档位（普通子 Agent 的硬天花板 = 不设硬约束）。 */
export const WIDEST_MODE: SandboxMode = 'danger-full-access'

/**
 * 由子 Agent 的**委派形态**推出它的硬天花板（唯一事实源）。
 *
 * ## 用户 2026-09-26 的裁定：隔离**不是**档位天花板（我此前把两个轴混为一谈）
 *
 * 用户原话：「我理解，**隔离只是工作区隔离**，即当前代码的工作区隔离，但是若子 Agent 需要
 * 访问或者执行一些指令，**需要权限还是合理的**。」
 *
 * 即两个轴要分开看：
 *
 * | 轴 | 机制 | 提权能否动它 |
 * |---|---|---|
 * | **工作区写边界**（改动只能落在自己的 worktree） | `confinementGuard`（**按路径**判定，不读档位） | **不能**（guard 与档位正交，提权也绕不过） |
 * | **沙箱档位**（进程能访问什么） | `sandbox/mode` + 本次已批准的显式档位 | **能**（这正是「申请权限」的本意） |
 *
 * 故隔离子 Agent **允许**提权到更宽档位：它的写边界仍由 guard 独立守住，
 * 档位只放开「访问/执行」这一类合理的权限诉求。⚠️ 本判定的安全性因此**依赖 guard 在
 * `danger-full-access` 下仍然拦住对父树的写** —— 该前提必须实测（见台账
 * `decision.sandbox.child-escalation-three-tiers` 的验证段；2026-09-26 实机场景①已确认
 * guard 先于提权生效）。
 *
 * **仍然保留的硬天花板**：只读研究（`pinReadOnly`）⇒ `read-only`。
 * 理由与隔离不同：只读研究**本来就不隔离**（`corumShouldIsolate` 对 `readonlyResearch` 返回 false），
 * 它的 cwd 就是**父工作区**；一旦放开写就等于直接写主树，「只读研究不落盘」这条不变式会被绕过。
 *
 * @param options.pinReadOnly - 是否只读研究子 Agent。
 * @returns 该子 Agent 不可逾越的档位上界。
 */
export function hardCeilingFor(options: { readonly pinReadOnly?: boolean }): SandboxMode {
  if (options.pinReadOnly === true) return 'read-only'
  return WIDEST_MODE
}

/** 三档放行的机制词汇（`kind` 即协议；label/description 只作呈现，由 host 下发）。 */
export const CORUM_ESCALATION_OPTIONS = [
  {
    kind: 'allowed-once',
    label: '允许一次',
    description: '只放行这一条命令 · 下次还要问你',
  },
  {
    kind: 'always-allow',
    label: '总是允许',
    description: '本会话内后续同类请求不再问你',
  },
  {
    kind: 'rejected',
    label: '拒绝',
    description: '被拒即最终，子 Agent 不得绕过',
  },
] as const

/** 一个放行档位的呈现数据。 */
export interface CorumEscalationOption {
  readonly kind: 'allowed-once' | 'always-allow' | 'rejected'
  readonly label: string
  readonly description: string
}

/** 用户在提权卡上作答后的**机制决定**。 */
export type CorumEscalationDecision =
  /** 只放行本次（映射到官方 `allowed-once`）。 */
  | { readonly kind: 'allowed-once' }
  /** 本会话内后续同类请求免问（机制侧记一条会话内授权，**不落盘、不改快照**），本次同样放行。 */
  | { readonly kind: 'always-allow' }
  /** 拒绝：被拒即最终。 */
  | { readonly kind: 'rejected' }
  /** 用户放弃/关掉问题（或没有作答通道）——保守：等同拒绝（**绝不静默放行**）。 */
  | { readonly kind: 'dismissed' }

/**
 * 解析用户的提权决定。
 *
 * 安全关键：**未知/缺失一律落到 `dismissed`（⇒ 拒绝）**，绝不因为「解析不出来」而放行 ——
 * 提权是扩权操作，失败必须朝**关闭**方向倒。抽成纯函数才能被单测钉住。
 * @param kind - client 回传的档位（协议键，不可信）。
 * @returns 规范化的机制决定。
 */
export function corumResolveEscalationDecision(kind: string | undefined): CorumEscalationDecision {
  switch (kind) {
    case 'allowed-once': return { kind: 'allowed-once' }
    case 'always-allow': return { kind: 'always-allow' }
    case 'rejected': return { kind: 'rejected' }
    default: return { kind: 'dismissed' }
  }
}

/**
 * 一条**会话内**授权记录（`always-allow` 档）。
 *
 * 作用域刻意收在「会话 + 请求档位」：同一会话内再请求**同一档位或更窄**的提权不再问用户。
 * 不落盘、不写 `sandbox/mode` 事件（用户 9-14：「提权是一次新的授权，**不是**回头修改
 * delegation 事件」）。会话结束即失效。
 */
export interface EscalationGrant {
  readonly sessionId: string
  readonly mode: SandboxMode
}

/**
 * 会话内已有授权是否覆盖本次请求（纯函数）。
 *
 * 语义：授权 `allowed` 覆盖请求 `requested` ⇔ `requested` **不宽于** `allowed`。这样用户
 * 批准过一次 `workspace-write` 后，同一会话里再请求 `workspace-write` 免问；但请求
 * `danger-full-access`（更宽）**仍会问** —— 授权不自动升级。
 * @param allowed - 已获准的档位。
 * @param requested - 本次请求的档位。
 * @returns 是否已被既有授权覆盖。
 */
export function grantCovers(allowed: SandboxMode, requested: SandboxMode): boolean {
  return sandboxModeRank(requested) <= sandboxModeRank(allowed)
}

/**
 * 提权卡的**一行摘要**（收起态第二行：哪个子 Agent + 想升到哪一档）。
 * @param label - 子 Agent 的委托标签（给人话上下文）。
 * @param requested - 请求的档位。
 * @returns 一行摘要。
 */
export function corumEscalationSummary(label: string, requested: SandboxMode): string {
  return `${label} 请求提权到 ${requested}`
}
