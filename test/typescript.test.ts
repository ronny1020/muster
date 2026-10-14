import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'bun:test'

/**
 * The TypeScript the typecheck runs, pinned.
 *
 * `bun run check` is Bun's built-in checker, which matches one TypeScript
 * version compiled into Bun — so a Bun upgrade can change the language under
 * the code with no other line of the diff saying so. This makes it say so:
 * move the pin here, deliberately, when a new Bun moves it. A Bun too old to
 * have the checker fails here too, where `bun --check` alone would print its
 * help and exit 0.
 */
const PINNED_TYPESCRIPT = '7.0.2'

test('the typecheck runs the pinned TypeScript', () => {
  expect(process.versions.typescript).toBe(PINNED_TYPESCRIPT)
})

/**
 * The checker is whichever Bun runs the scripts, so that Bun has to be the one
 * `.bun-version` names — not an older one on `PATH`, nor a copy in
 * node_modules/.bin, which scripts would find first (see bunfig.toml). While
 * the pin is `canary` the version moves daily, so the build only has to be a
 * canary, and `PINNED_TYPESCRIPT` above is what catches a language change.
 */
test('scripts run the Bun that .bun-version pins', () => {
  const pinned = readFileSync(
    resolve(import.meta.dir, '../.bun-version'),
    'utf8',
  ).trim()
  if (pinned === 'canary') expect(Bun.version_with_sha).toContain('-canary.')
  else expect(process.versions.bun).toBe(pinned)
})
