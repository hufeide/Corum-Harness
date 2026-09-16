/**
 * @corum/corum-session-archive test config.
 *
 * Mirrors @corum/corum-ui-chat's minimal config (the tested source has no
 * decorator syntax, so no special pre-transform is needed).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
