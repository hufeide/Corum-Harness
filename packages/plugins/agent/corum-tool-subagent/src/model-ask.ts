/**
 * fork（corum）2026-09-18：**子 Agent 指定模型不可用 ⇒ 机制问用户**的策略核。
 *
 * ## 与上一版（自动重试）的区别
 *
 * 上一版是「机制自动退回主路由重跑一次 + 事后通知」。用户 2026-09-18 改为**先问用户**，
 * 并按任务形态分两条规则：
 *
 *   1. **前台或后台任务且能 continue 的**：主 Agent 直接询问用户是否回退继续；选「是」则
 *      **临时**更换为主 Agent 的模型完成任务；选「否」则报告子 Agent 配置模型不可用，
 *      后续**主 Agent 不再派遣子 Agent**，所有工作由主 Agent 继续。
 *   2. **一次性任务**：失败后由主 Agent 提醒用户子 Agent 配置的 LLM 当前无法使用，询问是否
 *      同意后续临时切换为主 Agent 模型；选「是」则由主 Agent **重新指派**子 Agent 并使用与
 *      主 Agent 一致的模型完成任务；选「否」则主 Agent 不再指派任何任务，由其全权承担开发
 *      直到任务完成。
 *
 * ## 用户的补充约束（决定了本文件的形状）
 *
 * · **全权由机制保证，不给 LLM 开改模型的口子**——用户原话：「第一个注入的活是机制来干？
 *   如果同意了，还需要 LLM 调用工具更改子 Agent 的模型，这无疑给 LLM 开了一个坏口子。应该
 *   新增机制，全权由机制保证」。故**一切都在机制里做**：问用户、解析答案、改路由、
 *   停用委派，全是本模块的代码，**不新增任何 LLM 可调用的工具或参数**。
 * · **临时生效，不覆盖用户的设置**——用户原话：「并且是临时生效，不覆盖用户的设置，即用户
 *   新建对话，如果用户还配置了原来不可用的大模型，仍然会调用失败，触发这个机制」。故「临时」
 *   只写进会话级内存（`corumOrchestration` 的 `modelOverrides`），**绝不写 settings.yaml /
 *   预设**；新会话照旧用用户配的模型，照旧失败、照旧问。
 * · **提问卡要给永久入口**——用户：「当然在新建的 UI 给用户一个永久更改配置的入口，快捷的
 *   处理这个隐患」，并进一步明确「要用户既能选永久跟随主 Agent 也能选别的模型这才对」。
 *   故永久档有两个选项：永久跟随主 Agent、永久改为**指定的另一个模型**。
 *
 * ## 为什么用 userQuestions 而不是 approval
 *
 * 实测（读官方源码）：`approval.request()` 语义是「允许/拒绝**本次工具调用**」，且**要求会话
 * 有 open turn**（`hasOpenTurn` 否则抛错）；而 `userQuestions.ask()` **无 turn 门禁**、
 * 支持带选项的结构化问题、答案原样返回（`{id, selected[], custom?}`）。本场景的失败可能来自
 * **后台 job 在工具早已返回之后**才 settle，approval 那条路先天不可用。
 * 先例：官方 `plan-mode` 就在 host 侧直接 `ctx.get('userQuestions').ask({...agent, signal})`。
 */

/** 提问的三个档位标签（选项 label 即协议——答案按 label 回传，故必须唯一且稳定）。 */
export const CORUM_MODEL_ASK_TEMPORARY = 'Temporarily use the main Agent\'s model for this session'
export const CORUM_MODEL_ASK_FOLLOW_PERMANENTLY = 'Permanently follow the main Agent\'s model'
export const CORUM_MODEL_ASK_PICK_PERMANENTLY = 'Permanently switch to another model…'
export const CORUM_MODEL_ASK_DECLINE = 'No — stop delegating; do the work yourself'

/** 用户在提问卡上作答后的**机制决定**（答案被解析成这个联合，而不是字符串散落各处）。 */
export type CorumModelAskDecision =
  /** 临时改用给定路由（本会话有效，不落盘）。 */
  | { readonly kind: 'temporary'; readonly route: { provider: string; model: string; reasoningEffort?: string } }
  /** 永久跟随主 Agent（写预设：清除该角色的子 Agent 模型键）。 */
  | { readonly kind: 'permanent-follow' }
  /** 永久改为指定路由（写预设）。 */
  | { readonly kind: 'permanent-route'; readonly route: { provider: string; model: string; reasoningEffort?: string } }
  /** 拒绝：不再委派，主 Agent 自己做。 */
  | { readonly kind: 'decline' }
  /** 用户放弃/关掉了问题（或没有作答通道）——机制按「保守=不改变现状且继续」处理。 */
  | { readonly kind: 'dismissed' }

/** 一次失败的两个关键事实（提问文案与后续动作都要用）。 */
export interface CorumModelFailureFacts {
  /** 哪个子 Agent（label，给人话上下文）。 */
  readonly label: string
  /** 用户为该角色配置的模型路由（不可用的那个）。 */
  readonly configured: { provider: string; model: string }
  /** 机制将采用的回退路由（主 Agent 的真实路由）。 */
  readonly fallback: { provider: string; model: string }
  /** 失败原因原文（子 Agent 的报错）。 */
  readonly cause: string
  /** 该角色（决定永久档写 subagentModel 还是 researchModel）。 */
  readonly role: 'worker' | 'research'
}

/**
 * 提问的**问题文本**（中文，面向用户）。
 *
 * 为什么写中文而代码注释/通知是英文：这条消息的读者是**用户本人**（不是模型），
 * 而本仓的 UI 面向中文用户（设置页、权限档位等都是中文）。
 */
export function corumModelAskQuestion(facts: CorumModelFailureFacts): string {
  return `子 Agent 配置的模型当前不可用，无法用它完成任务。`
}

/** 问题的补充说明（渲染在问题下方、不进选项 label）。 */
export function corumModelAskDetail(facts: CorumModelFailureFacts): string {
  return [
    `子 Agent：${facts.label}`,
    `配置的模型：${facts.configured.provider}/${facts.configured.model}`,
    `可回退到的模型（主 Agent 当前所用）：${facts.fallback.provider}/${facts.fallback.model}`,
    `失败原因：${facts.cause}`,
    '',
    '选择「临时」只对当前会话生效，不改动你的配置；选择「永久」会改写该 Agent 预设的子 Agent 模型。',
  ].join('\n')
}

/**
 * 解析用户答案 → 机制决定。
 *
 * 为什么单独成函数：这段判定是**安全关键**的（错判会把用户的「不要」当成「要」），
 * 抽出来才能被单测直接钉住，而不必起一个 UI。`custom` 自由文本视为「没选档位」。
 *
 * @param selected - 用户选中的选项 label（官方契约：单选回传一个 label）。
 * @param fallback - 机制提供的回退路由（主 Agent 路由）。
 * @param pickedRoute - 用户在二级问题里选的模型路由（未选=undefined）。
 * @returns 机制决定；无法识别时返回 `dismissed`（保守：不改变现状）。
 */
export function corumResolveModelAskDecision(
  selected: readonly string[],
  fallback: { provider: string; model: string; reasoningEffort?: string },
  pickedRoute: { provider: string; model: string; reasoningEffort?: string } | undefined,
): CorumModelAskDecision {
  const choice = selected[0]
  if (choice === undefined) return { kind: 'dismissed' }
  if (choice === CORUM_MODEL_ASK_TEMPORARY) return { kind: 'temporary', route: { ...fallback } }
  if (choice === CORUM_MODEL_ASK_FOLLOW_PERMANENTLY) return { kind: 'permanent-follow' }
  if (choice === CORUM_MODEL_ASK_PICK_PERMANENTLY) {
    // 选了「永久改为别的模型」但二级选择没回来（用户跳过）⇒ 保守当作 dismissed，
    // 绝不默默替用户挑一个模型（那正是用户明确反对的「替我做主」）。
    return pickedRoute === undefined
      ? { kind: 'dismissed' }
      : { kind: 'permanent-route', route: { ...pickedRoute } }
  }
  if (choice === CORUM_MODEL_ASK_DECLINE) return { kind: 'decline' }
  return { kind: 'dismissed' }
}

/**
 * 机制停用委派后，**拒绝委派工具调用**时给模型的理由（原样进工具结果）。
 *
 * 为什么这句话要写这么满：官方 tools 服务的 guard 拒绝会把这段字符串**原样**作为
 * isError 工具结果交给模型（不是异常、不结束 turn），模型的下一步完全取决于它读到了什么。
 * 只说「被拒绝」会让模型反复重试别的委派形态；必须把「为什么 + 该干什么」说全。
 */
export function corumDelegationDisabledReason(): string {
  return 'Delegation is disabled for this session: the user declined to keep delegating after the configured child-Agent model turned out to be unavailable, so no child Agent may be spawned. Do ALL of this work yourself with your own tools until the task is complete — do not retry this tool, do not switch to another delegation tool, and do not ask the user to re-enable it. If the work genuinely cannot proceed alone, say so in your final answer.'
}
