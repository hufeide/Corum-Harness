/**
 * fork（corum）子 Agent 模型策略的机器化对账（2026-09-18 用户定调）。
 *
 * ## 用户策略（四条，逐条落成断言）
 *
 * 1. **子 Agent 使用模型必须唯一，不给 LLM 候选列表**——成本考量；菜单表达要一致，
 *    用户设了子 Agent 路由到哪个模型就跑哪个模型。
 * 2. **子 Agent 默认路由跟随主 Agent**；若子 Agent **模型调用出错**，则退回主 Agent
 *    路由确保任务完成，并**通知用户该情况的处理方式**。
 * 3. **搜索（research）与工作（worker）两种 Agent 都必须遵守**上述策略。
 * 4. **orchestrate 也不能豁免**——严格遵守同一条策略。
 *
 * ## 为什么用「源码扫描式」对账
 *
 * 本仓先例：`prompt-discipline.spec.ts`（决策点分工）、`corum-agent/tests/builtin-roles.spec.ts`
 * （`indexOf` 切片钉规则顺序）。理由是这些约束住在**模型读到的文本面**与**工具 schema 面**里，
 * 一旦被悄悄改回去（例如有人「顺手」把 `tasks[i].model` 加回来），只有实机重启并读工具描述
 * 才看得出来。本 spec 把四条策略变成断言，回潮即红。
 *
 * 覆盖边界：本 spec 只做**文本/schema 面**断言，不改任何机制语义；运行期行为由实机取证。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
const COMPILE_SRC = readFileSync(
  join(import.meta.dirname, '../../corum-agent/src/compile.ts'),
  'utf8',
)
const LIST_MODELS_SRC = readFileSync(join(import.meta.dirname, '../src/list-models.ts'), 'utf8')

/** 取一段源码：从 `from` 到其后第一个 `to`（不含）。顺序即语义锚点。 */
function between(from: string, to: string, source: string = SRC): string {
  const start = source.indexOf(from)
  expect(start, `anchor not found: ${from}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(to, start + from.length)
  expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

/**
 * 剥掉注释后的源码——用于「这段代码还在不在」类断言。
 *
 * 为什么需要：本文件给被移除的机制留了说明性注释（例如「`taskModel` 已按用户策略
 * 移除」），裸子串判会把**注释**也算成通路，于是断言在「代码已删干净」时反而变红。
 * 第一次写 §策略①② 的第三条断言时正是这么红的——留下这条纪律：判「代码有没有」
 * 先剥注释，判「文案有没有」才用原文。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('策略①② 模型唯一：LLM 无法表达子 Agent 模型偏好', () => {
  it('subagent 工具 schema 不含模型参数（官方条件展开块恒不展开）', () => {
    // 官方 modelSelectionEnabled 门禁恒 false ⇒ provider/model/reasoning_effort 不展开。
    // 断言锚点：模型锁注释仍在，且 parameters 段里没有这三个字段名。
    const params = between('parameters: {', 'integrate: {')
    expect(params).not.toMatch(/\bprovider\s*:/)
    expect(params).not.toMatch(/\breasoning_effort\s*:/)
  })

  it('★ orchestrate 的 tasks[].model 已从 LLM 可见 schema 剔除（策略④）', () => {
    // 2026-09-18：此前 `tasks[i].model` 是 LLM 可见参数（描述还写着 "mechanism lock"），
    // 主 Agent 可据此把子 Agent 换到任意模型——正是策略禁止的「让 LLM 决定子 Agent 模型」。
    expect(SRC).not.toContain('Fixed model for this task')
    // 反向：tasks 段的 properties 里不得再出现 model 键。
    const tasksBlock = between('tasks: {', 'merge: {')
    expect(tasksBlock, 'orchestrate tasks 段又出现了 model 参数').not.toMatch(/\n\s{20,}model:\s*\{/)
  })

  it('★ 工具描述也不再宣告 model（schema 删了、描述还写着 = 教模型用不存在的参数）', () => {
    // 实测踩到：schema 剔了 model，但 DECLARATIVE 那行描述仍列着 `model`，
    // 模型会照着描述去传 ⇒ 未知参数。描述与 schema 必须同口径。
    expect(SRC).not.toContain('`label`, `isolation`, `research`, `model`')
  })

  it('★ per-task 模型的接线（taskModel）已彻底移除，不留半条通路', () => {
    // schema 删了但接线还在 = 仍可被内部调用方注入。判据必须**只看代码不看注释**
    // （本文件留了「已移除」的说明性注释，若按裸子串判会与注释一起变红——第一次
    // 写这条断言时就踩了，故这里剥掉注释再判）。
    const code = stripComments(SRC)
    expect(code).not.toMatch(/taskModel/)
    expect(code).not.toMatch(/task\.model/)
  })

  it('模型路由**始终两档**：预设配的模型 > 跟随主 Agent（运行期无全局兜底档）', () => {
    // 用户 2026-09-18 澄清：「跟随主 Agent 就是主 Agent 当前预设哪个，子 Agent 也预设哪个。
    // 全局页面的配置只是说你创建一个新预设的时候默认使用这套配置……**始终是两档**」。
    // ⇒ 运行期**不得**读 `corum-subagent` 的 defaultModel/defaultResearchModel。
    // 2026-09-18：解析式多了一层**会话级临时覆盖**（机制问过用户之后写的内存值），
    // 但它不是"配置档"——用户从未配置它、不落盘、新会话自然消失。
    expect(SRC).toContain('const corumEffectiveModel = corumSessionOverride ?? config.model')
    // 2026-09-19：覆盖读取升级为**按角色**取（corumOrchestration 双键：sessionId+角色）——
    // corum preset 的 tool-subagent 双实例各有独立锁面，取错角色会覆盖另一实例的锁面。
    expect(SRC).toContain('orchestration.modelOverrideOf(String(parent.session.id), corumChildRole === \'research\' ? \'research\' : \'worker\')')
    expect(SRC, '运行期又读了全局兜底档（它应只是「新建预设的模板」）')
      .not.toMatch(/corumGlobal\(\)\.default(Research)?Model/)
  })

  it('候选列表工具（list_subagent_models）存在，但只在 modelSelectionSettings 开启时注册', () => {
    // 策略①：不给 LLM 候选列表。corum 的 preset 编译恒关该开关 ⇒ 该工具不上工具面。
    expect(LIST_MODELS_SRC).toContain("name: 'list_subagent_models'")
    expect(SRC).toContain('if (modelSelectionPolicy !== undefined) registerListSubagentModels(runtimeCtx, modelSelectionPolicy)')
  })

  it('★ corum preset 编译恒关 modelSelectionSettings（候选列表工具因此不可达）', () => {
    expect(COMPILE_SRC).toContain('modelSelectionSettings: false')
  })
})

describe('策略② 失败处置：模型调用出错 ⇒ **先问用户**，按用户两规则处置（2026-09-18 改版）', () => {
  it('★ 只对「用的是用户配置的模型」的失败启动本机制（跟随父时无「配置模型不可用」可言）', () => {
    const route = between('const configuredRoute =', 'const modelFailureOf =')
    // 必须同时要求 corumEffectiveModel 存在、且父路由可解析。
    expect(route).toContain('corumEffectiveModel !== undefined')
    expect(route).toContain('parentOptions.provider !== undefined')
    expect(route).toContain('parentOptions.model !== undefined')
  })

  it('★ 判定用官方契约 stopReason === "error"（不是错误串匹配）', () => {
    const fn = between('const modelFailureOf =', 'const startRun =')
    expect(fn).toContain("stopReason === 'error'")
  })

  it('★★ 不再自动重试：重跑必须先经过提问（用户 2026-09-18「不许替用户做主」）', () => {
    // 旧版是「attempt===1 无条件清 agentOptions 重跑」——那正是用户本轮否掉的形态。
    // 新形态：清 agentOptions 只出现在**问了用户并拿到 route 之后**。
    const askIdx = SRC.indexOf('const asked = await corumAskAboutModel(')
    expect(askIdx, '找不到提问调用').toBeGreaterThan(-1)
    // 每一处 delete request.agentOptions 都必须排在某个 corumAskAboutModel 调用之后。
    let from = 0
    for (;;) {
      const at = SRC.indexOf('delete request.agentOptions', from)
      if (at === -1) break
      const before = SRC.lastIndexOf('corumAskAboutModel(', at)
      expect(before, 'delete request.agentOptions 出现在提问之前 ⇒ 退化成自动重试').toBeGreaterThan(-1)
      from = at + 1
    }
  })

  it('★ 首轮先对「配置的路由」做真路由预检（spawn 期解析失败也算模型不可用）', () => {
    // 锁定路径不走 `if (corumLockedOptions === undefined)` 里的预检 ⇒ 配错的模型若只靠
    // settle 兜，会在 spawn 期直接抛出去、用户看到「任务失败」而非「模型不可用」。
    const block = between('if (attempt === 0) {', 'const run = await startRun()')
    expect(block).toContain('preflightChildLlmRoute')
    expect(block).toContain('configuredFailure =')
    expect(block).toContain('break')
  })

  it('★ 用户没同意（route undefined）⇒ 不重跑，如实把失败交回主 Agent（规则 2 下半句）', () => {
    const block = between('const asked = await corumAskAboutModel(', 'delete request.agentOptions')
    expect(block).toContain('asked.route === undefined')
    expect(block).toContain('throw')
  })

  it('★★ 选「不重试」⇒ **不锁死会话委派**（2026-09-19 用户实测纠正）', () => {
    // 前一版在这一档注册 tools.guard 硬禁用整个会话，用户实测发现主 Agent 因此连
    // 「换模型重派」「用 subagent_research 调研」都做不到，还在通知里读到
    // 「delegation is DISABLED for this session」，索性把本该委派的活也自己干了。
    // 正确语义：只表示「本次失败不自动重试」，会话委派能力不变。
    expect(SRC).not.toContain('runtimeCtx.tools.guard(')
    expect(SRC).not.toContain('orchestration.disableDelegation')
    expect(SRC).not.toContain('delegationDisabledFor(')
    const askSrc = readFileSync(join(import.meta.dirname, '../src/model-ask.ts'), 'utf8')
    expect(askSrc).not.toContain('corumDelegationDisabledReason')
  })

  it('★ 该档的对外文案必须说清「只不重试、能力不变」（文案误导会让模型自己全干）', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    const branch = source.slice(source.indexOf("case 'decline':"), source.indexOf("case 'dismissed':"))
    // 不能再出现「DISABLED」「do all the work yourself」这类把会话能力说死的措辞。
    expect(branch).not.toMatch(/delegation is now DISABLED/i)
    expect(branch).not.toMatch(/Do all of the remaining work yourself/i)
    // 必须明确告知能力不变，并给出可继续委派的路径。
    expect(branch).toMatch(/UNCHANGED/i)
    expect(branch).toMatch(/may still delegate/i)
  })

  it('★ 临时档只写会话内存，**不落盘**（用户要求「临时生效，不覆盖用户的设置」）', () => {
    // 临时决定必须走 corumOrchestration 的会话级覆盖，而不是 settings/预设。
    expect(SRC).toContain('setModelOverride')
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    const tempCase = source.slice(source.indexOf("case 'temporary'"), source.indexOf("case 'permanent-follow'"))
    expect(tempCase).toContain('setModelOverride')
    // 临时档**不许**出现任何持久化调用。
    expect(tempCase).not.toContain('applySubagentModelForSession')
    expect(tempCase).not.toContain('saveProfile')
  })

  it('★ 永久档才写预设，且走 corum-agent 的写入面（机制写，非 LLM 调工具）', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    expect(source).toContain('applySubagentModelForSession')
    // 写失败必须如实报告原因，不许谎称已生效、也不许只说"没写成"。
    expect(source).toMatch(/could NOT save it — reason:/)
  })

  it('★ 四个档位（临时 / 永久跟随 / 永久改指定 / 停止委派）由机制词汇表下发', () => {
    // 档位清单是 host 的词汇表（client 只渲染），四个 kind 必须都在。
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask.ts'), 'utf8')
    for (const kind of ['temporary', 'permanent-follow', 'permanent-route', 'decline']) {
      expect(source, `档位 ${kind} 不在机制词汇表里`).toContain(`kind: '${kind}'`)
    }
    // 下发面：client 不硬编码档位，读 host 传下来的 options。
    const run = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    expect(run).toContain('corumModelAskOptions')
  })

  it('★★ 机制级提问走自己的 host 通路，**不借 userQuestions**（用户明确的架构要求）', () => {
    // 这不是风格偏好：userQuestions 的消费者是 LLM 的 ask_user_question 工具，
    // 两条询问共用一条 waterfall 会互相截获、delegate 语义纠缠。
    expect(SRC).not.toContain("ctx.get('userQuestions')")
    expect(SRC).toContain('corumModelAskChannel')
    expect(SRC).toContain("'corum/model-ask/request'")
    const run = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    // 剥注释后判：头注释正当地记着「为什么不借 userQuestions」，裸子串判会把
    // 那段说明也算成回潮（本仓已有这个学费，见 stripComments 的说明）。
    expect(stripComments(run)).not.toContain('userQuestions')
    expect(run).toContain('CorumModelAskChannel')
    // 通路缺失时必须保守降级（不停用委派、不改配置），绝不替用户做主。
    expect(run).toMatch(/no corum\/model-ask channel/)
  })

  it('★★ 协议走 kind 而不是选项 label（label 会随 UI/本地化漂移，不能当协议键）', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask.ts'), 'utf8')
    const resolve = between('export function corumResolveModelAskDecision(', 'switch (kind)', source)
    // 判定入参是 kind，不是 label 数组。
    expect(resolve).toContain('kind: string | undefined')
    expect(resolve).not.toContain('selected')
  })

  it('★ 临时档的路由恒取机制解析出的主 Agent 路由，不采信 client 传来的 route', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask.ts'), 'utf8')
    const tempCase = source.slice(
      source.indexOf("case 'temporary':"),
      source.indexOf("case 'permanent-follow':"),
    )
    expect(tempCase).toContain('route: { ...fallback }')
  })

  it('★★ 永久档必须**同时**写会话级覆盖（2026-09-19 实机：只写预设 ⇒ 第二次委派照旧提问）', () => {
    // 根因：预设经 compilePreset 注入 corum-tool-subagent 的 `config.model`，那是
    // **插件实例创建时**的静态值。`persistProfileAndRecompile` 清的是 corum-agent 侧的
    // Agent 缓存并重编译产物，**早已在跑的插件实例不会重建** ⇒ 本进程内
    // `corumEffectiveModel = corumSessionOverride ?? config.model` 仍落回坏模型，
    // 失败后再次提问（用户实测的现象）。
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    for (const branch of ['permanent-follow', 'permanent-route']) {
      const start = source.indexOf(`case '${branch}':`)
      expect(start, `找不到 ${branch} 分支`).toBeGreaterThan(-1)
      const next = source.indexOf('case ', start + 1)
      const body = source.slice(start, next === -1 ? undefined : next)
      // 写预设之后必须回填会话级覆盖。
      expect(body, `${branch} 只写预设、没回填会话级覆盖 ⇒ 当前进程仍然拿坏模型`)
        .toContain('setModelOverride')
      // 且必须返回 route，否则上游 `asked.route === undefined` 会 throw（任务不续跑）。
      expect(body, `${branch} 没返回生效路由 ⇒ 上游 throw，任务不会继续`).toContain('override:')
    }
  })

  it('★ 永久档写失败时不得留下会话级覆盖（否则本次会话静默生效、用户以为改了配置）', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    const start = source.indexOf("case 'permanent-route':")
    const body = source.slice(start, source.indexOf('case ', start + 1))
    // 失败分支必须清覆盖；只有 result.ok 才写。
    expect(body).toMatch(/if \(result\.ok\) deps\.state\.setModelOverride/)
    expect(body).toMatch(/else deps\.state\.clearModelOverride/)
  })

  it('★ 永久档走 ctx.get(corumAgent)（2026-09-18 实机：ctx.root.get 取不到 ⇒ 永久档静默失败）', () => {
    expect(SRC).toContain("ctx.get('corumAgent')")
    // root.get 是那次实机的真因，钉住不许回潮。
    expect(SRC).not.toContain("ctx.root.get('corumAgent')")
  })

  it('★ 永久档失败要说出**真原因**（第一版把「服务取不到」误报成「没有可写的 profile」）', () => {
    const raw = readFileSync(join(import.meta.dirname, '../src/model-ask-run.ts'), 'utf8')
    // persist 必须返回原因而不是裸 boolean。
    expect(raw).toMatch(/ok: false; reason: string/)
    expect(raw).toMatch(/could NOT save it — reason:/)
    // 那句误导性文案不得回潮——**剥注释后**判（注释里正当地记着这次事故的原文，
    // 裸子串判会把说明性注释也算成回潮，本仓已有这个学费：见 stripComments 的说明）。
    expect(stripComments(raw)).not.toContain('no writable profile')
  })

  it('★ 续跑必须带路线覆盖（不带 = 用刚失败的坏模型再跑一遍，用户的「是」被浪费）', () => {
    // 为什么必需：失败的 continuable 子 Agent 已被 dispose ⇒ 这次投递走 coldResume，
    // 默认按持久化 descriptor 重建路由 = 刚失败的那个坏模型。
    const call = between('await (appCtx.subagents.sendMessage as unknown as CorumRouteAwareSendMessage)(', 'appCtx.logger.info')
    expect(call).toContain('agentOptions:')
    expect(call).toContain('asked.route.provider')
    expect(call).toContain('asked.route.model')
    // 红线 3：类型面用本地窄接口收窄（官方类型没有 agentOptions，直接调会 TS2353）。
    expect(SRC).toContain('interface CorumRouteAwareDelivery')
    expect(SRC).toContain('as unknown as CorumRouteAwareSendMessage')
  })

  it('★★ subagent/end 里「收口失败」与「待集成」必须各自独立判定（早退会吃掉待集成通知）', () => {
    // 2026-09-18 根因：原实现 `if (failures.length === 0) return` 排在待集成通知**之前**
    // ⇒ 只有「收口提交也失败」时才发得出「有分支待集成」，正常情况**永不发**
    // （作者本场会话两次隔离委派都没被提醒，手工 cherry-pick 收尾，worktrees 堆到 2.4GB）。
    const handler = between("ctx.on('subagent/end' as never", '}) as never, { global: true })')
    // ⚠️ 判「代码有没有」必须先剥注释：本文件的修复注释里**引用**了那行旧代码
    // （`if (failures.length === 0) return`），裸子串判会把说明性注释也算成回潮
    // ——本仓已有这个学费（见 stripComments 的说明）。
    const code = stripComments(handler)
    expect(code, '出现 `failures.length === 0) return` 早退 ⇒ 待集成通知会被吃掉')
      .not.toMatch(/if\s*\(\s*failures\.length\s*===\s*0\s*\)\s*return/)
    // 收口失败必须收窄进自己的分支（`> 0`），不得早退。
    expect(code).toMatch(/if\s*\(\s*failures\.length\s*>\s*0\s*\)/)
    // 两者都要在同一处理器里独立出现。
    expect(code).toContain('drainSettleCommitFailures')
    expect(code).toContain('corumPendingIntegration')
    // 待集成通知必须在 drain 之后（顺序语义：先收口、再报待集成）。
    expect(code.indexOf('corumPendingIntegration')).toBeGreaterThan(code.indexOf('drainSettleCommitFailures'))
  })

  it('★★ 待集成通知必须认领式去重（双实例各注册一个 end 监听 ⇒ 不去重就发两条）', () => {
    // 2026-09-18：corum preset 里 corum-tool-subagent 是**双实例**（worker + research），
    // 每个实例都注册 {global:true} 的 subagent/end 监听 ⇒ 同一 settle 被处理两次。
    // 两个「取走即删」的用量天然只生效一次，待集成通知是**纯读**，不去重就重复
    // （实机：同一会话 seq 24/25 逐字相同）。
    const handler = between("ctx.on('subagent/end' as never", '}) as never, { global: true })')
    const code = stripComments(handler)
    expect(code, '待集成通知没有认领去重 ⇒ 双实例会各发一条').toContain('claimPendingIntegrationNotice')
    const orch = readFileSync(
      join(import.meta.dirname, '../../corum-orchestration/src/orchestration.ts'),
      'utf8',
    )
    // 认领语义必须是「先到者 true，后来者 false」。
    const claim = between('claimPendingIntegrationNotice(', '\n  }', orch)
    expect(claim).toContain('has(key)')
    expect(claim).toContain('return false')
    expect(claim).toContain('add(key)')
  })

  it('★★ 前台隔离委派的结果必须带 isolationBoundary=worktree（否则模型不知道要 integrate）', () => {
    // 2026-09-18 根因：boundary 此前**只在没隔离时**填（注释写「worktree 是常规路径、无需
    // 提醒」）——而隔离成功恰恰是唯一需要模型行动的情形（改动在分支上，只有 integrate 能并进主树）。
    const block = between('const corumIsolationBoundary:', 'const corumSetMechanismFilter')
    expect(block).toContain("'worktree'")
    expect(block).toContain("'skipped-non-git'")
    // 且必须真的在隔离时取 worktree（不是恒 undefined）。
    expect(block).toMatch(/corumIsolate\s*\?\s*'worktree'/)
    // output.schema 必须同步（additionalProperties:false ⇒ 不同步会被 INVALID_TOOL_OUTPUT 吞掉）。
    const schema = between('isolationBoundary: { type: \'string\', enum:', '}')
    expect(schema).toContain('worktree')
  })

  it('★ worktree 档的提示必须点明 `subagent { integrate: true }` 且劝阻手工 cherry-pick', () => {
    const orch = readFileSync(
      join(import.meta.dirname, '../../corum-orchestration/src/orchestration.ts'),
      'utf8',
    )
    const fn = between('export function corumIsolationBoundaryNotice(', '\n}', orch)
    expect(fn).toContain('integrate: true')
    expect(fn).toMatch(/cherry-pick|Do not merge/i)
    expect(fn).toContain('ONLY on that branch')
  })

  it('★ 提示词不再宣告「机制会自动重试」（改版后这句话是假的）', () => {
    const prompt = between('Child model routing is NOT yours to choose', '\n')
    expect(prompt).not.toContain('automatically retries')
  })
})

describe('策略③④ 两种 Agent 一致 + 提示词诚实', () => {
  it('★ settings ns 必须 boot 常驻：registrar 入口存在且不再只靠按会话 apply 注册', () => {
    // 2026-09-18 bug：`corum-subagent` ns 原先只在按会话 apply 的工具实例里注册 ⇒
    // 冷启动（不建 corum 会话）时该 ns 不存在，设置页读到空值、新建预设的模板预填失效。
    // 修法是加 boot 常驻行（package.json 的 ./settings-registrar + cordis.patch.yml 的行）。
    // 这里钉住三处：入口文件存在、声明抽到共享模块、patch.yml 有该行。
    const registrar = readFileSync(join(import.meta.dirname, '../src/settings-registrar.ts'), 'utf8')
    expect(registrar).toContain('acquireCorumSubagentSettingsScope')
    const nsModule = readFileSync(join(import.meta.dirname, '../src/settings-namespace.ts'), 'utf8')
    expect(nsModule).toContain("'corum-subagent'")
    // 官方 register 对重复注册抛错 ⇒ 必须走容忍"已注册"的共享 helper。
    expect(nsModule).toContain('is already registered')
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as { exports: Record<string, unknown> }
    expect(Object.keys(pkg.exports)).toContain('./settings-registrar')
    const patch = readFileSync(
      join(import.meta.dirname, '../../../../desktop/cordis.patch.yml'),
      'utf8',
    )
    expect(patch, 'corum-subagent settings 的 boot 注册行被删了（冷启动该 ns 将不存在）')
      .toContain("name: '@corum/corum-tool-subagent/settings-registrar'")
  })

  it('★ worker 与 research 由同一 config 工厂生成（策略③：同一套策略）', () => {
    expect(COMPILE_SRC).toContain("corumSubagentConfig('worker', profile, mcpDenyNames)")
    expect(COMPILE_SRC).toContain("corumSubagentConfig('research', profile, mcpDenyNames)")
  })

  it('★★ 陈旧失败不再问：会话级路由已换过 ⇒ 那条失败已过时（2026-09-21 实机）', () => {
    // 实机现场（会话 corum-task-1b927cf3）：两个并行 subagent 都拿 deepseek-v4.1-flash
    // 起跑；用户在第 1 个弹窗选了「永久改为 glm-5.3-flash」；第 2 个兄弟带着**已过时**的
    // 「配置模型」事实来问 ⇒ 用户被同一个根因连问两次（seq 191「No choice was made」）。
    const guard = between('const effectiveNow = corumPolicyState.modelOverrideOf', 'const parentOptions =')
    expect(guard).toContain('effectiveNow.provider !== configuredModel.provider')
    expect(guard).toContain('effectiveNow.model !== configuredModel.model')
    // 跳过时必须返回「无决议」而不是伪造一个 route —— 伪造等于替用户同意重跑。
    expect(guard).toContain('route: undefined')
    expect(guard).not.toContain('fallback')
    // 相同 ⇒ 仍然要问（换了也还是坏的，那是真·新信息）：判据必须是「不同才跳过」。
    expect(guard).toMatch(/effectiveNow !== undefined/)
  })

  it('★★ 同一父会话同一角色只问一次：走 corumAskAboutModelOnce（并行兄弟共享决定）', () => {
    // 实机同一现场的另一半：两个并行失败各自弹窗。共享后只问一次。
    expect(SRC).toContain('await corumAskAboutModelOnce(')
    // 不许退回直接调 failure 版（那会绕过共享锁）。
    expect(SRC).not.toContain('await corumAskAboutModelFailure(')
  })

  it('★ 机制提示词不再宣告 per-task model（否则等于教模型用已删的参数）', () => {
    expect(SRC).not.toContain('a per-task `model` on an `orchestrate` task wins')
  })

  it('★ 机制提示词如实说明：子 Agent 模型不由模型选 + 失败时**机制问用户**（不是自动重试）', () => {
    const anchor = 'Child model routing is NOT yours to choose'
    const start = SRC.indexOf(anchor)
    expect(start, `anchor not found: ${anchor}`).toBeGreaterThanOrEqual(0)
    const line = SRC.slice(start, SRC.indexOf('\n', start))
    expect(line).toContain('never try to route a child elsewhere')
    // 2026-09-18 改版后的真实承诺：机制问用户并按其答案行动；模型自己不许改路由。
    expect(line).toContain('asks the user what to do')
    expect(line).toContain('you must not try to change any model or route yourself')
    // 旧承诺（自动重试）不得回潮——那句话已不成立。
    expect(line).not.toContain('automatically retries')
  })
})
