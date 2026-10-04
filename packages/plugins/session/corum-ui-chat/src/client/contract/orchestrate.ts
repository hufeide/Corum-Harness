/**
 * fork（corum）：orchestrate 编排卡的数据形与折叠逻辑。
 *
 * 数据源（全部来自父会话自身的事件窗口，无需新宿主通路）：
 * - `tool/call` name='orchestrate' 的 `arguments`：`tasks[]`（label / prompt /
 *   isolation（worktree / main / always / write-tasks / off）/ research /
 *   background）或 scripted 模式（`script` + `meta`）；`merge` 声明
 *   决定是否有「集成者」节点。
 * - `tool/result` 的正文：宿主 `render` 按固定格式拼串——
 *   `[task N · label] done\n<输出>` 或 `[task N · label] failed: <错误>`，
 *   结尾可选 `[corum integration] merged + committed into the main tree`
 *   或 `[corum integration] N branch(es) pending: …`。
 *   实测样本见 `packages/desktop/.corum-dev-home/sessions/**`（本文件按该格式解析，
 *   解析失败时优雅降级为「运行中/未知」，绝不影响卡片可用性）。
 *
 * ⚠️ 为什么不用 `presentCall/presentResult` 的结构化 meta：实测 `tool/result`
 * 的 `meta` 恒为 null（宿主 present* 只喂了通用卡），所以结构化状态只能由本
 * 折叠器从 arguments + 正文重建。
 */

/** 一个编排任务的静态声明（来自 `tasks[i]`）。 */
export interface OrchestrateTask {
  /** 数组下标（宿主结果里 `[task N]` 用的就是它）。 */
  readonly index: number
  /** 展示标签（`tasks[i].label`，缺省回退 `task N`）。 */
  readonly label: string
  /**
   * 隔离策略：worktree=隔离 worktree（机制缺省）；main=父树直跑；
   * always/write-tasks=旧档位（兼容历史会话）；off=旧「不隔离」（机制已废弃，
   * 仅历史会话出现）。
   */
  readonly isolation?: 'worktree' | 'main' | 'always' | 'write-tasks' | 'off'
  /**
   * 任务提示词全文（`tasks[i].prompt`，tool/call arguments 耐久携带，刷新后仍在；
   * 分支卡展开区的任务详情数据源，免去 RPC）。
   */
  readonly prompt?: string
  /** 只读研究任务（无 worktree）。 */
  readonly research?: boolean
  /** 后台运行（continuable，可 send_message 续接）。 */
  readonly background?: boolean
  /**
   * 任务级**机制锁定**的模型（`tasks[i].model`）；缺省时子 Agent 跟随实例/全局
   * 默认，卡片改为读子会话的 modelSelection 投影（见 OrchestrateCard 的模型行）。
   */
  readonly model?: string
}

/** 一个任务的终态（来自工具结果正文）。
 *  `aborted` = 主 Agent 手动终止该分支（宿主渲染串 `aborted:<label>`）。 */
export type OrchestrateTaskOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'failed'; readonly error: string }

/** 集成（fan-in）阶段状态。 */
export type OrchestrateIntegration =
  /** 声明了 `merge` → 机制在所有任务 settle 后跑集成者（merge + verify + commit）。 */
  | {
      readonly kind: 'integrated'
      /**
       * 集成者子会话 id（宿主写进结果正文 `· child <id>`，durable）。
       * 编排卡的「进入会话」按钮用它——运行期另有 `corum/subagent/child` 帧
       * （label `integrate`），但推送帧不重放，刷新后只有这里能给出入口。
       */
      readonly childSessionId?: string
    }
  /** 集成者未跑（有任务失败而中止；或本次调用未声明 `merge`——那要主 Agent 自己 `subagent { integrate: true }`）。 */
  | { readonly kind: 'pending'; readonly reason: string; readonly branches: readonly string[] }

/** 编排调用的整体模式。 */
export type OrchestrateMode = 'tasks' | 'script'

/** 一张编排卡的完整折叠结果。 */
export interface OrchestrateChatData {
  /** 声明式任务清单（scripted 模式为空数组）。 */
  readonly tasks: readonly OrchestrateTask[]
  readonly mode: OrchestrateMode
  /** scripted 模式的工作流名（`meta.name`）。 */
  readonly scriptName?: string
  /** 是否声明了 `merge`（决定要不要画「集成者」节点）。 */
  readonly hasMerge: boolean
  /** 父侧 `tool/call` id（子会话广播按它 + label 关联）。 */
  readonly callId: string
  /** 锚定卡片位置的父事件 seq。 */
  readonly anchorSeq: number
  /** 父侧调用时间。 */
  readonly time: number
  /** 任务终态（下标 → 结果）；工具未返回时为空 Map（= 全部运行中）。 */
  readonly outcomes: ReadonlyMap<number, OrchestrateTaskOutcome>
  /** 工具是否已返回（false = 进行中）。 */
  readonly settled: boolean
  /** 工具本身是否报错（isError，例如 orchestrate 整体抛错）。 */
  readonly errored: boolean
  /** 集成阶段状态（无 merge 声明时为 undefined）。 */
  readonly integration?: OrchestrateIntegration
  /**
   * 逐任务的子会话 id（下标 → childSessionId，undefined = 未关联）。
   *
   * 运行期由宿主 spawn 广播（'corum/subagent/child'）精确给出；历史回放
   * （页面刷新后无广播帧）退化为 session/list 的 origin='subagent' 时间就近匹配
   * ——与 `conversation-nodes/subagent.ts` 的 correlateChild 同口径。
   */
  readonly childSessionIds?: readonly (string | undefined)[]
  /**
   * 逐任务的隔离 worktree slug（下标 → slug）。
   * 实时台账（'corum/worktree-ledger' 推送帧）优先，本字段是刷新后的耐久兜底。
   */
  readonly worktreeSlugs?: ReadonlyMap<number, string>
}

/** `[task N · label] done|failed: msg | aborted: msg` 行（label 可缺省）。
 *  `aborted` = 主 Agent 手动终止该分支（与 `failed:` 前缀并列，同样解析风格）。 */
const TASK_LINE = /^\[task (\d+)(?: · ([^\]]*))?\] (done|aborted|failed)(?::\s*(.*))?$/u

/** 全结构化结果的形状（2026-09-16 render 改 JSON 后：`results[]` 的各项）。 */
interface StructuredOutcomeItem {
  index?: unknown
  ok?: unknown
  aborted?: unknown
  error?: unknown
}

/**
 * 解析工具结果正文里的任务终态。
 *
 * **双格式兼容（2026-09-16 render 改全结构化 JSON）**：
 * - 优先按**结构化 JSON**解析（新 render：`{mode, results:[{index,ok,aborted,error}], integration}`）；
 * - 回落**正则文本行**（旧 render / 历史会话的 `[task N · label] done|failed` 投影）。
 * 旧会话的 `failed:` 结果仍可解析。
 * @param text - `tool/result` 的正文（宿主 render 的输出）。
 * @returns 下标 → 终态。
 */
export function parseOutcomes(text: string): ReadonlyMap<number, OrchestrateTaskOutcome> {
  const out = new Map<number, OrchestrateTaskOutcome>()
  // ① 结构化 JSON（新 render 全结构化格式）。
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { results?: unknown }).results)) {
      for (const item of (parsed as { results: StructuredOutcomeItem[] }).results) {
        const index = typeof item.index === 'number' ? item.index : NaN
        if (!Number.isSafeInteger(index)) continue
        if (item.aborted === true) {
          out.set(index, { kind: 'aborted' })
        } else if (item.ok === true) {
          out.set(index, { kind: 'done' })
        } else {
          out.set(index, { kind: 'failed', error: typeof item.error === 'string' ? item.error : '' })
        }
      }
      if (out.size > 0) return out
    }
  } catch {
    // 非 JSON（旧文本投影格式）→ 回落正则解析。
  }
  // ② 正则文本行（旧 render 投影 / 历史会话）。
  for (const rawLine of text.split('\n')) {
    const matched = TASK_LINE.exec(rawLine.trim())
    if (matched === null) continue
    const index = Number(matched[1])
    if (!Number.isSafeInteger(index)) continue
    const kind = matched[3]
    if (kind === 'done') {
      out.set(index, { kind: 'done' })
    } else if (kind === 'aborted') {
      out.set(index, { kind: 'aborted' })
    } else {
      out.set(index, { kind: 'failed', error: matched[4]?.trim() ?? '' })
    }
  }
  return out
}

/**
 * 从工具结果正文里**按任务段**提取隔离 worktree 的 slug（`wt-xxxxxx`）。
 *
 * 为什么需要：`corum/worktree-ledger` 只在**运行期**广播（推送帧），页面刷新后
 * 不重放 → 历史会话的分支副行拿不到 worktree 名。任务输出里常回显路径
 * （`…/.corum-worktrees/wt-49f983/…`，实测宿主子 Agent 汇报会带），故作为
 * **耐久兜底**：实时台账优先，取不到时用这里的值。
 *
 * ⚠️ 必须**按 `[task N]` 分段**再取 slug，不能全篇收集后按下标对齐：只有隔离任务
 * 的输出才带路径（实测 3 任务里只有 task 2 是 always 隔离），全篇收集会把
 * task 2 的 slug 错配到 task 0（本轮实测踩到）。
 * @param text - `tool/result` 正文。
 * @returns 下标 → 该任务段内出现过的 slug（无则不含该键）。
 */
export function parseWorktreeSlugs(text: string): ReadonlyMap<number, string> {
  const out = new Map<number, string>()
  // ① 结构化 JSON（新 render）：从 results[].output 里按任务取下标取 slug。
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { results?: unknown }).results)) {
      for (const item of (parsed as { results: Array<{ index?: unknown; output?: unknown }> }).results) {
        const taskIndex = typeof item.index === 'number' ? item.index : NaN
        if (!Number.isSafeInteger(taskIndex) || typeof item.output !== 'string') continue
        const matched = /\.corum-worktrees\/(wt-[0-9a-z]+)/u.exec(item.output)
        if (matched !== null) out.set(taskIndex, matched[1])
      }
      if (out.size > 0) return out
    }
  } catch {
    // 非 JSON → 回落文本分段。
  }
  // ② 文本分段（旧 render 投影 / 历史会话）：按 `[task N …]` 分段。
  const parts = text.split(/\[task (\d+)(?: · [^\]]*)?\]/u)
  for (let index = 1; index + 1 < parts.length; index += 2) {
    const taskIndex = Number(parts[index])
    if (!Number.isSafeInteger(taskIndex)) continue
    const matched = /\.corum-worktrees\/(wt-[0-9a-z]+)/u.exec(parts[index + 1])
    if (matched !== null) out.set(taskIndex, matched[1])
  }
  return out
}

/** `[corum integration] …` 行。 */
const INTEGRATION_LINE = /^\[corum integration\] (.+)$/u

/**
 * 解析集成阶段状态。
 *
 * **双格式兼容（2026-09-16 render 改全结构化 JSON）**：优先读 JSON 的
 * `integration` 对象（`{integrated, childSessionId?, error?, pendingBranches}`），
 * 回落 `[corum integration] …` 文本行（旧投影 / 历史会话）。
 * @param text - `tool/result` 的正文。
 * @returns 集成状态，无该行时 undefined。
 */
export function parseIntegration(text: string): OrchestrateIntegration | undefined {
  // ① 结构化 JSON（新 render 全结构化格式）。
  try {
    const parsed: unknown = JSON.parse(text)
    const integration = (parsed as { integration?: { integrated?: unknown; childSessionId?: unknown; error?: unknown; pendingBranches?: unknown } } | null)?.integration
    if (integration !== undefined && integration !== null && typeof integration === 'object') {
      // error 在场 = 集成失败（Bug B：runIntegrate 不再 throw，错误并入 integration.error）。
      if (typeof integration.error === 'string' && integration.error !== '') {
        const branches = Array.isArray(integration.pendingBranches) ? integration.pendingBranches.filter((b): b is string => typeof b === 'string') : []
        return { kind: 'pending', reason: integration.error, branches }
      }
      if (integration.integrated === true) {
        const child = typeof integration.childSessionId === 'string' ? integration.childSessionId : undefined
        return child === undefined ? { kind: 'integrated' } : { kind: 'integrated', childSessionId: child }
      }
      const branches = Array.isArray(integration.pendingBranches) ? integration.pendingBranches.filter((b): b is string => typeof b === 'string') : []
      return { kind: 'pending', reason: branches.length > 0 ? `${branches.length} 个分支待集成` : '待集成', branches }
    }
  } catch {
    // 非 JSON → 回落文本行解析。
  }
  // ② 文本行（旧 render 投影 / 历史会话）。
  for (const rawLine of text.split('\n')) {
    const matched = INTEGRATION_LINE.exec(rawLine.trim())
    if (matched === null) continue
    const body = matched[1]
    if (body.startsWith('merged + committed')) {
      // `… into the main tree · child <sessionId>`（宿主 2026-09-12 起带上）。
      const child = /·\s*child\s+(\S+)/u.exec(body)
      return child === null ? { kind: 'integrated' } : { kind: 'integrated', childSessionId: child[1] }
    }
    // `N branch(es) pending: a, b, c — call ...`
    const pending = /^(\d+) branch\(es\) pending: ([^—]*)/u.exec(body)
    const branches = pending === null
      ? []
      : pending[2].split(',').map(part => part.trim()).filter(part => part !== '')
    return { kind: 'pending', reason: branches.length > 0 ? `${branches.length} 个分支待集成` : '待集成', branches }
  }
  return undefined
}

/** Read a string field off an untrusted value. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a boolean field off an untrusted value. */
function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * 从 `tool/call` 的 `arguments`（JSON 字符串或已解析对象）折叠静态任务清单。
 * @param args - `tool/call` 的 `arguments` 原值。
 * @returns 任务清单与模式信息；解析不出来时任务清单为空。
 */
export function parseCallArguments(args: unknown): {
  tasks: readonly OrchestrateTask[]
  mode: OrchestrateMode
  scriptName?: string
  hasMerge: boolean
} {
  let parsed: unknown = args
  if (typeof args === 'string') {
    try { parsed = JSON.parse(args) } catch { return { tasks: [], mode: 'tasks', hasMerge: false } }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { tasks: [], mode: 'tasks', hasMerge: false }
  }
  const record = parsed as Record<string, unknown>
  const merge = typeof record['merge'] === 'object' && record['merge'] !== null
    ? record['merge'] as Record<string, unknown>
    : undefined
  const meta = typeof record['meta'] === 'object' && record['meta'] !== null
    ? record['meta'] as Record<string, unknown>
    : undefined
  const rawTasks = Array.isArray(record['tasks']) ? record['tasks'] : []
  const tasks: OrchestrateTask[] = []
  rawTasks.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return
    const task = entry as Record<string, unknown>
    const isolation = str(task['isolation'])
    const model = typeof task['model'] === 'object' && task['model'] !== null
      ? task['model'] as Record<string, unknown>
      : undefined
    const modelLabel = model === undefined
      ? undefined
      : [str(model['model']), str(model['reasoningEffort'])].filter(part => part !== undefined).join(' · ')
    tasks.push({
      index,
      label: str(task['label']) ?? `task ${index}`,
      ...isolation === 'worktree' || isolation === 'main' || isolation === 'always' || isolation === 'write-tasks' || isolation === 'off' ? { isolation } : {},
      ...str(task['prompt']) === undefined ? {} : { prompt: str(task['prompt']) },
      ...bool(task['research']) === true ? { research: true } : {},
      ...bool(task['background']) === true ? { background: true } : {},
      ...modelLabel === undefined || modelLabel === '' ? {} : { model: modelLabel },
    })
  })
  const scripted = str(record['script']) !== undefined
  return {
    tasks,
    mode: scripted ? 'script' : 'tasks',
    ...(scripted ? { scriptName: str(meta?.['name']) ?? '(unnamed)' } : {}),
    hasMerge: merge !== undefined,
  }
}

/** 一张卡片的 head 摘要：标题 + 副标题 + 计数。 */
export interface OrchestrateSummary {
  readonly title: string
  readonly subtitle: string
  readonly done: number
  readonly aborted: number
  readonly failed: number
  readonly total: number
}

/**
 * 折叠 head 摘要（设计稿 `编排工作流 · 3 任务并行` / `fan-out 并发 → fan-in 汇合`
 * + 状态 chip `并行执行中 · 0/3` / `3/3 完成` / `1/3 · 1 失败`）。
 * @param data - 折叠结果。
 * @returns 摘要文案与计数。
 */
export function summarize(data: OrchestrateChatData): OrchestrateSummary {
  const total = data.tasks.length
  const done = [...data.outcomes.values()].filter(o => o.kind === 'done').length
  const aborted = [...data.outcomes.values()].filter(o => o.kind === 'aborted').length
  const failed = [...data.outcomes.values()].filter(o => o.kind === 'failed').length
  if (data.mode === 'script') {
    return {
      title: `编排工作流 · ${data.scriptName ?? '(unnamed)'}`,
      subtitle: '脚本编排 · 逐阶段推进',
      done, aborted, failed, total,
    }
  }
  return {
    title: `编排工作流 · ${total} 任务并行`,
    // 2026-09-12：`autoIntegrate` 字段已随 BUG-29 移除（声明 `merge` 即由机制收尾），
    // 所以副标题按「有没有声明 merge」区分：声明了就会自动集成，没声明则分支留给调用方。
    subtitle: data.hasMerge
      ? 'fan-out 并发 → fan-in 汇合 → 自动集成'
      : 'fan-out 并发 → fan-in 汇合 → 分支留待手动集成',
    done, aborted, failed, total,
  }
}
