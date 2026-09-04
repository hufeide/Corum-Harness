/**
 * Package-owned invariant companion for `@corum/corum-credentials-local`.
 * @module @corum/corum-credentials-local/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

// fork（corum）：包名改为 corum 发行版名（其余与官方模板逐行一致）。
const PACKAGE_NAME = '@corum/corum-credentials-local'

/** Cordis companion plugin name. */
export const name = 'credentials-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the Service Definition companion (`dsh-credentials/invariant`) owns the
 * `credentials/reference-updated` lifecycle contract; this provider's file/environment layering is
 * asynchronous I/O pinned by its unit suite.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
