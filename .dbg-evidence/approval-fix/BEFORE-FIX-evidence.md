# 审批卡三缺陷 · 修复前真机取证（:9333，2026-09-14）

实例：PID 68611（沙箱外启动，监督侧重启）｜视口 1280×860｜会话 `corum-task-…`「SSH 配置并绕过沙箱限制」

## 触发链路（真实审批，非构造）

1. 工作区读写会话（访问模式 chip 实测 = `访问模式，当前：工作区读写`）
2. 提交提示词：工作区外写文件 `echo hi > /Users/kukucai/approval-probe-outside.txt`，
   并要求被拒后用 `sandbox_permissions: danger-full-access` + justification 重试同一条
3. 沙箱拒绝（`[sandbox: file access denied under workspace-write mode]`）→ 模型重试 → `approval/asked`
4. DOM 出现 `[data-approval-key="approval:1"]`；卡片文案 `escalate sandbox to danger-full-access: …`

## 症状 ①「下拉看不到、弹到更下方」——实测几何

| 元素 | x | y | w | h | bottom/right |
| --- | --- | --- | --- | --- | --- |
| viewport | — | — | 1280 | 860 | — |
| `[data-composer-seat]` | 301 | 622 | 970 | 238 | b=859 |
| `.ETobTG_card`（卡） | 446 | 630 | 680 | 218 | b=847 |
| `.allowChev`（▾ 触发器） | 1019 | 803 | 30 | 24 | b=827 |
| **`.allowMenu`（展开态）** | **982** | **854** | **129** | **86** | **b=940** |

- 菜单 `bottom=940` **超出视口底 860 共 80px** ⇒ 选项被裁掉，只剩顶部一两条。
- 菜单两个条目实测 y=861..896 / 898..933，同样落在视口外。
- 根因确认：`.allowMenu` 为 `bottom: -8px; transform: translateY(100%)` ⇒ **向下展开**，
  而 `.card` 底边（847）已贴近 seat 底（859）与视口底（860）。

## 症状 ②「遮挡输入框」——seat 的所有权与溢出

- 座位归属：`conversation.composer` 为 **chain + overlay:true**（`ConversationRoot.tsx:691-695`）。
  当选（审批卡）时官方 fallback **不卸载、改 `display:none` 隐藏**（ui-slots `ChainRenderOpts.overlay` 注释）。
- 实测祖先链：`ETobTG_root →[data-slot=conversation.composer] → T2KnVG_composerSeat(z-index:7, sticky bottom:0) → T2KnVG_scrollBody(overflow:hidden auto) → …`
- 把隐藏的 fallback 临时置回 `display:contents` 测得**两者共存时的真实堆叠**：
  seat 由 238→**408**，输入卡落在 y=452..614，审批卡仍在 y=622..859 ⇒ **卡正好占了输入框本该停靠的位置（座位底部）**。
- 结构约束：卡**在 seat 内部**，因此不可能做「卡与 seat 矩形不相交」；可达且有意义的口径是
  **卡与浮层都不得越过 seat 底边（= composer 自己的停靠位）向上/向下外溢**。
- 溢出通路：唯一向下外溢的元素就是 `.allowMenu`（854→940，已越 seat 底 859 与视口底 860）。
- ⚠️ 约束（决定了实现手段）：`.card` 带 `backdrop-filter: blur(20px) saturate(140%)`。
  实测把 `position:fixed; top:0; left:0` 的探针放进 `.card`，它渲染在 **(447,631) = 卡的原点**，
  而不是视口原点 (0,0)；放到 `body` 才在 (0,0)。
  ⇒ **`.card` 是 `position:fixed` 后代的包含块**（backdrop-filter 触发），
  `useAnchoredPosition` 返回的视口 fixed 坐标在此处会**二次偏移**，除非把菜单 portal 出卡片。

## 症状 ③「字号偏大」——实测计算值 vs 设计稿

| 选择器 | 实测 fontSize | 设计稿（design.pen frame `vP9D1`） |
| --- | --- | --- |
| `.who` | **15px** | 14 |
| `.tag` | **14px** | 13 |
| `.headline` | **15px** | 14 |
| `.allowMain` | **16px** | 15 |
| `.reject` | **16px** | 15 |
| `.command` | 13px | 14（mono 正文）※保持现状按任务书 |
| `.allowMenuItem` | 15px | 15 ✓ |

## 字号口径取证

- `--dsh-content-font-size: 14px` 挂在 **body**（inline style，由 `boot-theme.ts:21` 写），
  卡片可继承到；默认真实值 `14px`，`--dsh-content-font-size-secondary` 解析为 13px。
- 本仓 font-size 的既有写法是 `var(--dsh-content-font-size, 14px)` /
  `var(--dsh-content-font-size-secondary, 13px)`（`InputBar.module.css:57`、
  `MessageIconActions.module.css:15,23`、`ReasoningRow.module.css:61`）；
  `--dsh-content-font-delta` 在本仓只用于 **line-height / 宽高 / 间距**，从不用于 font-size。
- 实测 `calc(14px + var(--dsh-content-font-delta, 0px))` = 14px、`var(--dsh-content-font-size,14px)` = 14px（默认档一致）。
