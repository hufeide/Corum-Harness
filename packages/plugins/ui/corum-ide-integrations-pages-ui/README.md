# @corum/corum-ide-integrations-pages-ui

集成中心的内容页（PR6）：**MCP 页**与**技能页**。

## 这是什么

两页原先住在设置中心（`@corum/corum-ide-ui` 的 `SettingsMcpSection` /
`SettingsSkillsSection`）。PR6 按信息架构调整把它们**移出**设置中心，成为
**集成中心**的内容页——设置中心的 `mcp` / `skills` 两条 `SECTION_DEFS` 注册、
两个 import、`settings-locales.ts` 的 `nav.mcp` / `nav.skills` 文案，以及
`SettingsSections.module.css` 里仅供两页使用的样式已同步删除。迁移是**搬移不是复制**。

| 组件 | 内容 | 数据面（RPC 面未变） |
| --- | --- | --- |
| `McpPage` | 服务器卡片列表（名称/transport chip/描述/工具数/启停/+添加服务器）⇄ 详情（基本信息/工具列表/Agent 绑定/删除确认）⇄ 添加（名称/传输 tab/配置 JSON/超时/使用指导） | `mcpManager`：`listServers` `getServer` `saveServer` `deleteServer` `testConnection` `getServerReferences` |
| `SkillsPage` | 技能卡列表（名称/描述/来源/启停）+ 详情（基本信息 / SKILL.md 内容 / 版本历史 / 绑定关系）+ 导入/删除对话框 | `skillManager`：`listAll` `getSkillContent` `getSkillHistory` `pinVersion` `commitVersion` `deleteSkill` `importFromFile` `importFromText` `scanDirectory` `importDirectory` `importBuiltinSkills`；绑定数读 `corumAgent/listProfiles` |

## 注入面

页面不依赖设置壳的 `CorumRpcContext`（那会把整个设置壳包拉进本 bundle）。本包自持
一份**同形更窄**的面：

- `IntegrationsRpcContext` / `useIntegrationsRpc()`（`src/client/face.tsx`）——
  与设置壳 `CorumRpcContext` 同形（`CorumRpcCall | null`），未 provide 时页面降级为
  「RPC 服务未就绪」占位（与迁出前行为逐字一致）。
- `GlassButton`：迁出时自设置壳 `shared.tsx` 一并带入。
- `Switch` / `SettingGroup` / `ConfirmDialog` 与 `IntegrationsPages.module.css`：
  本包自持副本（两个包是各自独立的 client bundle，不能跨包 import 组件与 CSS module）。

## 挂载状态：**加载不挂载**（等 PR4）

槽名（见 `src/client/slots.ts`）：

- `corum.integrations.mcp`
- `corum.integrations.skills`

**声明权归 PR4 的集成中心骨架**（声明 = 排他渲染权）。本包的 `client apply` 因此
**有意为空**：抢先声明会让骨架落地时撞「already declared」。当前登记：

- `packages/desktop/package.json` + `desktop-host/package.json` 的 dependencies（`workspace:*`）
- `packages/desktop/cordis.ide.patch.yml` 的 insert 段（`ide-integrations-pages` 行，注释写明了
  「加载不挂载」的缘由）

骨架合入后：由骨架在其 `ctx.slots.register({ name: 'root', children: { … } })` 里声明这两个
子槽，再把 `src/client/index.tsx` 模块头注释里的两段 `ctx.slots.inject` + `ctx.slots.register`
（`IntegrationsRpcContext.Provider` 包着 `McpPage` / `SkillsPage`）打开即可。

## 构建

```sh
pnpm --filter @corum/corum-ide-integrations-pages-ui run build      # tsc -b && tsdown && inline-css
pnpm --filter @corum/corum-ide-integrations-pages-ui run typecheck
```

产物 `lib/client.js` 是闭包工厂件（`window.__ModuleLoader__.load({…})`），CSS 由
`scripts/inline-css.mjs` 折进同一个 bundle（标记 `data-plugin="@corum/corum-ide-integrations-pages-ui"`）。
