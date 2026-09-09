# 会话 `corum-task-2097f05c`（corum Agent选择无效问题）问题梳理

> **性质**：原始证据记录（用户实测会话的复盘）。规则/经验后续各自毕业到
> `docs/dev-conventions.md` / `docs/LESSONS.md`，问题台账进 `docs/TODO.md`。
> **会话**：`~/.corum/sessions/--Users-kukucai-work-kkc-desktop--/corum-task-2097f05c/session.v2.jsonl.zstd`
> （打包态 `/Applications/Corum.app`，278 事件，2 turn，51 次工具调用，8 次子 Agent 委托）
> **会话时间**：2026-09-09 22:44–23:15；turn 2 由用户中止（`seq=275`）。

## 复现读取方式

```bash
SID=~/.corum/sessions/--Users-kukucai-work-kkc-desktop--/corum-task-2097f05c
# 事件类型普查
zstdcat $SID/session.v2.jsonl.zstd | python3 -c "import sys,json,collections;c=collections.Counter(json.loads(l)['type'] for l in sys.stdin if l.strip());print(c)"
# 取某条事件全文
zstdcat $SID/session.v2.jsonl.zstd | python3 -c "import sys,json;[print(json.dumps(e,ensure_ascii=False,indent=1)) for e in map(json.loads,sys.stdin) if e.get('seq') in (128,137,138,263,271,273,275)]"
```

## 时间线（关键锚点）

| 时刻 | seq | 事件 |
|---|---|---|
| 22:44 | 0 | 会话创建（cwd=kkc-desktop，preset=task，agentPreset 选 conductor） |
| 22:46:24 | 5 | turn 1 start |
| 22:48:21 | 95/96 | 并行两个 `subagent_research`（git 史 / host 语义） |
| 22:50:38 | 128 | **`assistant/attempt {stream: []}`**——turn 1 step 20 的模型请求以失败/中断结算 |
| 22:50:38→22:55:24 | — | **4 分 47 秒零事件**；turn 1 从未写 `turn/end`（seq 0..276 连续，无缺号） |
| 22:55:24 | 131 | turn 2 start（由子 Agent 消息触发） |
| 22:56–23:12 | 151/165/222/238/251 | 5 次委托（环境探针 / CDP 复现 / 实施修复 / 主树合并 / 列未编译角色） |
| 23:13:09 | 271 | `subagent {integrate: true}` 集成步骤 |
| 23:15:37 | 275 | **turn 2 被用户中止**（`reason:{kind:'aborted',reason:{kind:'user'}}`）；integrate 子 Agent 随之 `seq=273 Error: subagent run was cancelled` |

## 问题清单

### P1 报告的 BUG：切「从未编译过」的内置 Agent 失败（源码已修，**未构建/未验证**）

- 现象：composer Agent chip 点「项目经理 / 指挥者」等，chip 文字不变（用户："选择后没有生效"）。
- 根因（会话内已定案，证据 `seq=263`/`seq=268`）：`selectTaskAgentProfileRemote` 先
  `ctx.agentPresets.select(...)`（`agent-service.ts:1453`）再 `writeAgentDir`（`:1455`）；
  而 `select` 要读 `.agent-presets/<id>/agent.cordis.yml`——从未编译的内置 profile 只有
  `agent.json` → 抛
  `agent-preset/invalid: agent-presets: preset "project-manager" failed to mount: the composition file agent.cordis.yml is missing`。
- 实测矩阵（`seq=272`，dev 实例 blank task lane）：project-manager ❌ / conductor-lead ❌ /
  general-assistant ✅ / 标准模式 ✅。
- **状态：已解决（2026-09-09 23:24–23:25 实机三层验证）**
  - 修复 commit `cbd64c18`（main，23:14:15 fast-forward）；本轮补齐 `pnpm --filter
    @corum/corum-agent run build`（此前 `lib/index.js` 还是 21:37 旧产物，修复未生效）。
  - 验证 1（`selectTaskAgentProfileRemote`）：空白泳道 chip 选「项目经理」（当时只有
    `agent.json`）→ chip 变「项目经理-项目管理」、aria 无「切换失败」、
    `agent.cordis.yml`+`preset.yml` 落盘、会话 `agent-preset/selected=project-manager`、
    console 零错误、未编译角色数 18→17。
  - 验证 2（`createAgentForTask` reuse 块）：新建任务表单选「指挥者」复用同一空白泳道 →
    同样成功、`conductor-lead/agent.cordis.yml` 落盘、`agent-preset/selected=conductor-lead`、
    17→16。
  - ⚠️ **台账更正**：`docs/fork-delta.md` §8 note 3 自 2026-09-08 就登记了这两处顺序修正并
    附 ✅，但代码里从来没有（09-04/09-01 引入时就是 select→writeAgentDir）；09-08 那条验证
    是假绿（目标角色已编译）。见 `LESSONS.md` §10.13。
  - ⚠️ **打包态需重打包**：`/Applications/Corum.app/Contents/Resources/host/node_modules/@corum/corum-agent`
    是**拷贝**（非 symlink），仍为旧顺序 → 用户安装的 app 行为未变。

### P2 切换失败对用户完全不可见

- 证据：`corum-ui-conversation/ConversationRoot.tsx:530-534` 只 `console.error` +
  `setAgentSwitchError`；`:583` 只把错误写进 `ariaLabel`（`选择执行 Agent（切换失败：…）`）。
  屏幕无任何提示——"名字没变"就是这条的直接体验。
- 待办：chip 旁可见错误（内联红字/提示条），必要时 toast；错误可见性应作为纪律（参照
  `dev-conventions.md` §10.13「失败要有可读信息」）。

### P3 主 Agent 一个 turn 卡死 4m47s，且没有 `turn/end`（最严重）

- 证据：`seq=128` `assistant/attempt {stream: []}`（durable 结算 = 模型请求失败/中断），
  之后到 `seq=130`（22:55:24）零事件；turn 1 无 `turn/end`，seq 连续。
- 引擎侧事实：`dsh packages/core/agent-loop/src/agent.ts:327-331` 的 `finally` 必写
  `turn/end`；失败路径 `:443` 抛 `LlmError` 也应落到该 finally → 缺失属异常。
- 待查方向：先排除 P4 双 host 干扰再复现；若仍复现，查 `agent/request-error` 瀑布
  （`dsh llm-retry/src/index.ts:243`）与 `agent/turn-stopping`（本仓无监听者）。
- 影响面：主 Agent 表现为"停住"；子卡 `done` 依赖子会话 `turn/end`，可能长期显示 Running。

### P4 打包 app 有孤儿 host，与当前 host 共享同一 `~/.corum`（双重派发风险）

- 证据（2026-09-09 23:20）：`ps -o pid,ppid,lstart` →
  **25144**（ppid=1，18:10:20 启动）与 **25152**（ppid=25145，22:43:33）都是
  `/Applications/Corum.app/Contents/Resources/host/lib/bridge.js`；各自 LISTEN
  （60008 / 57755）。`~/.corum/run/host.pid` 只记录 25152。
- 已登记同类问题：`docs/TODO.md` 2026-08-25「多 host 实例共享 CORUM_HOME 会双重派发」；
  reaper 只按 host.pid 单条 PID 收尸，扫不到孤儿。
- **状态：已手工清除（2026-09-09 23:22）** —— `kill 25144` 后只剩 host.pid 记录的 25152，
  应用主进程 25145 不受影响。机制缺口（reaper 只认单条 PID）已补记进 TODO 2026-08-25 条目。

### P5 把「合并到主树」委托给隔离子 Agent = 结构性不可能

- 证据：`seq=238` 委托 "Merge fix and rebuild in main tree" → `seq=239`/`seq=244` 子 Agent
  报告：workspace-write 只覆盖自己的 worktree（`.corum-worktrees/wt-515f14`），写主树全部
  `Operation not permitted`（含 git lock）。父 Agent 随后才改用 `integrate: true`（`seq=271`）。
- 待办：机制段/工具描述写明「集成/合并由父 Agent 做，或走 `integrate: true`；不要把主树
  写操作委托给隔离子 Agent」。

### P6 `job_output` 拿子 Agent id 当 job id（工具面混淆）

- 证据：`seq=137` `job_output {job_id: 288cf427-…}` → `seq=138 Error: unknown job …`；
  `seq=144` `job_list {}` → `(no background jobs)`（此刻 2 个子 Agent 在跑）。
- 待办：机制段补一句「后台子 Agent 不是 job：用 `list_agents` / `send_message` / 等通知」。

### P7 用户中止 → 修复从未实机验证

- 证据：`seq=275` 用户中止；`seq=233` todo 停在
  `pending: Restart app instance + CDP post-fix verification (three-layer)`。
- **状态：已补齐（2026-09-09 23:24–23:25）** —— 见 §P1 的两条实机验证；打包态仍待重打包。

### P8 子 Agent 卡片扎堆（瀑布流位置错误）

- 证据：`corum-ui-chat/src/client/conversation-nodes/subagent.ts:180-201`——**每个 turn 只建
  一个** `subagent-progress` 节点，`anchor = Math.min(...invocations.map(anchorSeq))`
  （= 该 turn 最早一次委托的 seq）；`SubagentCard` 再把该 turn 的所有 invocation 渲染成
  一列卡片（`SubagentCard.tsx:429-444`）。
- 后果：同 turn 后发生的委托卡全部追加到最早位置 → 新卡在**上方**，必须上翻才看到；
  且新旧卡混在一处。这是用户第二条诉求「瀑布流要正确展示卡片位置」的根因。
- 另一半诉求「常驻/悬浮」：见本文件 §卡片方案。

### P9 附带残留

- worktree：`.corum-worktrees/wt-44dbf7`（已合并）、`wt-515f14`、`wt-55c5df`
  （后两个分支 0 commits ahead，空）；分支 `wt/wt-515f14`、`wt/wt-55c5df` 仍在。
- dev home 有 18/27 内置角色只有 `agent.json`、无 `agent.cordis.yml`（`seq=252`）——
  正是 P1 的触发条件。
