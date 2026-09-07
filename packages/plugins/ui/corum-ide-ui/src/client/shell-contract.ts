/**
 * Settings shell contract — the types of the `sidebar.settings` occupant this
 * plugin renders. Self-contained fork of the official
 * ui-settings-general/src/client/shell-contract.ts: the same shapes, but with
 * no import of the official settings packages (that package is disabled in IDE
 * mode; cross-plugin collaboration goes through the slot ledger, never a value
 * import).
 */
import type {
  HostObservable, InjectFace, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the settings shell (assembled in
 * apply): the ledger's nav-row projection as a hooks-compartment source —
 * the shell reads no locale state and subscribes through the bound hook.
 * The `t` binding is the settings-namespace locale binder (search/scope labels).
 */
export type SettingsRootInjected = {
  hooks: {
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
  /** Locale binder for the settings namespace (search/scope/close labels). */
  t: (key: string) => string
  /**
   * 打开插件中心市场浮层（直通 LayoutController.openPluginManager → grid
   * actions 订阅面；「发现更多插件」入口经 SectionNavContext 下发到 section
   * 组件——统一事件中心三-2 服务化，原 CustomEvent 广播已退役）。
   */
  openPluginManager: () => void
}

/**
 * Full component props of the settings shell root: the sidebar owner share
 * (wide/rail state) plus the declared render shares and the injected face
 * (hooks compartment bound to useSections). No store is registered — modal
 * open state and active section id are component-local viewing state.
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected>
