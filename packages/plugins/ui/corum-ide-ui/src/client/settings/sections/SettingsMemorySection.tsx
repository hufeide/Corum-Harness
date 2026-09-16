/**
 * SettingsMemorySection — 记忆分区（PRD v2 §4.14：**19 项 / 6 分组**）。
 *
 * ⚠️ **本分区是「目标态清单」**：dsh 内核**没有任何记忆机制**
 * （无 memory 包；`compile.ts:432` 只留了 `TODO(memory)` 注入位），
 * 因此 19 项**一律「禁用 + 未上线」badge** —— 依据 PRD §6.1：
 * 「未就绪条目一律『禁用 + 标注未生效』，**禁止**保留『能点但不落盘』的形态」
 * （「展示一个不生效的开关比不展示更糟」）。
 *
 * ## 本轮（M1 · 信任修复）已清除的假数据（PRD §6.2）
 *
 * 删除前本文件硬编码了 **3 条假记忆**（原文见 PRD §6.2 表格），
 * 会被用户误当成自己的数据。
 * ⚠️ 此处**故意不复述假数据原文** —— 否则「全仓 grep 假数据 = 0」
 * 这条审计判据会被本注释自身命中，从而失去判据效力。
 *
 * 同时「启用记忆」由 `checked={true}` 改为 `checked={false}` ——
 * 默认勾选会**伪造用户数据**（让用户以为记忆已经开着并在沉淀）。
 * ⚠️ §6.2 明确「badge 盖不住假数据 ⇒ 必须直接删除」，故这里是**删除**而非标注。
 *
 * @module corum-ide-ui/client/settings/sections/SettingsMemorySection
 */

import { SettingGroup } from '../SettingGroup.tsx'
import { SettingRow } from '../SettingRow.tsx'
import { SelectField } from '../SelectField.tsx'
import { Switch } from '../Switch.tsx'
import { Badge } from '../Badge.tsx'
import { GlassButton } from '../shared.tsx'
import css from '../SettingsSections.module.css'

/* ── 记忆（PRD §4.14）──────────────────────────────────────────────── */

/** 未上线 badge（PRD §6.1：未就绪条目一律「禁用 + 标注未生效」）。 */
const OFFLINE = <Badge label="未上线" variant="offline" />

/** 空回调：下方所有控件均 `disabled`，此函数不可达，仅满足控件 props 必填。 */
const noop = () => { /* 控件已禁用，不可达 */ }

/**
 * Render the memory settings section (target-state list, all disabled).
 * @returns the memory section fragment.
 */
export function MemorySection() {
  return (
    <>
      <SettingGroup title="记忆">
        <SettingRow label="启用记忆" desc="是否允许 Agent 沉淀长期记忆（总开关）" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="记忆作用域" desc="仅当前会话 / 按 Agent（同一 Agent 跨会话共享）/ 全局共享" badge={OFFLINE}>
          <SelectField
            value="agent"
            disabled
            options={[{ id: 'session', label: '仅当前会话' }, { id: 'agent', label: '按 Agent' }, { id: 'global', label: '全局共享' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="存储位置" desc="记忆文件目录；留空 = 默认 ~/.corum/memory/<agentId>/" badge={OFFLINE} divider={false}>
          <input className={css.textInput} placeholder="默认路径" disabled />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="沉淀策略">
        <SettingRow label="自动沉淀" desc="任务完成后自动提取经验写入记忆" badge={OFFLINE}>
          <Switch checked={false} onChange={noop} disabled />
        </SettingRow>
        <SettingRow label="沉淀触发时机" desc="任务完成时 / 用户显式要求时 / 仅手动" badge={OFFLINE}>
          <SelectField
            value="done"
            disabled
            options={[{ id: 'done', label: '任务完成时' }, { id: 'explicit', label: '用户显式要求时' }, { id: 'manual', label: '仅手动' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="单次沉淀条数上限" desc="一次任务最多沉淀几条" badge={OFFLINE} divider={false}>
          <SelectField
            value="5"
            disabled
            options={[{ id: '3', label: '3 条' }, { id: '5', label: '5 条' }, { id: '10', label: '10 条' }]}
            onChange={noop}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="注入策略">
        <SettingRow label="注入时机" desc="每次会话开始 / 按相关性检索 / 不注入" badge={OFFLINE}>
          <SelectField
            value="relevance"
            disabled
            options={[{ id: 'session-start', label: '每次会话开始' }, { id: 'relevance', label: '按相关性检索' }, { id: 'never', label: '不注入' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="注入条数上限" desc="每次最多注入几条" badge={OFFLINE}>
          <SelectField
            value="10"
            disabled
            options={[{ id: '5', label: '5 条' }, { id: '10', label: '10 条' }, { id: '20', label: '20 条' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="注入预算（字符）" desc="注入内容的最大字符数" badge={OFFLINE}>
          <SelectField
            value="4000"
            disabled
            options={[{ id: '2000', label: '2000' }, { id: '4000', label: '4000' }, { id: '8000', label: '8000' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="注入位置" desc="注入到提示词的「工作经验」段（对应 compile.ts:432 预留位）" divider={false}>
          <span className={css.hintText}>只读</span>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="容量与清理">
        <SettingRow label="容量上限" desc="记忆总条数上限" badge={OFFLINE}>
          <SelectField
            value="500"
            disabled
            options={[{ id: '100', label: '100 条' }, { id: '500', label: '500 条' }, { id: '1000', label: '1000 条' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="超限策略" desc="淘汰最旧 / 淘汰最少使用 / 停止沉淀" badge={OFFLINE}>
          <SelectField
            value="lru"
            disabled
            options={[{ id: 'oldest', label: '淘汰最旧' }, { id: 'lru', label: '淘汰最少使用' }, { id: 'stop', label: '停止沉淀' }]}
            onChange={noop}
          />
        </SettingRow>
        <SettingRow label="保留时长" desc="超过 N 天自动淘汰（0 = 永久）" badge={OFFLINE} divider={false}>
          <SelectField
            value="0"
            disabled
            options={[{ id: '0', label: '0（永久）' }, { id: '30', label: '30 天' }, { id: '90', label: '90 天' }]}
            onChange={noop}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="记忆库">
        {/* M14：无真源 ⇒ 渲染空态，不伪造任何条目（§6.2）。 */}
        <div className={css.hintText}>暂无记忆。记忆机制尚未实现，此处不会显示任何条目。</div>
        <SettingRow label="单条操作" desc="查看全文 / 编辑 / 固定（不被淘汰）/ 删除" badge={OFFLINE}>
          <span className={css.hintText}>行内操作</span>
        </SettingRow>
        <SettingRow label="批量操作" desc="全选 / 删除所选" badge={OFFLINE}>
          <span className={css.hintText}>工具条</span>
        </SettingRow>
        <SettingRow label="清空全部记忆" desc="破坏性操作：需输入式确认（PRD §9.1）" badge={OFFLINE} divider={false}>
          <GlassButton variant="danger" disabled>清空全部</GlassButton>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="导入导出">
        <SettingRow label="导出记忆" desc="导出为 JSON（备份 / 迁移）" badge={OFFLINE}>
          <GlassButton disabled>导出</GlassButton>
        </SettingRow>
        <SettingRow label="导入记忆" desc="导入并选择「合并 / 覆盖」" badge={OFFLINE} divider={false}>
          <GlassButton disabled>导入</GlassButton>
        </SettingRow>
      </SettingGroup>
    </>
  )
}
