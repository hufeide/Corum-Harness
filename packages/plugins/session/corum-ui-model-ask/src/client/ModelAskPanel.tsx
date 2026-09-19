/**
 * ModelAskPanel —— 子 Agent 模型不可用的决定面板（design.pen jO5So「方案C」）。
 *
 * 两态就地切换，**不跳转、不弹模态**：
 *   ① 收起态 notify-bar：unplug 图标 + 两行文案 + 「处理」+ ×（挂起）
 *   ② 展开态 panel-expanded：phead(unplug + 标题 + chevron-up)
 *      → chips（四档位）→ picker(cpu + 文案 + chevron-down) → pfoot(hint + 应用并继续)
 *
 * 与提问卡（QuestionCard）的关键差别：**一轮完成**。官方提问流要两轮问答（先问处理方式，
 * 选「永久改为指定模型」再弹第二轮模型选择），方案 C 把模型选择内嵌进同一个面板。
 *
 * 图标名逐项取自设计稿的 `icon` 属性（lucide 库）：unplug / zap / link / repeat / ban /
 * cpu / chevron-up / chevron-down / x —— 不按语义猜（猜会得到 AlertTriangle、Check 这类
 * 形状对不上的图标）。档位文案由 host 下发（`request.options`），本组件不硬编码。
 */
import { useState } from 'react'
import {
  Ban,
  ChevronDown,
  ChevronUp,
  Cpu,
  Link as LinkIcon,
  Repeat,
  Unplug,
  X,
  Zap,
} from 'lucide-react'
import {
  modelAskAnswerOf,
  modelAskNeedsRoute,
  type ModelAskCatalogProvider,
  type ModelAskKind,
  type PendingModelAsk,
} from './contract.ts'
import css from './ModelAskPanel.module.css'

export interface ModelAskPanelProps {
  pending: PendingModelAsk
}

/** 选中的路由（内嵌模型选择的内部状态）。 */
interface PickedRoute {
  provider: string
  model: string
  label: string
}

/**
 * 档位图标（**设计稿逐项指定**，不是按语义猜）。
 *
 * 为什么写死映射而不是用「看起来像」的图标：设计稿给的是 lucide 具体名
 * （zap / link / repeat / ban），按语义猜会得到形状完全不同的图标
 * （曾用 Check / ChevronRight / X，与设计稿对不上）。
 */
const CHIP_ICON: Readonly<Record<ModelAskKind, typeof Zap>> = {
  'temporary': Zap,
  'permanent-follow': LinkIcon,
  'permanent-route': Repeat,
  'decline': Ban,
}

/**
 * 内嵌模型选择：**行恒常显示，只有列表按需展开**。
 *
 * 为什么行不能藏（设计稿判据）：`picker` 是 `panel-expanded` 的固定子节点，其 lbl 原文
 * 「指定模型：选『永久改指定模型』时展开选择」本身就是「此刻收起、选了才展开」的说明——
 * 设计稿把说明写在行上，正是因为行一直看得见。整行按档位隐藏会让面板少一块、高度抖动。
 */
function ModelPicker({ catalog, picked, open, onToggle, onPick }: {
  catalog: readonly ModelAskCatalogProvider[]
  picked: PickedRoute | undefined
  open: boolean
  onToggle: () => void
  onPick: (route: PickedRoute) => void
}) {
  return (
    <>
      <button type="button" className={css.picker} onClick={onToggle}>
        <span className={css.pickerGlyph}><Cpu size={11} /></span>
        <span className={css.pickerLabel}>
          {picked === undefined
            ? '指定模型：选『永久改指定模型』时展开选择'
            : `${picked.label}（${picked.provider}/${picked.model}）`}
        </span>
        <span className={css.pickerGlyph}>
          {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </span>
      </button>
      {open && (
        <div className={css.pickerList}>
          {catalog.length === 0 && <div className={css.pickerEmpty}>没有可用的模型</div>}
          {catalog.map(provider => (
            <div key={provider.provider}>
              <div className={css.pickerGroup}>{provider.label}</div>
              {provider.models.map(model => {
                const active = picked?.provider === provider.provider && picked?.model === model.model
                return (
                  <button
                    key={`${provider.provider}/${model.model}`}
                    type="button"
                    className={active ? `${css.pickerRow} ${css.pickerRowActive}` : css.pickerRow}
                    onClick={() => onPick({
                      provider: provider.provider,
                      model: model.model,
                      label: `${provider.label} / ${model.label}`,
                    })}
                  >
                    <span className={css.pickerModel}>{model.label}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/**
 * 决定面板。
 * @param props - 待决定项。
 */
export function ModelAskPanel({ pending }: ModelAskPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [kind, setKind] = useState<ModelAskKind | undefined>(undefined)
  const [picked, setPicked] = useState<PickedRoute | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const { request } = pending

  const needsRoute = modelAskNeedsRoute(kind)
  // 「永久改指定模型」必须真的选了一个模型才能应用（否则回传 dismissed = 什么都没变，
  // 却让用户以为已经处理好了）。
  const canApply = kind !== undefined && (!needsRoute || picked !== undefined) && !applying

  const apply = (): void => {
    if (!canApply) return
    setApplying(true)
    void pending.answer(modelAskAnswerOf(kind, picked === undefined
      ? undefined
      : { provider: picked.provider, model: picked.model }))
  }

  if (!expanded) {
    return (
      <div className={css.shell}>
        <div className={css.bar} role="status">
          <span className={css.barIcon}><Unplug size={14} /></span>
          <span className={css.barTx}>
            <span className={css.barTitle}>子 Agent 模型不可用 · 任务已暂停</span>
            <span className={css.barDesc}>{request.label} · {request.cause}</span>
          </span>
          <button type="button" className={css.handleBtn} onClick={() => setExpanded(true)}>处理</button>
          <button
            type="button"
            className={css.iconBtn}
            title="稍后处理"
            aria-label="稍后处理"
            onClick={() => { void pending.dismiss() }}
          >
            <X size={12} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={css.shell}>
      <div className={css.panel} role="dialog" aria-label="模型不可用，选择处理方式">
        <div className={css.phead}>
          <span className={css.pheadIcon}><Unplug size={15} /></span>
          <span className={css.pheadTx}>模型不可用，选择处理方式</span>
          <button
            type="button"
            className={css.pheadChev}
            aria-label="收起"
            onClick={() => setExpanded(false)}
          >
            <ChevronUp size={14} />
          </button>
        </div>

        <div className={css.chips}>
          {request.options.map(option => {
            const Icon = CHIP_ICON[option.kind]
            const active = kind === option.kind
            return (
              <button
                key={option.kind}
                type="button"
                className={active ? `${css.chip} ${css.chipActive}` : css.chip}
                title={option.description}
                onClick={() => setKind(option.kind)}
              >
                <span className={css.chipIcon}><Icon size={11} /></span>
                {option.label}
              </button>
            )
          })}
        </div>

        {/* picker 行恒常显示（设计稿的 panel-expanded 固定子节点）；列表按需展开。 */}
        <ModelPicker
          catalog={request.catalog}
          picked={picked}
          open={pickerOpen}
          onToggle={() => setPickerOpen(v => !v)}
          onPick={setPicked}
        />

        <div className={css.pfoot}>
          <span className={css.footHint}>挂起后可从子 Agent 卡片随时恢复处理</span>
          <button type="button" className={css.applyBtn} disabled={!canApply} onClick={apply}>
            {applying ? '应用中…' : '应用并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}
