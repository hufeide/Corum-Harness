/**
 * corum-agent/agent-lifecycle-guard —— agent 生命周期风暴的**纯策略**（无 I/O、无 cordis）。
 *
 * ## 为什么需要它（2026-09-18 真机取证）
 *
 * 打包实例上观测到「整套 MCP（pencil + `npx chrome-devtools-mcp`）**每秒被重新启动一次**、
 * 持续 10+ 分钟」。逐层排除后确认真凶形态是：**agent 被反复重建** ——
 *   - 官方 MCP 客户端（`dsh/packages/mcp/mcp-client/src/connection.ts`）自带退避（首 500ms、
 *     每次翻倍、超上限放弃并注销工具），而应用日志里**一条它的重连话术都没有** ⇒ 循环没走
 *     reconnect，而是每次都走了「全新启动」；
 *   - `corumAgent.createAgent` 对同一 profile 有缓存（实测二次调用 2ms 返回、不再起 MCP），
 *     所以「每秒一次」只能来自**缓存未命中**，即 agent 被销毁后又重建；
 *   - 三处销毁点里 `saveProfile` 最可疑：**每次保存 profile 都 `agents.delete`**，于是「有人
 *     在循环保存 profile」就会放出一模一样的风暴。
 *
 * 这个模块把「多久之内重建几次就该报警」做成纯函数，便于单测；判定逻辑本身很简单，但**写错
 * 了就等于护栏静默失效**（真机上表现为「风暴照旧，日志里什么都没有」），所以值得单独锁住。
 */

/** 判定窗口（ms）：窗口内同一 profile 的重建次数达到阈值就报警。 */
export const AGENT_RECREATE_WINDOW_MS = 10_000

/** 窗口内重建次数阈值（含本次）：达到即 warn（正常使用不会在 10s 内重建同一 profile 4 次）。 */
export const AGENT_RECREATE_WARN_COUNT = 4

/**
 * 记录一次重建并判定是否该报警。
 *
 * 纯函数式接口：传入历史时刻数组，返回**窗口内的新数组**与是否报警，由调用方保存数组。
 * 不做 I/O，故可在单测里精确构造「恰好到阈值 / 刚好过期 / 乱序时刻」等边界。
 *
 * @param history - 该 profile 以往的创建时刻（ms；可以包含已过期的旧值）。
 * @param now - 本次创建时刻（ms）。
 * @param windowMs - 判定窗口。
 * @param warnCount - 触发报警的窗口内次数阈值。
 * @returns 窗口内的新时刻数组 + 是否报警。
 */
export function noteAgentRecreate(
  history: readonly number[],
  now: number,
  windowMs: number = AGENT_RECREATE_WINDOW_MS,
  warnCount: number = AGENT_RECREATE_WARN_COUNT,
): { readonly recent: readonly number[]; readonly warn: boolean } {
  const recent = [...history.filter(t => now - t < windowMs), now]
  return { recent, warn: recent.length >= warnCount }
}

/**
 * 报警文案（含调用栈摘要）。
 *
 * ⚠️ 必须带调用栈：风暴的**驱动者**在别处（实测三处销毁点 + 若干 remote 入口），只报「重建了
 * N 次」等于什么都没说；栈帧直接把调用者点名，这也是本轮修复能定位到 `saveProfile` 的原因。
 *
 * @param profileId - 被反复创建的 profile。
 * @param count - 窗口内次数。
 * @param stack - `new Error().stack`（可为 undefined）。
 * @param frames - 保留的栈帧数。
 * @returns 单条 warn 文案。
 */
export function agentRecreateWarning(
  profileId: string,
  count: number,
  stack: string | undefined,
  frames = 6,
): string {
  const trimmed = (stack ?? '')
    .split('\n')
    .slice(1, 1 + frames)
    .map(line => line.trim())
    .filter(line => line !== '')
    .join('\n')
  return `corum-agent: profile "${profileId}" 在 ${AGENT_RECREATE_WINDOW_MS}ms 内被重建 ${count} 次`
    + ` —— 疑似重建风暴（整套 MCP 会随之重启）；调用栈：\n${trimmed === '' ? '(无栈)' : trimmed}`
}

/**
 * 风暴取证的**落盘路径**（`<home>/logs/agent-lifecycle.jsonl`）。
 *
 * ⚠️ 为什么必须另开落点、不能只靠 `ctx.logger`（2026-09-18 实测）：desktop host 跑在
 * `bridge.js` 里，而**它的 stdout 是 JSON 协议线**（见 `plugin-manager.ts` 的注释），
 * 所以 `ctx.logger.*` 根本不出现在应用日志文件里 —— 我把护栏接上 `ctx.logger.warn` 后
 * 复现了一次重建风暴，日志里**一条都没有**。宿主侧「没有日志可读」就是本轮排查最贵的成本，
 * 所以这个罕见但严重的条件配一个专用、可 grep 的 JSONL 落点。
 *
 * @param home - CORUM_HOME/DSH_HOME（未设置时返回 undefined，调用方跳过落盘）。
 * @returns 诊断文件绝对路径。
 */
export function lifecycleDiagPath(home: string | undefined): string | undefined {
  if (home === undefined || home === '') return undefined
  return `${home.replace(/\/+$/, '')}/logs/agent-lifecycle.jsonl`
}
