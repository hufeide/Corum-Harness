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
- 3 处 `ctx.get('connection')` 未 inject 声明（corum-ui-conversation/apply.ts:260,449、corum-ui-chat/apply.ts、ide-statusbar-ui/index.ts）。
- fork 包缺 tests（官方 `remote-events.host.spec.ts` 232 行可移植，corum 追加事件只有编译期校验无运行时守护）。
- fork tsconfig 单文件合并双 face，削弱 host 面无 DOM 隔离（rebase 时考虑恢复官方双 tsconfig）。
- `TaskRef.transferNote`/`laneLabel` 声明可选 vs 构造保证非空的文档级漂移。
- artgen/ollama 长任务进度轮询（短生命周期，事件化收益低，非必须）。
- `corumFs` 16 个 RPC 封装散在 desktop apply 闭包（上帝对象注入面，可收进 `corumFsClient` 服务）。
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
