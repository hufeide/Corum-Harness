/**
 * SettingsProfilesSection — 配置档案分区（PRD v2 §10.2「暂不承诺」）。
 *
 * ## 本轮（M5 · 最后一个空壳分区）按 §6.1/§6.2 收口
 *
 * 原实现有两类问题：
 *
 * 1. **5 个死控件**：「导入」「+ 新建档案」与 3 个「切换」按钮，
 *    以及 2 个垃圾桶图标 —— **全部无 onClick、未禁用** ⇒ 点了什么都不会发生。
 *    按 §6.1「禁止保留『能点但不落盘』的形态」一律 `disabled` + badge。
 * 2. **3 张伪造的档案卡（§6.2）**：原文列出了三个并不存在的档案及其属性
 *    （各自「N 个模型 · 某主题 · 某权限」）。§6.2：badge 盖不住假数据 ⇒ **直接删除**。
 *    ⚠️ 此处**故意不复述那三个档案名与属性** —— 复述会让「grep 假数据 = 0」
 *    这条审计命中本注释自身而失效（本项目已因此踩过四次）。
 *
 * ## 为什么整页都是占位（PRD §10.2）
 *
 * 「配置档案」被归入**暂不承诺**：档案的保存/切换/导入导出需要一整套
 * 「设置快照与恢复」机制（含与 `settings.yaml` 整文件覆盖的边界，PRD §9.2），
 * 当前**没有任何真源**。故本页保留**形态**以说明未来有什么，
 * 但每一项都如实标注不可用、且**不显示任何编造的档案**。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsProfilesSection
 */

import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 配置档案 ──────────────────────────────────────────────────────── */

/** 即将上线 badge（真源待建，先占位展示）。 */
const SOON = <Badge label="即将上线" variant="soon" />

/**
 * 配置档案分区（目标态占位，全部标注即将上线）。
 *
 * @returns the profiles settings section.
 */
export function ProfilesSection() {
  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>
          配置档案将保存一整套设置，可随时切换或导入导出。
          ⚠️ 该能力**尚未实现**（PRD 归入「暂不承诺」）：需要先有「设置快照与恢复」机制，
          并定清它与整文件覆盖的边界。当前页面仅说明未来形态。
        </span>
        <div className={css.topActions}>
          <GlassButton disabled>导入</GlassButton>
          <GlassButton variant="primary" disabled>+ 新建档案</GlassButton>
        </div>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>暂无配置档案</span>
            {SOON}
          </div>
          <span className={css.cardDesc}>
            档案机制尚未实现，此处不会显示任何档案。已移除原先编造的示例档案。
          </span>
        </div>
        <GlassButton disabled>切换</GlassButton>
      </div>
    </>
  )
}
