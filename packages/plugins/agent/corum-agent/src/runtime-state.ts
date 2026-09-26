/**
 * runtime-state —— 卡住自动恢复阈值的 holder（2026-09-26 项目模式剥离后的**开源残面**）。
 *
 * ## 为什么只剩这一个 holder
 *
 * 本文件原是从 `runtime.ts` 拆出的「项目 × 角色」调度层状态形状（`LaneState` /
 * `ProfileRuntime`）+ 调度常量 + **阈值 holder**。项目模式剥离后：
 *
 * - `LaneState` / `ProfileRuntime` / `STALL_THRESHOLD_MS` / `STALL_SCAN_INTERVAL_MS`
 *   **只被 `runtime.ts`（已迁至闭源仓 Corum-Harness-Project）使用**，故随它迁出
 *   （闭源仓 `src/runtime-state.ts` 持有那些形状，并**re-export 本模块的 holder**
 *   ——刻意不做第二份 holder：模块级可变状态在两个包各持一份就会分叉，
 *   正是本仓红线 1 禁止的形态）。
 * - **阈值 holder 留在开源侧**：`agent-service.ts` 的 `whenIdleWithTimeout`
 *   （task 泳道的 turn 级超时兜底）读它，`index.ts` 的 settings 订阅写它
 *   —— task 模式与项目制扫描**共用这一个值**（避免两处硬编码漂移，见 C4）。
 *
 * 跨包消费面：`@corum/corum-agent/runtime-state` 子路径导出（见 package.json）。
 *
 * @module @corum/corum-agent/runtime-state
 */

/**
 * 卡住自动恢复阈值**默认值**：执行中任务超过此时长无活动 → 主动 cancel turn +
 * requeue + 注入提示让模型重试。10 分钟经验起点：bash 工具 5min 超时 + 5min 余量
 * 让模型自行恢复。
 *
 * C4（2026-09-11 用户要求配置化）：实际生效值走下面的 holder —— 由
 * `corum-agent` settings namespace 的 `stallRecoverMinutes` 覆盖（默认即本值）。
 * 项目制扫描（闭源仓 runtime.ts）与 task 泳道（agent-service.ts 的
 * whenIdleWithTimeout）**共用**这一个值。
 */
export const STALL_AUTO_RECOVER_MS_DEFAULT = 10 * 60 * 1000

/** 生效中的自动恢复阈值（可由设置覆盖）。 */
let stallAutoRecoverMs = STALL_AUTO_RECOVER_MS_DEFAULT

/** 读生效中的自动恢复阈值（毫秒）。 */
export function stallAutoRecoverMsValue(): number {
  return stallAutoRecoverMs
}

/** 设置自动恢复阈值（分钟）。非法值忽略；下限 1 分钟，避免配成 0 把正常长工具打断。 */
export function setStallAutoRecoverMinutes(minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) return
  stallAutoRecoverMs = Math.max(60_000, Math.round(minutes * 60_000))
}
