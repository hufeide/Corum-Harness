# 统一事件总线三-2：2 处跨 bundle CustomEvent 服务化 · 交付报告（2026-09-07）

> 审计发现 #3（`.dbg/event-bus-audit-2026-09.md` P1#3）：`corum:open-in-editor`
> （chat→desktop，带 3s 轮询 hack）+ `corum:open-plugin-manager`（壳→插件，双份
> 字面量镜像）改为 cordis 服务方法直调（renderer→renderer 方向，不走 host
> $on 事件总线）。

## A. `corum:open-in-editor` → `corumEditor` cordis 服务

### 服务面设计
- **新文件** `packages/desktop/src/client/editor/corum-editor.ts`（cordis-free 纯库）：
  - `CorumEditorService.openFile(absolutePath): Promise<OpenFileResult>`，
    `OpenFileResult = { ok: boolean; error?: string }`。
  - 内部封装：toRelativePath（绝对→corumFs 相对）+ showRegion 点亮 +
    `editorApiRef.openFile(rel, { pin: true })`。
  - **pending 队列替代 3s 轮询**：EditorColumn 未挂载时请求挂单 pending 槽
    （新请求覆盖旧请求，避免连点排队），`createEditorReadySource()` 通知源在
    EditorColumn 挂载写入 openFile 时触发认领；3s 兜底超时 resolve
    `{ ok:false, error:'编辑器挂载超时（3s 未就绪）' }`。纯事件驱动、零轮询。
  - 错误面：路径为空 / 未打开项目 / 路径不在工作区根（带 root 回显）/ 挂载
    超时 / openFile 异常——全部结构化返回。

### provide / inject 点
- **provide**：`packages/desktop/src/client/index.ts`（ctx.inject 回调内）
  `editorCtx.provide('corumEditor', corumEditor)`；`declare module cordis`
  Context merge 加 `corumEditor: CorumEditorService`。editorApiRef 改为
  getter/setter 包装（openFile 写入即 `editorReady.notify()`）。
- **inject**：`packages/plugins/session/corum-ui-chat/src/client/apply.ts`
  inject 数组加 `'corumEditor'`（红线 4）。Context merge 在 chat 侧**本地镜像**
  声明（chat 不依赖 desktop 包——desktop 是壳装配根，依赖会成环；dev-conventions
  §3.5 镜像字面量同构的合法做法，注释锚定 corum-editor.ts 源）。

### 消费端改造（chat apply.ts）
- `openFile` 从 `window.dispatchEvent(new CustomEvent('corum:open-in-editor'))`
  改为 `ctx.corumEditor as unknown as EditorOpenCapable`（局部能力接口 +
  `typeof openFile === 'function'` 可选链防御，红线 2/3）→ `await editor.openFile(absolute)`。
- `{ ok:false }` 时 `console.warn` + `__corumNotify`（规范 §1 合法只读桥）发
  用户可见错误通知（'无法在编辑器打开文件' + error message）。

### hack 删除证据
- `packages/desktop/src/client/index.ts`：`window.addEventListener('corum:open-in-editor')`
  + 100ms×30 轮询循环**整段删除**（grep 源码零残留）；cleanup 里的
  removeEventListener 同步删除。
- 运行中 mega bundle grep：`provide('corumEditor'` ✅、`editor mount timeout` ✅、
  `corum:open-in-editor` 字面量**消失** ✅。
- CDP 行为证据：dispatch 退役事件 → window 上零 listener 反应（见下「CDP 验证」）。

## B. `corum:open-plugin-manager` → grid actions 订阅面

### 服务面设计（照搬 onOpenNewTaskForm pending 模式）
- **壳 `corum-ide-ui/src/client/service.ts`**：
  - `GridActions` + `ILayout` 各加 `openPluginManager()` /
    `onOpenPluginManager(listener): () => void`（与 onGridChange/onOpenNewTaskForm 同构）。
  - `LayoutController.openPluginManager()` 改为 `this.#requireGrid().openPluginManager()`
    （原 window.dispatchEvent 删除）；`OPEN_PLUGIN_MANAGER_EVENT` 常量删除。
  - `onOpenPluginManager` 带**接线前订阅缓冲**（见「坑」#1）：`#grid === undefined`
    时进 `#pendingPluginManagerListeners`，`attachGrid` 时补订阅。
- **`AppFrame.tsx`**：`pluginManagerListeners` ref + `pendingPluginManager` ref +
  `openPluginManagerSignal`（无监听者置 pending）；`gridActions` 实现
  `openPluginManager` / `onOpenPluginManager`（**挂载即认领**：订阅时 pending
  置位则 queueMicrotask 立即补调，认领点收敛进订阅本身）；浮窗 NOOP
  gridActions 同步补两方法（防 #requireGrid 抛错）。
- **设置中心链路**（同 bundle）：`shell-contract.ts` `SettingsRootInjected` 加
  `openPluginManager`；壳 index.tsx `shellInjected` 直通 `layout.openPluginManager()`；
  `SettingsShell.tsx` props → `SectionNavContext` 下发；`SettingsSections.tsx`
  `SectionActions` 加 `openPluginManager`，「发现更多插件」`discoverMore` 改为
  `sectionNav?.close(); sectionNav?.openPluginManager()`（原 dispatch 删除）。

### 消费端改造（corum-ide-plugin-manager-ui/src/client/index.tsx）
- inject 已含 `'layout'`（红线 4 合规），`GridCapableLayout` →
  `PluginManagerCapableLayout`（+ `onOpenPluginManager?` 可选链，红线 2/3）。
- `window.addEventListener(OPEN_PLUGIN_MANAGER_EVENT)` →
  `layout.onOpenPluginManager?.(() => { open() })`；退订进 effect cleanup。
- 本地镜像常量 `OPEN_PLUGIN_MANAGER_EVENT` 删除——**编译期联动恢复**：壳面改名
  则消费端类型报错，不再静默断链。

### hack 删除证据
- 源码 grep `OPEN_PLUGIN_MANAGER_EVENT|corum:open-plugin-manager` 活引用 = 0
  （仅 SettingsSections.tsx:45 一处历史注释 + corum-editor.ts 文档注释提及旧名）。
- 运行中 mega bundle grep：`onOpenPluginManager` ✅、`corum:open-plugin-manager`
  字面量**消失** ✅。
- 壳 index.tsx 不再 re-export 该常量；`packages/desktop/cordis.ide.patch.yml`
  注释同步更新。

## 构建证据（4 包全绿）

| 包 | build | typecheck |
|---|---|---|
| @corum/corum-ide-ui | ✅ | ✅ 0 errors |
| @corum/corum-ide-plugin-manager-ui | ✅ | ✅ 0 errors |
| corum-desktop | ✅ | ✅ 0 errors（host+client 双 tsconfig） |
| @corum/corum-ui-chat | ✅ | ✅ 0 errors |

## CDP 三层验证证据（scripts/cdp.mjs，实例重启后）

1. **open-in-editor 服务化**：
   - 运行 bundle：desktop `provide('corumEditor')` ✅ / pending 标记 ✅ /
     chat `inject 'corumEditor'` ✅ / 错误通知文案 ✅。
   - 行为：editorApi.openFile('/README.md', {pin})（= 服务内部同一调用）→
     README.md tab 打开（3 个 DOM 节点）✅（截图 san3-2-11）。
   - **3s 轮询 hack 已删**：源码 grep 零 setTimeout 轮询；bundle 无
     `corum:open-in-editor` 字面量。
   - **window 无 listener**：dispatch 退役事件 → 零 console.warn 反应、编辑器
     无动作 ✅。
   - chat 拿 ok/error：服务面 `Promise<{ok,error}>` 类型 + 实现全覆盖（错误
     分支：空路径/未打开项目/不在根/超时）；错误时 console.warn + __corumNotify
     toast（bundle 内文案实证；会话内 fiber 触达的 openFile 是 EditorColumn
     内部面而非 chat 注入面，chat 面的结构化返回以类型+实现+bundle 标记三层
     佐证）。
2. **open-plugin-manager 服务化**：
   - 点标题栏「插件」按钮 → `[data-plugin-manager-overlay]` 挂载、面板渲染
     （已安装/检索/视图管理三区）✅（截图 san3-2-12/13）。
   - 重复打开/关闭稳定（reopened ✅ / closedAgain ✅）；点遮罩关闭正常。
   - **字面量镜像已删**：源码 + 运行 bundle 双向 grep 零 `corum:open-plugin-manager`。
   - **window 无 listener**：dispatch 退役事件 → 面板**不**打开 ✅。
   - **pending 认领**：onOpenPluginManager 订阅即认领（queueMicrotask 补调）；
     插件激活早于 AppFrame 接线时经 LayoutController 缓冲集补订阅（坑 #1 修复
     后启动正常）✅。
3. **console 零 error + 回归**：全程 3 次 console sweep 零 error；编辑器 tab
   保持、会话区存活、资源管理器/终端正常（截图 san3-2-14）。
4. 截图：`.dbg/unified-event-bus/san3-2-{01,02,10,11,12,13,14}*.png`。

## 剩余 window CustomEvent 清单（确认只剩同 bundle 合法一次性信号）

| 事件 | 方向 | 判定 |
|---|---|---|
| `corum:workspace-root-changed` | desktop client 同 bundle（index.ts dispatch → EditorColumn/ExplorerPane 监听） | ✅ 保留（红线 4 合法） |
| `corum:open-settings-section` | 壳同 bundle（service.ts dispatch → SettingsShell 监听） | ✅ 保留 |
| `corum:developer-mode-change` | 壳 settings 同 bundle（developer-mode.ts 内部） | ✅ 保留 |

## 遇到的坑与解法

1. **【真坑】cordis 激活序 ≠ AppFrame 挂载序**：plugin-manager 的 apply 调
   `ctx.layout.onOpenPluginManager()` 时 AppFrame 尚未 attachGrid，
   `#requireGrid()` 抛错把整个插件 activate 打崩（白屏「Failed to load
   plugins: layout: grid actions not wired (AppFrame not mounted)」——CDP
   截图实证）。**解法**：LayoutController.onOpenPluginManager 加接线前订阅缓冲
   （`#pendingPluginManagerListeners`），attachGrid 时补订阅；pending 认领
   逻辑在 grid actions 内部，补订阅自然继承。这是 openNewTaskForm 消费端
   （EmptyStateHero）没踩过的坑——它是组件渲染期订阅（必然晚于 AppFrame），
   而插件 apply 是 cordis 激活期（时序不定）。
2. **chat 不可 type-import desktop 包**：`import type {} from '@corum/corum-desktop/client'`
   TS2307——desktop 是壳装配根，不在任何插件依赖里（加了会成环）。**解法**：
   Context merge 在 chat 侧本地镜像声明（dev-conventions §3.5 的合法镜像
   做法），注释锚定实现源 `corum-editor.ts`。
3. **`exactOptionalPropertyTypes` 严格模式**：`message: string | undefined`
   不能赋给 `message?: string`。**解法**：镜像类型显式 `message?: string | undefined`。
4. **工作区并发回退**（非技术坑但重创本批次）：三-1 sibling 为「干净基线
   验证」把 14 个未 commit 文件 `git stash` 未 pop，我的 shell Part B 7 文件
   被定向抹掉两次；parent 从 stash 逐文件恢复。**教训**：多子 Agent 并发同
   工作区时，任何 git 写操作（stash/checkout）必须 parent 统一协调；幸存
   文件我备份到了 /tmp/san3-2-backup/。
5. **HMR 不能完全替代重启验证**：壳 service.ts 改动虽属 renderer，但插件
   激活期行为（坑 #1）只有整实例重启才暴露——「壳层改动建议重启确认」
   的任务要求完全正确。

## 改动文件清单（仅三-2 本批）

- `packages/desktop/src/client/editor/corum-editor.ts`（**新增**）
- `packages/desktop/src/client/index.ts`
- `packages/desktop/src/client/editor/EditorColumn.tsx`（注释）
- `packages/desktop/cordis.ide.patch.yml`（注释）
- `packages/plugins/session/corum-ui-chat/src/client/apply.ts`
- `packages/plugins/ui/corum-ide-ui/src/client/service.ts`
- `packages/plugins/ui/corum-ide-ui/src/client/AppFrame.tsx`
- `packages/plugins/ui/corum-ide-ui/src/client/index.tsx`
- `packages/plugins/ui/corum-ide-ui/src/client/SettingsShell.tsx`
- `packages/plugins/ui/corum-ide-ui/src/client/shell-contract.ts`
- `packages/plugins/ui/corum-ide-ui/src/client/settings/SettingsSections.tsx`
- `packages/plugins/ui/corum-ide-plugin-manager-ui/src/client/index.tsx`

（未 git add / commit，遵红线 5；SubagentCard.tsx、chat-runtime.ts 等是
三-3 sibling 的文件，非本批。）
