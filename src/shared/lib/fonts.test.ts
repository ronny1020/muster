import { expect, test } from 'bun:test'

import {
  type MonoFont,
  everyFont,
  fontChoices,
  fontName,
  installedFonts,
  monospacedFonts,
  stackFor,
} from './fonts'

/**
 * A ruler that models what an engine actually does: it lays out the first
 * family in the stack that resolves, and falls through to its own last-resort
 * face — which is proportional — when none does.
 *
 * The previous version read only `families[0]`, which is behaviour no engine
 * has, and it is why it could not see a probe whose two measurements ended in
 * different fallbacks.
 */
const GENERIC_WIDTH: Record<string, number> = { monospace: 100, serif: 111 }

/** Menlo deliberately matches `monospace` — on macOS it *is* the generic. */
const FAMILY_WIDTH: Record<string, number> = {
  Menlo: 100,
  Consolas: 120,
  'Courier New': 130,
}

/** Anything that resolves to nothing at all: the proportional default. */
const LAST_RESORT = 90

const rulerWith =
  (present: string[]) =>
  (font: string): number => {
    const families = font.split(',').map((f) => f.replace(/"/g, '').trim())
    for (const family of families) {
      if (present.includes(family)) return FAMILY_WIDTH[family] ?? 150
      if (family in GENERIC_WIDTH) return GENERIC_WIDTH[family]
    }
    return LAST_RESORT
  }

test('an absent family is not offered', () => {
  // The bug this replaces reported *every* candidate installed, because the
  // two measurements ended in different fallbacks.
  const found = installedFonts(rulerWith(['Consolas']))
  expect(found.map((font) => font.name)).toContain('Consolas')
  expect(found.map((font) => font.name)).not.toContain('Fira Code')
})

test('a family whose metrics match a generic is still found via the other', () => {
  // Menlo is the generic monospace on macOS, so a single-baseline probe called
  // it missing. It differs from `serif`, which is why there are two.
  const found = installedFonts(rulerWith(['Menlo']))
  expect(found.map((font) => font.name)).toContain('Menlo')
})

test('the system default is always offered, even when nothing is installed', () => {
  // A picker with no options is worse than one holding the option that cannot
  // be absent.
  expect(installedFonts(rulerWith([]))).toEqual([
    { name: 'System default', stack: 'monospace' },
  ])
})

test('a machine with no canvas still yields a usable picker', () => {
  // Which is every test run, and any environment where a 2d context is
  // refused.
  expect(installedFonts(null).map((font) => font.name)).toEqual([
    'System default',
  ])
})

test('every offered stack ends in monospace', () => {
  // A stored family that has gone missing must degrade to something
  // fixed-width; falling back to the proportional default misaligns every
  // column in the grid, which reads as a rendering bug.
  for (const font of installedFonts(rulerWith(['Courier New']))) {
    expect(font.stack.endsWith('monospace')).toBe(true)
  }
})

test('every family name is quoted, and quotes inside it escaped', () => {
  // Always quoted, not only when the name holds a space. The names come out of
  // font files now rather than a hardcoded list, and an unquoted `Foo"Bar` or a
  // bare `A,B` broke the declaration or silently became two families.
  expect(stackFor('Courier New')).toBe('"Courier New", monospace')
  expect(stackFor('Menlo')).toBe('"Menlo", monospace')
  expect(stackFor('Foo"Bar')).toBe('"Foo\\"Bar", monospace')
  expect(stackFor('A,B')).toBe('"A,B", monospace')
  expect(stackFor('Back\\slash')).toBe('"Back\\\\slash", monospace')
})

test('a stored font that is no longer installed is kept and labelled', () => {
  // Someone moves to a machine without their font: the picker must not
  // silently switch the terminal they are looking at to something else.
  const available: MonoFont[] = [{ name: 'Menlo', stack: stackFor('Menlo') }]
  const choices = fontChoices('"Berkeley Mono", monospace', available)
  expect(choices).toHaveLength(2)
  expect(choices[1].name).toBe('Berkeley Mono (not installed)')
  expect(choices[1].stack).toBe('"Berkeley Mono", monospace')
})

test('a stored font that is installed adds no extra option', () => {
  const available: MonoFont[] = [{ name: 'Menlo', stack: stackFor('Menlo') }]
  expect(fontChoices(stackFor('Menlo'), available)).toHaveLength(1)
})

test('the system default is never reported as not installed', () => {
  // It is the one stack detection cannot fail to offer, so it must never be
  // the thing the picker apologises for.
  expect(fontChoices('monospace', installedFonts(rulerWith([])))).toHaveLength(
    1,
  )
})

test('the system stack is named rather than shown as a raw value', () => {
  expect(fontName('monospace')).toBe('System default')
  expect(fontName('"Fira Code", monospace')).toBe('Fira Code')
  expect(fontName('')).toBe('System default')
})

const family = (name: string, monospaced: boolean) => ({ name, monospaced })

test('only the families Rust marked monospaced are offered', () => {
  // The flag is read, never re-derived. Deciding it here is what put 60 of
  // this machine's 248 families in the picker: a face with no Latin glyphs
  // substitutes for every probe and measures as fixed-pitch.
  const found = monospacedFonts([
    family('Menlo', true),
    family('Helvetica', false),
    family('PT Mono', true),
    family('Al Bayan', false),
  ]).map((font) => font.name)
  expect(found).toEqual(['Menlo', 'PT Mono', 'System default'])
})

test('a family the built-in list never knew about is offered', () => {
  // The defect this replaces: `CANDIDATES` held "Operator Mono", so a machine
  // with "Operator Mono Lig" installed was told it had no such font.
  const found = monospacedFonts([family('Operator Mono Lig', true)])
  expect(found.map((font) => font.name)).toContain('Operator Mono Lig')
})

test('showing every font keeps the ones that cannot hold a grid', () => {
  const names = everyFont([
    family('Helvetica', false),
    family('Menlo', true),
    family('Zapfino', false),
  ]).map((font) => font.name)
  expect(names).toEqual(['Helvetica', 'Menlo', 'Zapfino', 'System default'])
})

test('every offered stack still ends in monospace, proportional ones included', () => {
  // A stored choice outlives the machine it was made on, and a family that has
  // gone missing must degrade to something fixed-width rather than to the
  // engine's proportional default, which misaligns every column.
  for (const font of everyFont([
    family('Helvetica', false),
    family('Zapfino', false),
  ])) {
    expect(font.stack.endsWith('monospace')).toBe(true)
  }
})

test('an unreachable font source leaves the picker something to hold', () => {
  // Rust answers an empty list rather than failing when the platform source
  // cannot be reached; the caller falls back to the measured built-in list.
  expect(monospacedFonts([]).map((font) => font.name)).toEqual([
    'System default',
  ])
})

test('a stack stored by an older build still matches the family it names', () => {
  // Quoting changed, and a stored setting outlives the build that wrote it.
  // `fontChoices` matches on the family name rather than the whole stack for
  // exactly this reason, so an unquoted `Menlo, monospace` from before must
  // still select Menlo rather than appear as "(not installed)".
  const chosen = fontChoices('Menlo, monospace', [
    { name: 'Menlo', stack: stackFor('Menlo') },
  ])
  expect(chosen.map((font) => font.name)).toEqual(['Menlo'])
})

test('fontName reverses stackFor for any family name', () => {
  // The two halves are a round trip, and a name holding a comma or a quote is
  // where they came apart: `"A,B", monospace` read back as `A`, so the family
  // was offered a second time labelled "(not installed)" with a stack
  // identical to the real one — a duplicate key in the picker.
  for (const name of [
    'Menlo',
    'Operator Mono Lig',
    'A,B',
    'Foo"Bar',
    'Back\\slash',
    "It's Mono",
  ]) {
    expect(fontName(stackFor(name))).toBe(name)
  }
})

test('fontName still reads a stack an older build wrote unquoted', () => {
  expect(fontName('Menlo, monospace')).toBe('Menlo')
  expect(fontName('monospace')).toBe('System default')
})
