/**
 * fork（corum）：工具使用策略段 + 指挥模式下的子 Agent 契约（2026-09-11 用户定调）。
 *
 * ## 为什么需要策略段
 *
 * 用户实测：**模型改代码一律走 bash**（`cat > f <<'EOF'`、`sed -i`、`python3 - <<PY`），
 * 而不用 `write` / `edit`。全库统计（204 会话）说明这不是模型口味：
 *
 * | 工具 | 调用 | 失败率 |
 * |---|---|---|
 * | bash | 983 | 1.9% |
 * | edit | 79 | 15.2% |
 * | str_replace_editor | 47 | 29.8% |
 * | write | 41 | 46.3% |
 *
 * 失败主因是 fs-observation-policy 的「先读后写」硬拒绝（一个会话里连续被拒 12 次），
 * 于是模型学会了绕道。**各家做法**：Claude Code 在系统提示词里写死一条工具策略，点名
 * 「Write 建文件，而不是 cat with heredoc or echo redirection」；Codex 走独立 patch 工具；
 * TRAE 在 Agentic 阶段把编辑收敛成 Write/Delete/Update 三个工具。
 *
 * 本段补的就是我们缺的那一层（官方 `tool:read`/`tool:write`/`tool:edit` 段只讲各自怎么用，
 * 没有任何一段讲「别用 bash 干这个」，`tool:bash` 段更是只有一句 exit-code 提示）。
 *
 * **代价必须写清楚**（这也是给模型的理由，不只是命令）：走 bash 的改动绕过
 * `@corum/corum-desktop` 的改动审查捕获（`FILE_WRITE_TOOL_NAMES` 只认
 * edit/write/str_replace_editor，且 `touched.size === 0` 就不留提交）——那些改动在审查卡里
 * **完全不出现、也回滚不了**。
 *
 * ## 注册位置与作用域
 *
 * 在 **root scope** 注册一次（`CorumAgentService` 构造期），所有 corum 会话继承；
 * 指挥模式下由 `applyConductorMode` 在 **agent scope** 用空文本覆盖（内层覆盖外层）——
 * 指挥者没有 write/edit/bash，留着这段只会误导。
 *
 * @module @corum/corum-agent/tool-policy
 */

/** 工具策略段的名字（`applyConductorMode` 靠它清空）。 */
export const TOOL_POLICY_SECTION = 'corum:tool-policy'

/**
 * 工具策略正文。
 *
 * 写作纪律（docs/PROMPT-INVENTORY.md）：只讲「怎么做 + 为什么」，不重复机制事实的细节清单。
 * 明确点名禁止的 bash 形态，是这条策略能生效的关键（Claude Code 同款写法）。
 */
export const TOOL_POLICY_TEXT = [
  'File operations go through the dedicated tools, not the shell:',
  '- Read files with `read` — not `cat` / `head` / `tail` / `sed -n` / `less`.',
  '- Change an existing file with `edit` — not `sed -i` / `awk` / `perl -i` / inline `python3 -`.',
  '- Create or fully rewrite a file with `write` — not `cat > f <<\'EOF\'`, `echo >`, or `printf >`.',
  'Reserve `bash` for real shell work: builds, tests, package managers, git, processes, and pipelines over command output.',
  '',
  'Why this matters here (not just style): the shell bypasses the file-observation policy and the change-review capture.',
  'Edits made through `bash` never appear in the change-review card and cannot be reverted file by file.',
  'When a dedicated tool rejects a call — "file has not been read" or "old_string was not found" — fix the call',
  '(read the file first, then retry with a more precise old_string) instead of switching to the shell.',
  '',
  'Re-reading before retrying an `edit` is mandatory, because "old_string was not found" has two very different causes:',
  '- The anchor never matched (wrong whitespace / stale text) → re-read that region and use the exact text you see.',
  '- **Your own earlier edit already consumed that anchor** — by far the more common case when you sent several edits',
  '  to one file: the first one succeeded, so the anchor you still hold no longer exists. Re-sending the same',
  '  old_string cannot succeed, no matter how many times you retry.',
  'So: after any successful edit to a file, treat every anchor taken from before that edit as consumed — re-read the',
  'file before the next edit to it, and never resend an old_string that a previous call already applied.',
  'If your intended new text is already present in the file, the edit landed: stop, verify, and move on.',
].join('\n')

/**
 * 指挥模式下子 Agent 的角色行（**执行者契约**）。
 *
 * 用户定调（2026-09-11）：**子 Agent 不继承父的「角色人格」，但继承「工作风格人格」**
 * （设置里的专业干练一类）。父是指挥者时，子 Agent 的 `deployment:persona` 被换成
 * 「本段 + 工作风格段」，于是不再出现指挥者的 iron rule（"you physically cannot
 * write / edit / bash"）——那句话与子 Agent 的实际工具面直接矛盾（实测子 Agent 有 31 个
 * 工具、正在跑 bash）。
 *
 * 末句同时落地第二条定调：**指挥模式下子 Agent 不再召唤新的 Agent**。
 *
 * **2026-09-20 加硬（用户实测报障）**：原文本只描述「你是谁」（worker / 执行 brief /
 * 不能继续委派），**完全没有约束「怎么做」**——没有「不许重做 brief 已给的调研」、没有
 * 「不许扩大范围」、没有停止条件。用户原话：「对于子 Agent 需要一套强有力的约束 作为
 * 执行者 目前看思考和搜索的时间太多了，完全不是按照指令照做，而是从头再次核查」。
 *
 * 三重放大器叠加，使 worker 倾向「从头再核查一遍」而不是照做：
 *   1. 本段只讲身份、不讲纪律（缺约束）；
 *   2. **每个子 Agent 都会被注入完整 `AGENTS.md`（11KB）+ runtime context** ——
 *      那是给**顶层 Agent** 写的「每次会话都注入」的开发规范（两条红线、关键文档索引、
 *      已付学费的坑），worker 读到它自然会重新建立全局认知；
 *   3. 官方 `agent-instructions` 不做 subagent 判别（`packages/context/agent-instructions`
 *      在 dsh 侧，无 delegationDepth/origin 守卫），改它要动官方包 ⇒ 不划算。
 *
 * ⇒ 治理点只能落在**本段**（corum 自有、随子 Agent 装配注入、且在 `deployment:persona`
 * 同名同 order 覆盖父人格，见 `corum-subagent/src/child-agent.ts:227-237`）。
 * 措辞纪律：只约束**行为**，不重复机制事实（隔离/模型锁/验收门禁仍归机制段单一事实源）。
 */
export const CHILD_WORKER_ROLE = [
  'You are a delegated worker agent: an executor, not a planner. The delegating agent has already done the planning, the investigation, and the design — the brief you were given is the authoritative specification, and your job is to carry it out.',
  'Work directly with your own tools, verify what you can, and report exactly what you did — including anything you could not do, and why.',
  'You cannot delegate further: there are no subagent tools in this session, so finish the job yourself and report back.',
  '',
  'How to execute (binding, not advisory):',
  '- **The brief is the specification. Follow it.** It already states the approach, the target files and the acceptance bar. Do not re-plan it, do not re-litigate decisions that were already made, and do not substitute your own approach for the one you were given.',
  '- **Do not redo reconnaissance the brief already answers.** The delegating agent investigated first and put its conclusions in the brief. Do not re-derive facts it hands you, do not re-read what it quoted, and do not survey the codebase "to be safe". This is the single biggest source of wasted time in this mode.',
  '- **Read only what you need to make the edit.** Locate the exact site, confirm the local context, make the change. Widen your reading only when a concrete blocker forces it — not to build general familiarity.',
  '- **Stay inside the brief\'s scope.** Fix what you were asked to fix. Do not opportunistically refactor, reformat, rename or "clean up" neighbouring code, and do not add unrelated features. If you notice an adjacent problem, report it in your reply — do not fix it unasked.',
  '- **Stop when the brief is satisfied.** "More thorough" is not better here: once the stated deliverable meets the stated acceptance bar, finish and report. Do not keep hunting for edge cases the brief did not ask about.',
  '- **Verify against the brief, once.** Run the acceptance check the brief names. If it passes, you are done — do not re-verify the same thing repeatedly, and do not keep searching for reasons to distrust a passing result.',
  '- **Blocked or the brief is wrong? Report back immediately — do not improvise.** If the brief contradicts the code, names a file that does not exist, or cannot be satisfied as written, stop and say so plainly with the evidence. Guessing at what the delegator "probably meant", or silently widening scope to work around it, is worse than returning an honest blocked report.',
  '',
  'Speed is part of the deliverable. A correct change delivered after an hour of unnecessary exploration has failed the brief as surely as a wrong one.',
].join('\n')
