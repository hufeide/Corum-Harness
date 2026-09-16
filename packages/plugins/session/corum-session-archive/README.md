# @corum/session-archive

corum Agent OS 桌面端的「会话日志归档」UI 插件（Web-only client 插件）：

- **保存日志到…**：**入口在会话栏的会话行右键菜单**（2026-09-16 用户定调，从会话头部右上角搬过去；
  菜单位于 `@corum/corum-ide-sidebar-ui` 的 SessionsPane，它经本包 provide 的 cordis 服务
  `sessionArchive` 拿保存能力）。动作本身仍在本包的 `SessionArchiveController.save()`，
  经 `window.corumDesktop.saveSessionLog(sessionId)` 走原生保存对话框把会话日志 ZIP 写盘。
  **结果反馈 Modal 由本包渲染**，挂在根级 `shell.overlay` 槽（与触发它的菜单解耦）；
  取消原生对话框时静默（不弹窗）。
- **导入会话日志**：注册到 `settings.general.item` slot，点击调用 `window.corumDesktop.importSessionLog()`，通过原生打开对话框（可多选）导入 ZIP 中的 session artifact，并展示 imported / skipped 列表。

两个入口都是桌面原生桥（不走 RPC），非桌面环境（`window.corumDesktop` 缺失）时导入按钮禁用并提示「仅桌面端可用」。

> 历史：保存入口曾挂在 `conversation.session.header.utilities`（会话头部右上角按钮）。
> 2026-09-16 按用户要求搬到会话行右键菜单；本次是**搬入口**、不是删能力
> （P0-2 于 2026-09-14 恢复的「保存到…」仍可用，只是换位置）。
> 「删除会话」按钮的移除裁决（733d3b70）不受影响，仍未恢复。

## 测试

```bash
pnpm --filter @corum/corum-session-archive run test
```

`tests/save-session.spec.ts` 覆盖保存动作的调用契约（用**传入的那个会话 id**、并发同 id 复用、
取消静默、失败出弹窗、dispose 语义）；`tests/save-dialog-host.spec.ts` 覆盖宿主的选取语义
（多条 open 时取最新、逐条消解、选择器只返回原始值以防无限重渲染）。
⚠️ 这一层**必须**用单测：真机上 `window.corumDesktop` 是冻结对象，无法拦截保存调用做断言。

## 构建

```bash
pnpm --filter @corum/session-archive run build
```

产出 `lib/client.js`（CJS + `window.__ModuleLoader__.load({id, factory})` 包裹，id 为 `@corum/session-archive`）。
