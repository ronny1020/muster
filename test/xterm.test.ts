import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Pins that the fields an addon names on `terminal._core` exist on that core.
 *
 * The addons ship on their own version lines, none declares a peer range tight
 * enough to catch a mismatch, and they reach into private fields — so a field
 * renamed upstream reads as `undefined` and throws only on the line that
 * touches it, never at install, typecheck or render.
 *
 * Scope: the literal `_core.x` spelling only — four of webgl's reads, none of
 * fit's. The bundles are minified and most reads compile to an alias
 * (`const e = this._terminal._core`), which needs a parser to follow. Read a
 * green run as "the direct reads agree".
 */
const MODULES = resolve(import.meta.dir, '..', 'node_modules', '@xterm')

function bundle(pkg: string): string {
  const lib = join(MODULES, pkg, 'lib')
  return readdirSync(lib)
    .filter((entry) => entry.endsWith('.js') || entry.endsWith('.mjs'))
    .map((entry) => readFileSync(join(lib, entry), 'utf8'))
    .join('\n')
}

const coreReads = (source: string): string[] => [
  ...new Set(
    [...source.matchAll(/_core\s*\.\s*(_?[\w$]+)/g)].map((match) => match[1]),
  ),
]

/** `$` is legal in an identifier and anchors end-of-input in a pattern. */
const escaped = (field: string) => field.replace(/[$.*+?^{}()|[\]\\]/g, '\\$&')

/**
 * Whether the core bundle defines this field.
 *
 * Anchored to a property position, since the core is 280 KB of minified source
 * where short names occur inside longer identifiers. Proves the name exists
 * somewhere in the bundle, not that it hangs off `_core`.
 */
const defines = (core: string, field: string): boolean =>
  new RegExp(`[.'"\`]${escaped(field)}\\b|\\b${escaped(field)}\\s*[:=]`).test(
    core,
  )

const core = bundle('xterm')
const addons = readdirSync(MODULES).filter((entry) =>
  entry.startsWith('addon-'),
)

/** Only the addons whose reads this pattern can actually see. */
const reaching = addons.filter((addon) => coreReads(bundle(addon)).length > 0)

test.each(reaching)('%s names only core fields this xterm has', (addon) => {
  const missing = coreReads(bundle(addon)).filter(
    (field) => !defines(core, field),
  )
  expect(missing).toEqual([])
})

test.each([
  ['addon-webgl', '_renderService'],
  ['addon-image', '_inputHandler'],
])('the scan still sees what %s reads', (addon, field) => {
  // Guards the guard: an addon whose next build hides its reads behind an
  // alias drops out of `reaching` and takes its coverage with it, silently.
  // Both are named because webgl is pinned and cannot drift, so it is the
  // wrong one to rely on alone.
  expect(reaching).toContain(addon)
  expect(coreReads(bundle(addon))).toContain(field)
})
