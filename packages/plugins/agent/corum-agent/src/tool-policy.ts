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
 * **代价必须写清楚**（这也是给模型的理由，不只是命令）：走 bash 的改动**仍被** `corum-review` 捕获
 * —— 它把 `bash`/`pwsh` 与文件工具并列处理（`SHELL_TOOL_NAMES`），从命令串解析确定的写目标
 * （`packages/desktop/src/host/corum-bash-writes.ts`：重定向、`tee`、`sed -i`、解释器 heredoc），
 * 并在轮末用 `git status --porcelain` 求并集兜底；`FILE_WRITE_TOOL_NAMES` 只认 edit/write/
 * str_replace_editor 是**归属**问题，不是「看不见」。
 *
 * ⚠️ 2026-09-27 更正（对抗审查员 B 报）：旧注释与旧正文说 bash 改动「在审查卡里完全不出现、也回滚
 * 不了」——与实现相反。真实边界是：命令串解析不出确定写目标、或 pre-image 超出内存上限被放弃时，
 * 才标记为「不可逐文件回滚」。
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
  'Why this matters here (not just style): the shell bypasses the file-observation policy, and its edits reach the change review as command-attributed changes rather than as first-class file-tool writes.',
  'Shell writes are still reviewed (their write targets are parsed out of the command, with the round-end working-tree state as a fallback), but a per-file revert is only available when that parse was definite and the pre-image was kept.',
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
