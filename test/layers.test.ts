import { expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * Enforces the layering rule AGENTS.md states: a module may import from a layer
 * strictly below its own, never sideways within one. There is no ESLint here,
 * so this is the only thing holding the rule in place.
 */
const LAYERS = ['shared', 'entities', 'features', 'widgets', 'app'] as const
type Layer = (typeof LAYERS)[number]

/** Layers with no slices: everything inside them may import everything else. */
const FLAT: Layer[] = ['app', 'shared']

const SRC = resolve(import.meta.dir, '..', 'src')

interface Module {
  file: string
  layer: Layer
  slice: string
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Which layer and slice a file belongs to, or `null` when it is outside both. */
function locate(file: string): Module | null {
  const parts = relative(SRC, file).split(/[/\\]/)
  const layer = parts[0] as Layer
  if (!LAYERS.includes(layer)) return null
  const slice = FLAT.includes(layer) ? '-' : (parts[1] ?? '-')
  return { file, layer, slice }
}

/** The file an import specifier names, following the extensions we use. */
function target(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* not this extension */
    }
  }
  return null
}

const modules = walk(SRC)
  .map(locate)
  .filter((m): m is Module => m !== null)

const edges = modules.flatMap((module) => {
  const source = readFileSync(module.file, 'utf8')
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((match) => target(module.file, match[1]!))
    .filter((path): path is string => path !== null)
    .map(locate)
    .filter((to): to is Module => to !== null)
    .map((to) => ({ from: module, to }))
})

const name = (m: Module) =>
  `${relative(SRC, m.file)} (${m.layer}${m.slice === '-' ? '' : `/${m.slice}`})`

test('every import points strictly downward through the layers', () => {
  const upward = edges
    .filter(
      ({ from, to }) => LAYERS.indexOf(to.layer) > LAYERS.indexOf(from.layer),
    )
    .map(({ from, to }) => `${name(from)} -> ${name(to)}`)
  expect(upward).toEqual([])
})

test('no slice imports a sibling slice on its own layer', () => {
  const sideways = edges
    .filter(
      ({ from, to }) =>
        from.layer === to.layer &&
        !FLAT.includes(from.layer) &&
        from.slice !== to.slice,
    )
    .map(({ from, to }) => `${name(from)} -> ${name(to)}`)
  expect(sideways).toEqual([])
})

test('the layout is actually being read, so a passing suite means something', () => {
  // Guards against the walk silently finding nothing after a move.
  expect(modules.length).toBeGreaterThan(40)
  expect(edges.length).toBeGreaterThan(40)
  expect(new Set(modules.map((m) => m.layer)).size).toBe(LAYERS.length)
})

test('every relative import resolves, so no edge can vanish from the graph', () => {
  // The failure this guards against is silent: an unresolved specifier was
  // filtered out, so the rule stopped applying to it instead of failing.
  const unresolved = walk(SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]!)
      .filter((spec) => spec.startsWith('.') && target(file, spec) === null)
      .map((spec) => `${relative(SRC, file)} -> ${spec}`),
  )
  expect(unresolved).toEqual([])
})

test('no import bypasses the checker through a path alias', () => {
  // Every rule here follows relative specifiers only. Adding a `@/` alias —
  // the obvious answer to the deep relative paths — would reduce all of them to
  // no-ops while they carried on passing, so the alias has to arrive with a
  // resolver rather than quietly.
  const aliased = walk(SRC).flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)]
      .map((match) => match[1]!)
      // `@scope/pkg` is an npm package; `@/…`, `~/…` and `src/…` are aliases.
      .filter((spec) => /^@\/|^~\/|^src\//.test(spec))
      .map((spec) => `${relative(SRC, file)} -> ${spec}`),
  )
  expect(aliased).toEqual([])
})
