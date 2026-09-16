/**
 * SettingsPrivacySection — 隐私分区（PRD v2 §4.7）。
 *
 * ## 本轮（M1 · 信任修复）的两处修正
 *
 * 1. **「崩溃报告」由 `checked={true}` 改为 `checked={false}`** ——
 *    默认勾选会**伪造用户的同意**。PRD §6.1 特别点名隐私类：
 *    「展示一个不生效的开关比不展示更糟…… 用户会基于它做披露决策」。
 * 2. **原本的空回调死控件（能点但不落盘）一律改为 `disabled` +
 *    「未上线」badge**（PRD §6.2 + §6.1）。遥测开关的真实控制目前只在**环境变量**
 *    层（`DSH_TELEMETRY_DISABLED`，见 `boot.ts`），页面无写路径 ⇒ 属空壳。
 *
 * ⚠️ 本页所有条目均为**目标态**：待 M5「空壳逐项兑现」接入真源后再解禁。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsPrivacySection
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'

/* ── 隐私 ──────────────────────────────────────────────────────────── */

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：下方所有控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/**
 * Render the privacy settings section (all controls disabled pending real sources).
 * @returns the privacy section fragment.
 */
export function PrivacySection() {
  return (
    <>
      <SettingGroup title="数据与遥测">
        <SettingRow label="匿名使用统计" desc="帮助改进产品，不含任何代码内容" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="崩溃报告" desc="应用崩溃时自动发送报告" badge={OFFLINE} divider={false}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="敏感文件排除">
        <SettingRow label="排除模式" desc="匹配的文件不会被 Agent 读取或写入" badge={OFFLINE} divider={false}>
          <GlassButton disabled>编辑</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
