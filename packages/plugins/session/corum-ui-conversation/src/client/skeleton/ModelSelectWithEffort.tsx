/**
 * ModelSelectWithEffort —— 新建任务表单的「模型 + 推理等级」两级选择器
 *（2026-09-07 用户定调：所有模型都支持推理等级设置，选择模型的交互要统一）。
 *
 * 背景：composer 的模型选择器（corum-ui-model-selection ModelSelect）早已是
 *「模型 → 推理等级」两级面板（trigger 显示「模型 · 档位」）；但新建任务表单
 * 的模型字段一直是原生 `<select>` 平铺模型、**没有推理等级**——用户在这里
 * 无法为新任务指定推理档，与 composer 交互不统一。本组件把表单模型字段升级为
 * 与 composer 同形的两级面板。
 *
 * 交互（复刻 ModelSelect 的两级下钻）：
 *   - trigger 显示「模型名 · 档位名」（无 reasoning 的模型只显示模型名）；
 *   - 面板 root 层两个 cell：「模型」→ 模型列表子面板（按 provider 分组，
 *     menuitemradio + 选中勾）；「推理等级」→ 当前模型的档位子面板
 *     （仅当前模型有 reasoning 时出现）；
 *   - 选模型：提交 `provider/model`（档位跟随该模型 defaultEffort，保持
 *    「所选即所得」）；选档位：提交 `reasoningEffort`；
 *   - Esc 在子面板先返回 root、再关闭；点面板外部关闭。
 *
 * 数据：`groups` 来自 emptyActions.listModelCatalog（session/modelCatalog，
 * 与 composer 同源）；无 reasoning 的模型（如部分第三方路由）不显示推理等级
 * cell。样式由调用方 css 映射驱动（玻璃体系，与 Agent 二级菜单视觉一致）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { ModelCatalogModelOption, ModelProviderGroup } from '../contract/slots.ts'

/** 当前选中的完整模型路由（表单提交用）。 */
export interface ModelRouteSelection {
  provider: string
  model: string
  /** 推理档位 id（undefined = provider 默认 / 该模型无 reasoning）。 */
  reasoningEffort?: string
}

/** 组件需要的样式键（调用方 module CSS 提供）。 */
export interface ModelSelectCss {
  root: string
  trigger: string
  triggerName: string
  triggerEffort: string
  chevron: string
  panel: string
  cell: string
  cellLabel: string
  cellValue: string
  cellChevron: string
  backRow: string
  groupTitle: string
  list: string
  item: string
  itemName: string
  itemCheck: string
}

export function ModelSelectWithEffort({ groups, value, onChange, css, ariaLabel, disabled }: {
  groups: readonly ModelProviderGroup[]
  /** 当前选中（'' provider/model = 跟随 Agent 默认，由调用方解析）。 */
  value: ModelRouteSelection | null
  onChange: (sel: ModelRouteSelection) => void
  css: ModelSelectCss
  ariaLabel: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  const rootRef = useRef<HTMLDivElement>(null)

  /** 所有模型的平铺索引（provider/model → 模型实体 + provider 名）。 */
  const index = useMemo(() => {
    const map = new Map<string, { provider: ModelProviderGroup; model: ModelCatalogModelOption }>()
    for (const p of groups) for (const m of p.models) map.set(`${p.id}/${m.id}`, { provider: p, model: m })
    return map
  }, [groups])
  const current = value === null ? undefined : index.get(`${value.provider}/${value.model}`)
  const reasoning = current?.model.reasoning
  const effectiveEffort = value?.reasoningEffort ?? reasoning?.defaultEffort
  const effortName = reasoning === undefined
    ? undefined
    : reasoning.efforts.find((e) => e.id === effectiveEffort)?.name ?? effectiveEffort

  // 点面板外部 / Esc 关闭（Esc 在子面板先返回 root）。
  useEffect(() => {
    if (!open) { setPane('root'); return }
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (pane !== 'root') setPane('root')
      else setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, pane])

  const modelLabel = current?.model.name ?? (value === null ? '跟随 Agent 默认' : `${value.provider}/${value.model}`)

  const chooseModel = (provider: string, model: string): void => {
    // 选模型：档位跟随该模型 defaultEffort（保持「所选即所得」——与 composer
    // ModelSelect 的 sameRoute 语义一致，显式携带让表单提交可预测）。
    const target = index.get(`${provider}/${model}`)
    onChange({
      provider,
      model,
      ...(target?.model.reasoning?.defaultEffort === undefined ? {} : { reasoningEffort: target.model.reasoning.defaultEffort }),
    })
    setPane('root')
    setOpen(false)
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (value === null) return
    onChange({ provider: value.provider, model: value.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    setPane('root')
    setOpen(false)
  }

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled === true}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={css.triggerName}>{modelLabel}</span>
        {effortName !== undefined && <span className={css.triggerEffort}>· {effortName}</span>}
        <ChevronDown size={14} className={css.chevron} />
      </button>
      {open && (
        <div className={css.panel} role="menu" aria-label={ariaLabel}>
          {pane === 'root' && (
            <>
              <button type="button" role="menuitem" className={css.cell} onClick={() => setPane('model')}>
                <span className={css.cellLabel}>模型</span>
                <span className={css.cellValue}>{modelLabel}</span>
                <ChevronRight size={14} className={css.cellChevron} />
              </button>
              {reasoning !== undefined && (
                <button type="button" role="menuitem" className={css.cell} onClick={() => setPane('effort')}>
                  <span className={css.cellLabel}>推理等级</span>
                  <span className={css.cellValue}>{effortName}</span>
                  <ChevronRight size={14} className={css.cellChevron} />
                </button>
              )}
            </>
          )}
          {pane === 'model' && (
            <>
              <button type="button" className={css.backRow} onClick={() => setPane('root')}>
                <ChevronLeft size={14} /> 模型
              </button>
              <div className={css.list}>
                {groups.map((g) => (
                  <div key={g.id}>
                    <div className={css.groupTitle}>{g.name}</div>
                    {g.models.map((m) => {
                      const selected = value?.provider === g.id && value.model === m.id
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={selected}
                          data-active={selected || undefined}
                          className={css.item}
                          onClick={() => chooseModel(g.id, m.id)}
                        >
                          <span className={css.itemName}>{m.name}</span>
                          <span className={css.itemCheck}>{selected && <Check size={14} />}</span>
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}
          {pane === 'effort' && reasoning !== undefined && (
            <>
              <button type="button" className={css.backRow} onClick={() => setPane('root')}>
                <ChevronLeft size={14} /> 推理等级
              </button>
              <div className={css.list}>
                {reasoning.efforts.map((e) => {
                  const selected = effectiveEffort === e.id
                  return (
                    <button
                      key={e.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      data-active={selected || undefined}
                      className={css.item}
                      title={e.description}
                      onClick={() => chooseEffort(e.id)}
                    >
                      <span className={css.itemName}>{e.name}</span>
                      <span className={css.itemCheck}>{selected && <Check size={14} />}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
