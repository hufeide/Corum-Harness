/**
 * SettingsNotificationsSection — 通知分区（PRD v2 §4.4）。
 *
 * ## M5「空壳逐项兑现」本期兑现（2026-09-16）
 *
 * | 项 | 状态 | 真源 |
 * |---|---|---|
 * | NO1 任务完成时通知 | ✅ **已接线** | `ctx.notifications` 偏好面 `enabled`（cordis 服务，跨 bundle 单例）|
 * | NO2 通知声音 | ✅ **已接线** | 偏好面 `sound`（WebAudio 合成短音，默认关）|
 * | NO3 系统通知权限 | ⏳ 仍未上线 | 依赖代码签名（host `NATIVE_NOTIFICATIONS_ENABLED=false` 刻意关闭，见 `desktop/src/client/index.ts`）|
 * | NO4 勿扰模式 | ✅ **已接线**（开关维度）| 偏好面 `dnd`；设计稿的**起止时段**属后续增量（PRD §4.4 NO4）|
 *
 * 写路径：设置页（corum-ide-ui bundle）经 `useNotificationPrefs()` 拿到
 * `ctx.notifications` 的偏好子面（React context 下发，cordis root
 * `reflect.store` 保证与 desktop toast 栈同一实例，红线 1 合规）——
 * 写入实时联动，无需刷新。服务缺席（非 desktop 壳）时控件回退为禁用 +
 * 未上线（PRD §6.1：未就绪条目一律标注，不留「能点但不落盘」的死控件）。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsNotificationsSection
 */

import { useSyncExternalStore } from 'react'
import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton, useNotificationPrefs } from '../shared.tsx'

/* ── 通知 ──────────────────────────────────────────────────────────── */

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/**
 * Render the notifications settings section.
 *
 * NO1/NO2/NO4 接真源（通知 cordis 服务偏好面）；NO3 依赖代码签名，保持未上线。
 * @returns the notifications section fragment.
 */
export function NotificationsSection() {
  const prefs = useNotificationPrefs()
  // uSES 订阅偏好快照：服务缺席时快照恒 null（getSnapshot 引用稳定，不会死循环）。
  const value = useSyncExternalStore(
    (listener) => prefs?.subscribePrefs(listener) ?? (() => {}),
    () => prefs?.getPrefs() ?? null,
  )
  const ready = prefs !== null && value !== null

  return (
    <>
      <SettingGroup title="任务通知">
        <SettingRow label="任务完成时通知" desc="Agent 任务执行完毕时弹出提醒" badge={ready ? undefined : OFFLINE}>
          <Switch
            checked={value?.enabled ?? false}
            onChange={(on) => { prefs?.setPrefs({ enabled: on }) }}
            disabled={!ready}
          />
        </SettingRow>
        <SettingRow label="通知声音" desc="通知到达时播放提示音" badge={ready ? undefined : OFFLINE}>
          <Switch
            checked={value?.sound ?? false}
            onChange={(on) => { prefs?.setPrefs({ sound: on }) }}
            disabled={!ready}
          />
        </SettingRow>
        <SettingRow label="系统通知权限" desc="需在系统设置中允许 Corum 发送通知" badge={OFFLINE} divider={false}>
          <GlassButton disabled>去开启</GlassButton>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="勿扰">
        <SettingRow label="勿扰模式" desc="开启后不弹出任何通知" badge={ready ? undefined : OFFLINE} divider={false}>
          <Switch
            checked={value?.dnd ?? false}
            onChange={(on) => { prefs?.setPrefs({ dnd: on }) }}
            disabled={!ready}
          />
        </SettingRow>
      </SettingGroup>
    </>
  )
}
