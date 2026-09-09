# 事件总线三期前全面扫描 · 审计报告（2026-09）

> 5 个维度 workflow 并行审计（事件机制遗漏 / 红线违规 / 载荷一致性 / fork 维护风险 / 改进机会）。
> 结论：**无 P0 硬违规，一/二期落地健康**；产出三期修正范围（用户已拍板 4 批次全做）。

## 无问题确认（健康基线）

- **双声明同步**：`corum-agent/events.ts` ↔ `corum-api-remotes/corum-events.ts` 逐字段一致，无漂移。
- **事件载荷**：14 个事件（12 领域 + terminal/output + file/changed）声明 vs host 实际 emit 载荷全部一致、纯 JSON、`exactOptionalPropertyTypes` 合规。
- **fork 忠实度**：`src/index.ts`/`types.ts` 与官方 alpha.2 逐字节一致；`client/index.ts` 仅 2 处声明过的 diff；allowlist 追加格式规范；接线正确。
- **ctx.remote.$on**：全部 7 处消费点 inject 均含 `'remote'`，无红线 4 违规。
- **跨 bundle import**：`@corum/*` 值 import 均为纯库内联（rpc-client/ui-base），type-only 合规。
- **`__corumSlotRegistry`**：合法 write-once-read-only 桥（B3 结论正确）。

## P1 应改（三期采纳）

1. **poll 降级兜底可删**：BottomPanel/EditorColumn 的 poll 分支 + host `corumTerminal/poll`、`corumFs/pollChanges` 端点 + 双写缓冲。触发条件「host 旧版不 emit」在单构建产物（host/renderer 同生同死）下永不发生，是纯迁移脚手架；删了更安全、省双写。→ 三-1
2. **事件可观测性缺失**：renderer 端零调试面。加 `__corumEventStats` 只读计数面（frames/lastAt/listeners），localStorage 开关 console.debug。是删 poll 的验证基建。→ 三-1
3. **2 处跨 bundle CustomEvent**：`corum:open-in-editor`（chat→desktop，含 3s 轮询 hack）+ `corum:open-plugin-manager`（壳→插件，事件名双份镜像无编译期联动）。改用 cordis 服务方法直调（renderer→renderer 方向，不走事件总线）。→ 三-2
4. **子 Agent 进度双轮询**：SubagentCard 2s 进度轮询 + 4s 模型轮询，性质同已迁终端。迁 $on（复用 `api-session/activity` 或新增增量推送）。→ 三-3
5. **fork-delta §8 基线滞后**：dsh 检出已 0.1.3-alpha.1（§8 写 alpha.2）。官方 alpha.2→0.1.3 新增 `fileUploadsRemote` 命名空间 + 删除 invariant 机制，§8 未登记，rebase 会静默漏掉。→ 三-4

## P2 可选改进（记录，非本期）

- `__corumMonacoEditor` window 全局可变单例（unmount 写 undefined，可同 bundle 内消解为模块 ref/context）。
- `collapsedSlots` 模块级可变 Set（grid.ts，当前单写者幸存，同 __corumSidebarMode 前夜，建议收进 layout 服务）。
- ~~3 处 `ctx.get('connection')` 未 inject 声明（corum-ui-conversation/apply.ts:260,449、corum-ui-chat/apply.ts、ide-statusbar-ui/index.ts）~~ → **2026-09-09 复核更正**：statusbar 已补 inject；剩余 = corum-ui-chat/apply.ts ×3 + corum-ui-conversation/apply.ts ×2（2 包 5 处）。
- fork 包缺 tests（官方 `remote-events.host.spec.ts` 232 行可移植，corum 追加事件只有编译期校验无运行时守护）。
- fork tsconfig 单文件合并双 face，削弱 host 面无 DOM 隔离（rebase 时考虑恢复官方双 tsconfig）。
- `TaskRef.transferNote`/`laneLabel` 声明可选 vs 构造保证非空的文档级漂移。
- artgen/ollama 长任务进度轮询（短生命周期，事件化收益低，非必须）。
- `corumFs` ~~16 个~~ **11 个**（2026-09-09 复核）RPC 封装散在 desktop apply 闭包（上帝对象注入面，可收进 `corumFsClient` 服务）。
- fork drift 机器校验脚本（verify-fork-api-remotes.sh：cmp 核心文件 + 事件名交集检查）。

## 三期批次（用户拍板全做）

- **三-1**：删 poll 双端 + 事件可观测性计数面（含 host 重启验证）。
- **三-2**：2 处跨 bundle CustomEvent 改 cordis 服务方法直调（renderer-only）。
- **三-3**：子 Agent 进度/模型轮询迁 $on 推送。
- **三-4**：fork-delta §8 基线刷新到 0.1.3-alpha.1。

## 三期明确不做

- 同 bundle CustomEvent（`workspace-root-changed`/`open-settings-section`/`developer-mode-change`）收编——合法一次性信号，收益为零。
- waterfall 形态 corum 事件——agent scope 映射验证点未解，无业务驱动。
- terminal/file 事件写入 scheduler-events.jsonl——高频帧污染调度事实源。
- 12 个 `corum/task|group` 死转发事件暂不从 allowlist 移除——保留作团队看板 UI 的消费预留（第一个真实业务消费者候选）。

---

## 复核（2026-09-09，逐项对代码）

> 结论：**无「文档标已完成、代码其实没做」的情况**。一期/二期/三期全部 ✅ 项均在代码里
> 核实到；P2 九项确实都仍未做（文档原本就标「记录，非本期」，不算误标）。仅两处**描述
> 过期**（不是完成度误标）需更正。

### 已完成项（逐项证据）

| 项 | 代码证据 |
|---|---|
| 一期 fork 包核心逐字节一致 | `diff packages/plugins/agent/corum-api-remotes/src/{index,types}.ts /Users/kukucai/dsh/packages/api/remotes/src/` → **0 行差异**（remote-events.ts 为 allowlist 增量、corum-events.ts 为 corum 新增，符合台账） |
| 一期/二期/三期事件接入 | `remote-events.ts` 转发事件 **34 条**；`corum-events.ts` 声明 **16 个 `corum/*` 事件**（12 领域 + terminal/output + file/changed + subagent/progress + worktree-ledger） |
| 二期 window 全局迁移 | `__corumChatRuntime` / `__corumOpenSession` 在源码中**只剩注释**（实现已迁 `chatRuntime` cordis 服务）；`__corumSlotRegistry` 按 §1 例外保留（2 文件） |
| 三-1 删 poll | host `corumTerminal/poll`、`corumFs/pollChanges` 端点已删（`corum-fs.ts` 仅存「三期删 pollChanges」注释）；BottomPanel/EditorColumn 的 poll 分支已删（仅注释） |
| 三-1 观测面 | `__corumEventStats` 存在**且实测可用**：CDP 打开终端后 `corum/terminal/output {frames:3, listeners:1}` |
| 三-2 CustomEvent 服务化 | `corum:open-in-editor` / `corum:open-plugin-manager` **无任何 dispatchEvent/addEventListener**（只剩注释）；实现走 `corumEditor` 服务 + grid actions 订阅面 |
| 三-3 子 Agent 轮询 | `SubagentCard.tsx` 无 `setInterval`；进度走 `$on('corum/subagent/progress')`（4s 模型轮询注释标明已删） |
| 三-4 台账刷新 | `docs/fork-delta.md` §8.1 已登记 alpha.2→0.1.3 漂移面 |
| 明确不做四项 | 同 bundle CustomEvent（developer-mode-change / open-settings-section / workspace-root-changed）仍在；12 个 `corum/task|group` 事件**确认无消费者**（仅 allowlist + 声明，预留语义准确）；terminal/file 未进 `scheduler-events.jsonl` |

### P2 九项：全部仍未做（与文档一致）

`__corumMonacoEditor`（2 文件）｜`collapsedSlots` 模块级 Set（`corum-ui-base/src/client/grid.ts:148`）｜
`ctx.get('connection')` 未 inject｜corum-api-remotes 无运行时测试（官方 `remote-events.host.spec.ts` 232 行确认存在可移植）｜
fork 单 tsconfig（19 个 corum 包均 tsconfig×1）｜`transferNote?`/`laneLabel` 可选声明｜
artgen + ollama 仍 setInterval 轮询｜`corumFs` RPC 仍在 desktop apply 闭包（无 `corumFsClient` 服务）｜无 fork drift 校验脚本（`scripts/` 下无 verify-fork-*）

### 文档需更正的两处（描述过期，非完成度误标）

1. **P2-3 位置清单过期**：原写「3 处：conversation:260,449 / chat / ide-statusbar」——
   实际 `corum-ide-statusbar-ui` **已声明 `'connection'`**（不再违规）；
   真实剩余违规 = `corum-ui-chat/src/client/apply.ts` **3 处** +
   `corum-ui-conversation/src/client/apply.ts` **2 处**（2 包 5 处调用点）。
2. **P2-8 数量过期**：原写「16 个 RPC 封装」——`desktop/src/client/index.ts` 里实际
   `corumFs/*` **11 个不同方法**（absolutePath/delete/list/mkdir/read/readBinary/rename/
   reveal/setRoot/watch/write）。

### 一处实质遗留（文档已归入「后续可选」，但影响面值得重申）

删 poll 同时删掉了**唯一断链补帧路径**：forwarded event 无 replay/generation 语义
（`corum-api-remotes/src/client/index.ts` 无补帧实现），连接闪断窗口内的终端/文件帧
永久丢失（终端 pty 若随 host 重启则本来就没了；纯 WS 抖动则出现输出空洞）。
原审计只论证了「host 版本错配永不发生」，未覆盖断链场景——**SRC stream（或帧序号补拉）
是这条的正解**，当前无业务驱动，暂不动。
