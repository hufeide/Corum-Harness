/**
 * fork（corum）：**执行纪律**两块文本的单一事实源（2026-09-27 从 corum-tool-subagent 下沉到此）。
 *
 * 为什么放本包：`corum-agent`（root scope 注册者）、`corum-tool-subagent`、`corum-subagent` 三方
 * 都已依赖 `@corum/corum-orchestration` ⇒ 不需要新的包间依赖，也不需要反向依赖。
 *
 * 投送（2026-09-27 用户要求「要注入」）：
 * · standard / ptc / cordis / conductor 与**所有子会话**：`corum-agent` 在 **root scope** 注册
 *   `corum:execution-discipline` 段（所有 corum 会话继承）；
 * · **minimal**：preset 是 `complete`（system-prompt 只渲染 persona 段）⇒ 段进不去，改由
 *   `compile.ts` 把这两块**追加进编译出的人格段**（同一对 builder）。
 */

/**
 * fork（corum）：bash / 委派效率纪律（机制段条目，**单一事实源**）。
 *
 * 抽成导出纯函数的原因（2026-09-14 委派正确性轮）：这段文本此前以字面量内联在
 * `systemPrompt.section` 回调里，只有「实机重启后读工具描述」才能验证它是否还
 * 与机制事实一致。抽出来后单测能直接断言内容与措辞纪律（`prompt-discipline.spec.ts`），
 * 提示词漂移变成可执行断言。
 *
 * 措辞纪律（用户 2026-09-14 定调）：只写**通用规则 + 机制理由**，英文、祈使、
 * 一句话说清「什么时候用、怎么用、什么时候不能用」；不写实测数字、不写具体
 * 端口/脚本名/会话、不假设某种使用模式；量化只允许机制常量（默认超时、上限、
 * 每次调用新 shell、stdin 忽略、后台句柄等）。
 * @returns 机制段的效率纪律行（含前置空行）。
 */
/** 段名（root scope 注册者与守卫共用；改名要同步 `prompt-discipline.spec.ts`）。 */
export const CORUM_EXECUTION_DISCIPLINE_SECTION = 'corum:execution-discipline'

export function corumEfficiencyDisciplineLines(): string[] {
  return [
    '',
    'EFFICIENCY DISCIPLINE:',
    '- MERGE SMALL QUERIES. Batch the searches you need into ONE call — one `grep` / `glob` / `bash` invocation instead of one call per pattern: every extra call costs a full model round-trip.',
    // 2026-09-27 跨块一致性修复（用户发现子 Agent 用 grep 当读）：旧文案把 `grep`/`sed`/`nl`/`awk`/`head`
    // 的「提取」打包成一种省轮次的读法，与 root scope 的 `corum:tool-policy`（"Read files with `read` —
    // not `cat` / `head` / `tail` / `sed -n` / `less`"）**极性相反** ⇒ 子 Agent 拿两个块，选省轮次的那个。
    // 现在口径唯一：`grep` 定位、`read` 解释。
    '- READ CODE WITH `read`, NOT THE SHELL. To understand a file, open it with `read` (the whole file, or an offset/limit window) — never `cat` / `head` / `tail` / `sed -n` / `awk`. `grep` tells you WHERE to look; `read` tells you WHAT the code does. Shell extraction is for text you pipe, not for code you must reason about.',
    '- KNOW YOUR SHELL. The bash tool runs one command per call, non-interactively with stdin ignored, so a bare `grep foo` returns immediately instead of waiting for input. Commands are time-boxed — 120s by default; pass `timeoutMs` (up to 600000) for longer runs. Create and edit files with the `write`/`edit` tools rather than shell redirection or in-place editors: they keep quoting under control and land in the change-review trail.',
    '- KEEP EACH COMMAND ON ONE LINE, statements joined with `;` or `&&`, so that a loosely delimited fragment cannot do something other than what you intended.',
    '- EVERY CALL GETS A FRESH SHELL. No cwd, variable or function persists between calls, so never rely on a `cd` from an earlier call: chain `cd <dir> && <cmd>` inside one call, or pass `workdir`.',
    '- PUT LONG-RUNNING OR NOT-YET-NEEDED COMMANDS IN THE BACKGROUND. A server, a watcher, a long build or a long test suite belongs behind `run_in_background: true`, so the call returns a handle at once and the conversation is not blocked; read that handle with `job_output` and stop it with `job_kill`. Never replace that handle with "wait a moment, then look again". Do not background a command whose result you need before the next step; do not background an operation that would stop or restart the runtime this session depends on; do not start a background process whose output cannot be retrieved.',
    // fork（corum）2026-09-20 修正（用户报障，见 docs/PENDING-conductor-...md §D1/D2）：
    //
    // 本段**同时注入主会话与子会话**（preset scope 共享），但原文两处假设了「读者能跑构建」：
    //   D1 「run the repo guard ONCE in full」—— 指挥模式的主 Agent **被裁掉了写工具、
    //       shell 也只读**，它物理上跑不了仓库守卫；实测该指令与人格段「you cannot edit
    //       files」直接矛盾（指令与能力不符，与 worker 那次「你没有写工具 vs 工具表里有
    //       write」是同一类病）。
    //   D2 「a child ... cannot produce independent evidence」—— 对**重复同一个校验**成立，
    //       但对 `subagent_research` 不成立：它有独立上下文、自己读代码，**能**产生独立
    //       证据。原措辞会抵消「把广域调研委派出去」的引导（用户 2026-09-20 定的三阶段）。
    //
    // 修法：D1 改为**按能力表述**（能跑命令的读者才跑守卫；跑不了的读者读报告 + 点读 diff，
    // 验证归委派方），D2 收窄到「重复同一校验」并明确 research 的独立调查**是**有效证据。
    '- BUDGET YOUR OWN VERIFICATION. Self-checking means at most three things: (1) read your own diff, (2) run the repository guard ONCE in full **if you can run commands**, (3) at most 3 targeted checks on the riskiest points you touched. That is the entire budget. If your tools do not let you run the guard — a read-only shell, or no shell at all — you do not get to skip verification: check what you can read, and state plainly which checks you could not run and who owns them.',
    '- REPEATING A CHECK IS NOT VERIFICATION. Re-running the same check through another delegation, from the same context, reads the same code and produces no new evidence — that buys no confidence, so spend the budget on your own diff and a few targeted checks. This is about **re-running a check you already ran**, not about investigation: an independent `subagent_research` child reads the code itself in its own context and **is** valid evidence, which is exactly why broad investigation belongs with it.',
    '- REPORT SCOPE. State how many steps and how many tool calls the run took, so the cost and the progress of the work are legible to whoever reads the result.',
  ]
}

/**
 * fork（corum）：沙箱拒绝 → 一次升级 → 由用户裁决（机制段条目，单一事实源）。
 *
 * 这段文本同时注入主会话与子会话（preset scope 共享，子 Agent 经
 * `agentPresets.composeFrom` 继承父的 preset scope 段），所以弹窗承诺必须双分岔：
 * 主会话的审批策略是 `ask`（弹窗真实存在），子会话的审批策略钉死为 `never`
 * （`corum-subagent/src/child-agent.ts` 的 `captureDelegatedPolicyOverrides`，
 * `approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never'`），
 * 子会话拿不到可审批通路。措辞纪律同 {@link corumEfficiencyDisciplineLines}。
 * @returns 机制段的沙箱升级行（含前置空行）。
 */
export function corumSandboxEscalationLines(): string[] {
  return [
    '',
    'SANDBOX DENIALS AND ESCALATION:',
    '- A blocked file operation reports a `[sandbox: file access denied under <mode> mode]` marker. That is a policy decision, not a failure of the command: read the marker instead of assuming the denial.',
    '- When a wider mode would let the command succeed, retry the exact same command once, in the same turn, with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. In a session whose approval policy is `ask` that retry raises the approval prompt, and the user\'s answer to it is the consent — do not detour through chat to ask first.',
    '- In a DELEGATED CHILD session the retry IS adjudicated, and there are exactly three outcomes. It is granted outright when it stays within what the delegating agent itself holds. Otherwise the request is put in front of the user. And it is **refused without any prompt** when the command targets the CURRENT repository — its other branches, worktrees, refs or shared `.git` — because a delegated child may READ that repository but never write outside its own worktree; that refusal is not negotiable, and a session-wide "always allow" cannot lift it. So do retry with `sandbox_permissions` for anything OUTSIDE this repository (another repository, `/tmp`, a system path): that is the axis where permission can be granted. For the current repository do not retry at all — there is no card to wait for. Your scope also has a hard limit it can never widen — a read-only or isolated scope stays exactly as it was delegated. Either way a refusal is final for that command: report it as a conclusion in your final report so the caller sees it, instead of reworking around it or waiting for an approval that cannot come.',
    '- Escalate only from a real denial, never speculatively. If the session states that approval prompts are disabled, a denial is final: do not set `sandbox_permissions`.',
    '- A rejected escalation is final for that command: stop and explain it instead of working around it. It does not forbid attempting or escalating other commands later.',
  ]
}
