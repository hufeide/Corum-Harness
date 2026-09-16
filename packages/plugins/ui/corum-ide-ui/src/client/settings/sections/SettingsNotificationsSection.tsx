/**
 * SettingsNotificationsSection — 通知分区（PRD v2 §4.4）。
 *
 * ## 本轮（M1 · 信任修复）的修正
 *
 * 1. **「任务完成时通知」由 `checked={true}` 改为 `checked={false}`** ——
 *    默认勾选会让用户以为通知已开启，属伪造状态（PRD §6.1）。
 * 2. **原本的空回调死控件一律改为 `disabled` + 「未上线」badge**。
 *    ⚠️ 此处**故意不写出该回调的字面形式**：写了会让「全仓审计空回调」的脚本
 *    命中本注释自身（本项目已因此踩过四次同类问题）。
 *    通知的真实实现（系统通知权限申请、勿扰时段）尚无设置真源 ⇒ 属空壳。
 *
 * ⚠️ 本页所有条目均为**目标态**：待 M5「空壳逐项兑现」接线后再解禁。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsNotificationsSection
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'

/* ── 通知 ──────────────────────────────────────────────────────────── */

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：下方所有控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/**
 * Render the notifications settings section (all controls disabled pending real sources).
 * @returns the notifications section fragment.
 */
export function NotificationsSection() {
  return (
    <>
      <SettingGroup title="任务通知">
        <SettingRow label="任务完成时通知" desc="Agent 任务执行完毕时弹出提醒" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="通知声音" desc="通知到达时播放提示音" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="系统通知权限" desc="需在系统设置中允许 Corum 发送通知" badge={OFFLINE} divider={false}>
          <GlassButton disabled>去开启</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="勿扰">
        <SettingRow label="勿扰模式" desc="开启后不弹出任何通知" badge={OFFLINE} divider={false}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
