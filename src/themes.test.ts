import { expect, test } from 'bun:test'

import { DEFAULT_THEME_ID, THEMES, themeChoices, themeFor } from './themes'

test('a known theme is returned as itself', () => {
  expect(themeFor('nord').name).toBe('Nord')
})

test('an unknown theme falls back rather than leaving the terminal unstyled', () => {
  // A theme dropped in a later version, or a hand-edited setting.
  expect(themeFor('theme-that-was-removed')).toBe(THEMES[DEFAULT_THEME_ID])
  expect(themeFor('')).toBe(THEMES[DEFAULT_THEME_ID])
})

test('every theme is complete, so no colour falls through to a default', () => {
  const keys = Object.keys(THEMES[DEFAULT_THEME_ID])
  for (const [id, theme] of Object.entries(THEMES)) {
    expect(Object.keys(theme).sort(), `${id} is missing a colour`).toEqual(
      keys.sort(),
    )
  }
})

test('every background is opaque, since the pane paints it behind the grid', () => {
  for (const [id, theme] of Object.entries(THEMES)) {
    expect(theme.background, `${id} background`).toMatch(/^#[0-9a-f]{6}$/)
  }
})

test('the picker offers every theme, with the default among them', () => {
  const choices = themeChoices()
  expect(choices).toHaveLength(Object.keys(THEMES).length)
  expect(choices.map((choice) => choice.id)).toContain(DEFAULT_THEME_ID)
})
