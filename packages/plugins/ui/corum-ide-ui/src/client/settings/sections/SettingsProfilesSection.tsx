/**
 * SettingsProfilesSection — 从 SettingsSections.tsx 拆出的独立 section 文件（重构 2）。
 */

import { Trash2 } from 'lucide-react'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 配置档案 ──────────────────────────────────────────────────────── */

export function ProfilesSection() {
  return (
    <>
      <div className={css.topRow}>
        <span className={css.topHint}>配置档案保存一整套设置，可随时切换或导入导出。</span>
        <div className={css.topActions}>
          <GlassButton>导入</GlassButton>
          <GlassButton variant="primary">+ 新建档案</GlassButton>
        </div>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>默认档案</span>
            <span className={css.currentBadge}>当前</span>
          </div>
          <span className={css.cardDesc}>3 个模型 · 深色主题</span>
        </div>
        <GlassButton>切换</GlassButton>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>前端</span>
          </div>
          <span className={css.cardDesc}>2 个模型 · 浅色主题 · 启用技能</span>
        </div>
        <div className={css.cardActions}>
          <GlassButton variant="primary">切换</GlassButton>
          <Trash2 size={16} className={css.memDel} />
        </div>
      </div>
      <div className={css.profileCard}>
        <div className={css.cardInfo}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>评审</span>
          </div>
          <span className={css.cardDesc}>1 个模型 · 只读权限</span>
        </div>
        <div className={css.cardActions}>
          <GlassButton variant="primary">切换</GlassButton>
          <Trash2 size={16} className={css.memDel} />
        </div>
      </div>
    </>
  )
}
