/**
 * Monospace families this machine actually has.
 *
 * There is no API that enumerates installed fonts in either webview this app
 * runs in: Chromium's `queryLocalFonts` needs a permission prompt and does not
 * exist in WKWebView at all. So availability is *measured* — a probe string is
 * laid out in `<candidate>, <generic>` and again in `<generic>` alone, and a
 * difference in width means the candidate resolved to a real face rather than
 * falling through. See `isInstalled` for why both stacks must end in the same
 * generic.
 *
 * That makes the list a filter over known monospace families rather than a
 * true enumeration: a family nobody thought to list stays invisible however
 * installed it is.
 */
export interface MonoFont {
  name: string
  stack: string
}

/**
 * Families worth asking about: those shipped with macOS, Windows and the common
 * Linux desktops, plus the programming faces people install on purpose. Adding
 * a name here costs one measurement.
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

/**
 * Always offered, and always last: whatever the webview itself calls
 * `monospace`. It needs no detection because it cannot be absent, and it is
 * the honest answer for someone who wants their system default rather than a
 * named face.
 */
const SYSTEM: MonoFont = { name: 'System default', stack: 'monospace' }

/** A family name as it belongs in a CSS stack. */
const quoted = (name: string) => (/\s/.test(name) ? `"${name}"` : name)

/**
 * The stack stored for a family: the family, then `monospace`.
 *
 * The fallback is not decoration — a stored value outlives the machine it was
 * chosen on, through a synced profile or a moved home directory, and a family
 * that has gone missing must degrade to something fixed-width rather than to
 * the proportional default, which misaligns every column in the grid.
 */
export const stackFor = (name: string) => `${quoted(name)}, monospace`

/**
 * Whether a family resolves to a real face.
 *
 * Both measurements must end in the **same** generic, and that is the whole
 * trick: an absent family then falls through to that generic and the widths
 * match exactly. Ending the candidate's stack in a family that cannot exist
 * instead — which this did at first — makes an absent candidate fall back to
 * the engine's own last-resort face, which is *proportional*, so every missing
 * family measured differently from the monospace baseline and was reported
 * installed while the platform's real monospace was reported missing.
 *
 * The residual limit, which no variant of this can fix: a family whose metrics
 * are identical to the generic — usually because it *is* the generic — is
 * indistinguishable from an absent one. That is why `SYSTEM` is offered
 * unconditionally rather than probed.
 */
function isInstalled(name: string, measure: (font: string) => number): boolean {
  return GENERICS.some(
    (generic) => measure(`${quoted(name)}, ${generic}`) !== measure(generic),
  )
}

/**
 * Two generics, because one is not enough: a family that happens to match
 * `monospace` exactly may still differ from `serif`, and vice versa. A family
 * only counts as absent when it matches every baseline.
 */
const GENERICS = ['monospace', 'serif']

/** Lays out a probe string and answers how wide it came out. */
function canvasRuler(): ((font: string) => number) | null {
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
 * Installed monospace families, in the order `CANDIDATES` lists them, with the
 * system default last.
 *
 * Answers with just the system default when nothing can be measured — a
 * canvas-less environment, which is every test run — because a picker with no
 * options is worse than one holding the option that always works.
 */
export function installedFonts(
  measure: ((font: string) => number) | null = canvasRuler(),
): MonoFont[] {
  if (!measure) return [SYSTEM]
  const found = CANDIDATES.filter((name) => isInstalled(name, measure)).map(
    (name) => ({ name, stack: stackFor(name) }),
  )
  return [...found, SYSTEM]
}

/**
 * The name to show for a stored stack.
 *
 * A value that is not one of ours is kept rather than replaced: it was set by
 * hand or by an older build, and silently swapping someone's font is worse
 * than an option labelled for what it is.
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
 * Every option the picker should show: what is installed, plus the stored
 * value when that is something else, so opening Settings never silently
 * changes the font a session is already using.
 */
export function fontChoices(
  current: string,
  available: MonoFont[] = installedFonts(),
): MonoFont[] {
  // Matched on the family rather than the whole stack: an older build stored a
  // longer fallback chain for the same font, and comparing strings would label
  // it "(not installed)" on a machine that has it.
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
