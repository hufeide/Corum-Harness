/**
 * lane-support —— **闭源项目模式插件的支撑面**（开源侧唯一的对外缝口）。
 *
 * ## 为什么需要这个模块
 *
 * 2026-09-26 开源/闭源剥离后，项目泳道会话的**创建编排**搬到了闭源仓
 * Corum-Harness-Project 的 `@corum/corum-project`。但那段编排要用一批**纯助手**
 * （不是状态、不是服务）：profile 编译落盘、pinned skill checkout、模型选择安装、
 * 预设模型可用性回落、事件投影（simplifyEventData / extractHeader / summarizeText）、
 * 内置 PM profile 播种。它们留在开源侧（task 模式与其它插件同样在用），
 * 闭源仓只经**这一条缝**取用。
 *
 * ## 为什么单开一条缝、而不是塞进包根导出
 *
 * 塞进 `index.ts` 的根导出面会让 8 个内部助手变成「任何插件都可依赖的公共 API」，
 * 而它们其实是**实现细节**（`checkoutPinnedSkills` / `writeAgentDir` 有明确的调用
 * 时序前提）。单开 `./lane-support` 子路径把「谁在依赖这些内部件」写成一条显式记录：
 * 只有闭源项目模式插件。红线 3 的同族思路——**能力用窄接口表达**，
 * 别把整包敞开。
 *
 * ## 这个模块里**没有**什么（刻意）
 *
 * 没有状态、没有服务、没有单例。存活表（`AgentRegistry` 的泳道两表）的唯一所有者
 * 仍是 `agent-service.ts` 的 `CorumAgentService`；闭源仓经该服务的公共方法读写它
 * （`getAgentForLane` / `registerLaneAgent` / `findLaneAgent` /
 * `lookupPersistedSessionId` / `registerLaneSessionId`）。
 *
 * @module @corum/corum-agent/lane-support
 */

// 泳道描述与创建结果类型（闭源侧 createAgentForLane 的签名面）。
export type { AgentLaneDescriptor, CreateAgentResult, SessionEventDto, RunPromptResult } from './agent-service.ts'

// profile 编译与落盘（create 路径的固定两步：checkout pinned skills → 落盘 preset）。
export { checkoutPinnedSkills, writeAgentDir } from './profile-compiler.ts'
export { agentDirPath, loadProfile } from './profile-store.ts'
export { isValidProfileId } from './profile.ts'

// 模型选择安装 + 预设模型可用性回落（项目泳道与 task 泳道共用同一条口径）。
export { installTaskModelSelection } from './task-model-selection.ts'
export { resolveUsableModel } from './model-availability.ts'

// 事件投影（泳道历史回填与 prompt 回复汇总）。
export { extractHeader, simplifyEventData, summarizeText } from './event-projection.ts'

// 内置 PM profile 播种（项目组默认带入 PM 助理）。
export { ensurePmProfile, PM_PROFILE_ID } from './builtin-profiles.ts'
