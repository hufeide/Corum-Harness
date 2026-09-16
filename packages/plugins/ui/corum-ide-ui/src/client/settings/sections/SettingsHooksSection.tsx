/**
 * SettingsHooksSection — Hooks 与自动化分区（PRD v2 §4.12：**10 项 + 7 个事件**）。
 *
 * ⚠️ **机制当前完全不生效**（PRD §10.3 调研结论）：
 * `hooks-claude-code` 等三个上游包在**全仓无任何引用**（`dsh: {}`），
 * 即宿主从未挂载 ⇒ 本页**没有任何真源**，全部条目「禁用 + 未上线」。
 *
 * ## 本轮（M1 · 信任修复）已做的两处修正
 *
 * 1. **删除假说明**（§6.2）：原文声称钩子脚本存放在某个 `~/.corum/` 子目录
 *    并以某种脚本语言编写 —— 机制未挂载却在编故事，属必须删除的假数据。
 *    ⚠️ 此处**故意不复述假说明原文**，理由同 SettingsMemorySection：
 *    复述会让「全仓 grep 假数据 = 0」这条审计判据命中注释自身。
 * 2. **修正事件清单**：原 UI 列出 `PreToolUse` / `PostToolUse` / **`Notification`**，
 *    但 `Notification` **不是真实事件**（上游 `config.ts:10-18` 定义的 7 个事件里没有它），
 *    同时**漏掉** `SessionStart` / `UserPromptSubmit` / `Stop` / `SubagentStart` / `SubagentStop`。
 *    现按真实事件集完整列出 7 个，并标注各自的 matcher 适用性。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsHooksSection
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import css from '../SettingsSections.module.css'

/* ── Hooks 与自动化（PRD §4.12）────────────────────────────────────── */

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：下方所有控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/** 无 hook 时的占位选项。 */
const NONE_OPTIONS = [{ id: '0', label: '0 条' }] as const

/**
 * 真实事件集（上游 `hooks-claude-code/src/config.ts:10-18`，共 **7 个**）。
 * `matcher` 列标明该事件是否支持「适用对象」过滤 —— 不支持的留空即匹配全部。
 */
const EVENTS: readonly { name: string; desc: string; matcher: string }[] = [
  { name: 'SessionStart', desc: '会话开始时触发，可注入上下文', matcher: '不支持 matcher' },
  { name: 'UserPromptSubmit', desc: '用户提交提示词时触发，可拦截 / 改写', matcher: '不支持 matcher（上游会丢弃）' },
  { name: 'PreToolUse', desc: '工具执行前触发，可审批 / 拦截', matcher: '按工具名' },
  { name: 'PostToolUse', desc: '工具执行后触发，可自动检查', matcher: '按工具名' },
  { name: 'Stop', desc: 'Agent 停止响应时触发，可收尾 / 通知', matcher: '不支持 matcher' },
  { name: 'SubagentStart', desc: '子 Agent 启动时触发，可注入 / 审计', matcher: '按子 Agent 类型' },
  { name: 'SubagentStop', desc: '子 Agent 结束时触发，可校验 / 汇总', matcher: '按子 Agent 类型' },
]

/**
 * Render the Hooks settings section (target-state list, all disabled).
 * @returns the hooks section fragment.
 */
export function HooksSection() {
  return (
    <>
      <SettingGroup title="Hooks">
        <SettingRow label="启用 Hooks" desc="Hook 总开关；关闭后所有事件钩子不执行" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="配置来源" desc="本页管理 / 外部 hooks.json（需给路径）" badge={OFFLINE}>
          <SelectField
            value="inline"
            disabled
            options={[{ id: 'inline', label: '本页管理' }, { id: 'file', label: '外部 hooks.json' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="默认超时" desc="单条 hook 的默认超时（上游默认 600000 ms）" badge={OFFLINE} divider={false}>
          <SelectField
            value="600000"
            disabled
            options={[{ id: '60000', label: '60000 ms' }, { id: '600000', label: '600000 ms' }]}
            onChange={noop}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="事件钩子 · 7 个事件">
        {EVENTS.map((ev, i) => (
          <SettingRow
            key={ev.name}
            label={ev.name}
            desc={`${ev.desc} · ${ev.matcher}`}
            badge={OFFLINE}
            divider={i !== EVENTS.length - 1}
          >
            <SelectField value="0" disabled options={NONE_OPTIONS} onChange={noop} />
          </SettingRow>
        ))}
      </SettingGroup>

      <SettingGroup title="单条 Hook 字段">
        <SettingRow label="适用对象 matcher" desc="留空 = 匹配全部；仅 PreToolUse / PostToolUse / SubagentStart / SubagentStop 支持" badge={OFFLINE}>
          <input className={css.textInput} placeholder="留空 = 全部" disabled />
        </SettingRow>
        <SettingRow label="执行命令" desc="shell 命令，支持 ${PROJECT_DIR} 等占位" badge={OFFLINE}>
          <input className={css.textInput} placeholder="echo hook" disabled />
        </SettingRow>
        <SettingRow label="超时" desc="可选；留空继承全局默认" badge={OFFLINE}>
          <SelectField
            value="inherit"
            disabled
            options={[{ id: 'inherit', label: '继承默认' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="启用 / 禁用" desc="单条 hook 开关" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="删除" desc="移除该条 hook" badge={OFFLINE} divider={false}>
          <span className={css.hintText}>行内操作</span>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="说明">
        <p className={css.hintText}>
          共 7 个事件：SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop。
          仅 <strong>command 类</strong> hook 会执行。
          ⚠️ 机制当前**未挂载**（上游三个 hooks 包在全仓无任何引用），因此本页所有条目暂不可用。
        </p>
      </SettingGroup>
    </>
  )
}
