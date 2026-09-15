import { type FontFamily } from '../ipc'

/**
 * The font families this machine has, and which of them hold the grid.
 *
 * Both answers come from Rust (`fontFamilies`): enumeration needs a platform
 * API neither webview exposes, and the monospace flag lives in the font file.
 *
 * `CANDIDATES` below is the fallback for a host whose font source is
 * unreachable, which is every test run.
 */
export interface MonoFont {
  name: string
  stack: string
}

/**
 * The fallback list, used only when Rust could not reach the font source.
 *
 * Adding a name here changes nothing on a machine where enumeration works, so
 * it is never the fix for "my font is missing".
 */
const CANDIDATES = [
  'JetBrains Mono',
  'Fira Code',
  'Fira Mono',
  'Cascadia Code',
  'Cascadia Mono',
  'IBM Plex Mono',
  'Source Code Pro',
  'Iosevka',
  'Hack',
  'Inconsolata',
  'Victor Mono',
  'Geist Mono',
  'Berkeley Mono',
  'Operator Mono',
  'Input Mono',
  'Menlo',
  'Monaco',
  'SF Mono',
  'Andale Mono',
  'Courier New',
  'Consolas',
  'Lucida Console',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Ubuntu Mono',
  'Noto Sans Mono',
  'Roboto Mono',
  'Droid Sans Mono',
  'Anonymous Pro',
  'Space Mono',
  'Red Hat Mono',
  'Nimbus Mono PS',
]

/** Always offered and always last: it cannot be absent. */
const SYSTEM: MonoFont = { name: 'System default', stack: 'monospace' }

/**
 * A family name as it belongs in a CSS stack, always quoted and escaped.
 *
 * The names come out of font files, so `Foo"Bar` and `A,B` are reachable.
 */
const quoted = (name: string) => `"${name.replace(/[\\"]/g, '\\$&')}"`

/**
 * The stack stored for a family: the family, then `monospace`.
 *
 * A stored value outlives the machine it was chosen on, and a family that has
 * gone missing must degrade to something fixed-width rather than to the
 * proportional default, which misaligns every column.
 */
export const stackFor = (name: string) => `${quoted(name)}, monospace`

type Ruler = (font: string) => number

/**
 * Whether a family resolves to a real face.
 *
 * Both measurements end in the **same** generic, so an absent family falls
 * through to it and the widths match exactly.
 *
 * A family whose metrics equal that generic stays indistinguishable from an
 * absent one, which is why `SYSTEM` is offered unconditionally.
 */
function isInstalled(name: string, measure: Ruler): boolean {
  return GENERICS.some(
    (generic) => measure(`${quoted(name)}, ${generic}`) !== measure(generic),
  )
}

/** Two, so a family matching one generic is still caught by the other. */
const GENERICS = ['monospace', 'serif']

/** Lays out a probe string and answers how wide it came out. */
function canvasRuler(): Ruler | null {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return null
  // Mixed widths at a large size, so a small per-glyph difference is not lost
  // to rounding.
  const probe = 'mmmmmmmmwwwwwwwwiiiiiiiil1I0Oo'
  return (font) => {
    context.font = `72px ${font}`
    return context.measureText(probe).width
  }
}

/**
 * The fallback picker: measured `CANDIDATES`, system default last.
 *
 * Answers with just the system default when nothing can be measured, which is
 * every test run.
 */
export function installedFonts(
  measure: Ruler | null = canvasRuler(),
): MonoFont[] {
  if (!measure) return [SYSTEM]
  const found = CANDIDATES.filter((name) => isInstalled(name, measure)).map(
    (name) => ({ name, stack: stackFor(name) }),
  )
  return [...found, SYSTEM]
}

/**
 * The families the picker offers for a terminal, system default last.
 *
 * The `monospaced` flag is read as given; Rust takes it from the font file.
 */
export const monospacedFonts = (families: FontFamily[]): MonoFont[] => [
  ...families.filter((family) => family.monospaced).map(offered),
  SYSTEM,
]

/** Every enumerated family, monospaced or not, system default last. */
export const everyFont = (families: FontFamily[]): MonoFont[] => [
  ...families.map(offered),
  SYSTEM,
]

const offered = (family: FontFamily): MonoFont => ({
  name: family.name,
  stack: stackFor(family.name),
})

/**
 * The family a stored stack names.
 *
 * A value that is not one of ours is kept and labelled, so opening Settings
 * never swaps the font in use.
 */
export function fontName(stack: string): string {
  if (stack === SYSTEM.stack) return SYSTEM.name
  const first = stack
    .split(',')[0]
    ?.trim()
    .replace(/^["']|["']$/g, '')
  return first || SYSTEM.name
}

/**
 * Every option the picker shows: what is available, plus the stored value when
 * that is something else, so opening Settings never changes the font in use.
 */
export function fontChoices(
  current: string,
  available: MonoFont[] = installedFonts(),
): MonoFont[] {
  // On the family, so a stack stored with a different fallback chain still
  // matches the font it names.
  const wanted = fontName(current)
  const known = available.find((font) => font.name === wanted)
  if (known) {
    // Offer the stored spelling under the installed font's name, so selecting
    // it again does not rewrite the setting for no reason.
    return available.map((font) =>
      font === known ? { ...font, stack: current } : font,
    )
  }
  return [...available, { name: `${wanted} (not installed)`, stack: current }]
}
