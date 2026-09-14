/**
 * @corum/corum-ui-chat test config.
 *
 * Minimal vitest config for the review-source unit tests. No decorator syntax
 * in the tested source, so no special pre-transform is needed (unlike
 * @corum/corum-subagent).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
