/**
 * @corum/corum-memory client half —— 在设置中心「记忆」分组注册**三个** section。
 *
 * ## 导航结构（用户 2026-09-21 裁定）
 *
 * > 「我建议直接将记忆单独列一个项，放在智能体下方，将全局设置、智能体记忆、项目记忆
 * > 这些 section 放进去。」
 *
 * 故「记忆」是**独立的导航分组**（紧邻「智能体」下方），组内三项：
 *
 * ```
 * 设置 › 记忆
 *   ├─ 全局设置     （id 'memory-settings'，order 60）—— 全局策略
 *   ├─ 智能体记忆   （id 'memory-agent'，   order 61）—— Agent 列表 → 三维记忆空间
 *   └─ 项目记忆     （id 'memory-project'， order 62）—— scope='project' 库
 * ```
 *
 * **「智能体记忆」是两步流程**（用户 2026-09-21 裁定：「先有个 Agent 列表，列出已经
 * 开启记忆的 Agent，点击进去后，可以进入一个三维的 Agent 记忆空间」）：
 *
 * ```
 * Agent 列表（MemoryAgentList）──点某个 Agent──▶ 该 Agent 的三维记忆空间（MemorySpace）
 *        ▲                                                    │
 *        └────────────────  ‹ Agent 列表  ────────────────────┘
 * ```
 *
 * 「项目记忆」仍是**平铺的库视图**（MemoryLibrary）：项目没有「一个项目一个空间」的分层
 * 需求强度——它更像一张表。两者共用同一套后端与操作，差别只在展现。若将来项目也需要
 * 空间视图，{@link MemorySpace} 只需多传一个 `projectId`。
 *
 * ⚠️ **记忆维度只有 Agent 和项目**（同一次裁定：「不做全局记忆」）——底座 `scope`
 * 枚举里的 `global` 已删除，曾有过的 `memory-store` 单页（内含三库 Tab）也随之拆开。
 *
 * 分组归属由壳的 `NAV_GROUP_BY_ID` 决定（`memory-settings` / `memory-agent` /
 * `memory-project` → `'memory'`）——壳侧已同步声明 `group.memory` 组标题（中/英）。
 *
 * ## 数据通路
 *
 * - 记忆数据：host RPC `/api/memory/*`。信封与 `@corum/corum-rpc-client` 的
 *   `makeCorumRpcCall` 逐字相同（`connection.rpc.call('/api', '<ns>/<method>', { args })`
 *   → `!ok` 抛 `<code>: <message>`），但**本地内联**而不引该包：为一个几行的函数新增
 *   workspace 依赖不值得（包越少、打包闭包越小）。
 * - 参数持久化：官方 settings 面 —— `ctx.settingsScope.bind({ namespace: 'corum-memory' })`。
 *   host 侧 boot 常驻注册行见 `@corum/corum-memory/settings-registrar`（不在 boot 注册
 *   则冷启动读不到已存参数，同 corum-subagent 的实测教训）。
 *
 * ## 视觉
 *
 * 组件全部自备（`./ui.tsx`，内联 style + 壳 token）——红线 §3.5：插件**不得**静态
 * value-import 壳 client bundle 的组件（`corum-ollama` 同款做法）。
 *
 * @module @corum/corum-memory/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useEffect, useState } from 'react'
import { MemorySettingsPage } from './MemorySettingsPage.tsx'
import type { MemoryCall, MemorySettingsFace } from './MemorySettingsPage.tsx'
import { MemoryLibrary } from './MemoryLibrary.tsx'
import { MemoryAgentList } from './MemoryAgentList.tsx'
import type { AgentSummary } from './MemoryAgentList.tsx'
import { MemorySpace } from './MemorySpace.tsx'

/** host settings namespace（与 memory-config.ts 的常量同值；client 不 import host 值）。 */
export const MEMORY_SETTINGS_NS = 'corum-memory'

/**
 * 基于官方 ConnectionHandle 构造 RPC 调用函数（`@corum/corum-rpc-client` 的同款信封）。
 *
 * @param connection - 官方 client connection 服务。
 * @returns 命名空间化调用函数；`!result.ok` 时抛 `<code>: <message>`。
 */
function makeCall(connection: ConnectionHandle): MemoryCall {
  return async function call<T, A extends object = Record<string, unknown>>(
    service: string,
    method: string,
    args: A,
  ): Promise<T> {
    const result = await connection.rpc.call('/api', `${service}/${method}`, { args })
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
}

/** corum Agent profile 列表端点（取 agentId → 展示名）。 */
type ProfilesReply = { profiles: Array<{ id: string; nickname?: string; title?: string }> }
/** corum 项目列表端点（取 projectId → 展示名）。 */
type ProjectsReply = { projects: Array<{ id: string; name?: string }> }

/**
 * 「记忆 › 全局设置」的 React 包装。
 *
 * @param props.settings - 已绑定的 settings scope（调用面）。
 * @param props.call - host RPC。
 * @returns 设置页。
 */
function SettingsSectionHost({ settings, call }: { settings: MemorySettingsFace; call: MemoryCall }) {
  return <MemorySettingsPage settings={settings} call={call} />
}

/**
 * 「记忆 › 智能体记忆」：**两步流程**（Agent 列表 ⇄ 三维记忆空间）。
 *
 * `openAgent` 是这一步的全部状态——为 null 显示列表，非 null 显示该 Agent 的空间。
 * 用组件内 state 而不是新增 section：用户口径是「点进去」，即**同一入口内的下钻**，
 * 不是导航里多一个分区（多一个分区还要处理「从列表进的空间，返回时高亮哪个导航项」）。
 *
 * @param props.call - host RPC。
 * @returns 列表或空间。
 */
function AgentSectionHost({ call }: { call: MemoryCall }) {
  const [openAgent, setOpenAgent] = useState<AgentSummary | null>(null)
  if (openAgent === null) {
    return <MemoryAgentList call={call} onOpen={setOpenAgent} />
  }
  return (
    <MemorySpace
      call={call}
      agentId={openAgent.id}
      agentName={openAgent.nickname ?? openAgent.title ?? openAgent.id}
      onBack={() => setOpenAgent(null)}
    />
  )
}

/**
 * 「记忆 › 项目记忆」的 React 包装：额外拉 Agent / 项目名册，把归属 id 显示成人能读的名字。
 *
 * 为什么在这里拉而不是在记忆 RPC 里 join：底座**不认识** Agent / 项目（它只知道
 * `agentId` / `projectId` 字符串，这是刻意的解耦——底座不绑定任何来源）。名字映射
 * 属于展现层，故由 client 侧用 corum 自己的两个端点拼。
 *
 * ⚠️ 与「智能体记忆」各自拉一次名册（两个 React 实例），这是**有意的**：名册是廉价的
 * 本地索引读取，而为共享它引入一个跨 section 的缓存服务，收益不抵复杂度（红线 1
 * 的教训是「别用模块级单例做跨 bundle 共享」，不是「别重复读一次本地索引」）。
 *
 * @param props.call - host RPC（同一个 call 面，换 service 名）。
 * @returns 项目维度的记忆库页。
 */
function ProjectSectionHost({ call }: { call: MemoryCall }) {
  const [profileNames, setProfileNames] = useState<Record<string, string>>({})
  const [projectNames, setProjectNames] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    const load = async () => {
      // 名册拉不到不是致命错误——回落显示 id（记忆库必须仍然可用）。
      const [profiles, projects] = await Promise.all([
        call<ProfilesReply>('corumAgent', 'listProfiles', {}).catch(() => ({ profiles: [] })),
        call<ProjectsReply>('corumProject', 'listProjects', {}).catch(() => ({ projects: [] })),
      ])
      if (!alive) return
      const pm: Record<string, string> = {}
      for (const p of profiles.profiles ?? []) pm[p.id] = p.nickname ?? p.title ?? p.id
      const jm: Record<string, string> = {}
      for (const p of projects.projects ?? []) jm[p.id] = p.name ?? p.id
      setProfileNames(pm)
      setProjectNames(jm)
    }
    void load()
    return () => { alive = false }
  }, [call])

  return (
    <MemoryLibrary
      scope="project"
      call={call}
      profileNames={profileNames}
      projectNames={projectNames}
    />
  )
}

export const inject = ['slots', 'connection', 'remote', 'settingsScope']

export function apply(ctx: ClientContext): void {
  let slots: ClientContext['slots'] | undefined
  try {
    slots = ctx.slots
  } catch {
    return
  }
  const connection = ctx.get('connection') as ConnectionHandle
  const call = makeCall(connection)
  // settings 面：绑本 ns（读走共享 mirror，写走官方序列化写链 —— 不自己拼 RPC）。
  const settings = ctx.settingsScope.bind({ namespace: MEMORY_SETTINGS_NS }) as unknown as MemorySettingsFace

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'memory-settings',
    order: 60,
    label: '全局设置',
  }, () => <SettingsSectionHost settings={settings} call={call} />))

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'memory-agent',
    order: 61,
    label: '智能体记忆',
  }, () => <AgentSectionHost call={call} />))

  slots.inject('settings.section', () => slots.register({
    name: 'settings.section',
    id: 'memory-project',
    order: 62,
    label: '项目记忆',
  }, () => <ProjectSectionHost call={call} />))
}
