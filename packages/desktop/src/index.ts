/**
 * @corum-desktop — the desktop-surface bundle's runtime glue plugin plus the
 * bundle patch (`cordis.patch.yml`, declared by `dsh.bundle.patch`). The
 * plugin registers the desktop surface prompt sections and the shell-visible
 * `DSH_CORUM_DESKTOP` runtime variable. The transport rows (corum-desktop-modules,
 * corum-desktop-connection) and the Electron main process live in sibling subpath
 * entries of this package.
 * @module corum-desktop
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { addHarnessSourceSection } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell-env'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'corum-desktop-app'

/** This dsh installation's root, from either this package's source or built entry. */
const SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** Environment variable naming this desktop surface to the model's shell. */
const DSH_CORUM_DESKTOP = 'DSH_CORUM_DESKTOP' as const

/** Model-visible orientation for sessions created through the desktop app. */
function desktopSurfacePrompt(): string {
  return 'You are interacting with the user through the Corum desktop application. '
    + 'The application is a native window; there is no browser tab and no URL to reload. '
    + 'Files the user asks you to open or create land on the host machine through the same '
    + 'filesystem and approval stack as every other dsh surface.'
}

/**
 * Mount the desktop runtime glue: surface prompt sections and the shell
 * variable. The webServer shim (0.1.2 legacy) is retired — the real
 * @deepseek-ai/dsh-host-webserver Service provides `webServer` in the composed
 * tree, and no desktop row calls `tapIndex` anymore.
 * @param ctx - plugin context (no required services; prompt sections wait for
 * the systemPrompt service and the shell variable for shellEnv).
 */
export function apply(ctx: Context): void {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    addHarnessSourceSection(promptCtx, SOURCE_ROOT)
    promptCtx.systemPrompt.section({
      name: 'app:desktop-surface',
      order: -98,
      text: () => desktopSurfacePrompt(),
    })
  })
  ctx.inject(['shellEnv'], (runtimeCtx) => {
    runtimeCtx.shellEnv.register({
      name: 'corum-desktop-runtime',
      variables: {
        [DSH_CORUM_DESKTOP]: { description: 'Set to "1" when this session runs inside the Corum desktop application.' },
      },
      resolve: () => ({ [DSH_CORUM_DESKTOP]: '1' }),
    })
  })
}
