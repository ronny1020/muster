import { expect, test } from 'bun:test'

import { codeStyle } from './codestyle'
import { DEFAULT_SETTINGS } from '../../../entities/preferences/model/settings'

const settings = {
  ...DEFAULT_SETTINGS,
  fontFamily: 'Comic Mono',
  fontSize: 17,
  lineHeight: 1.6,
  letterSpacing: 3,
}

test('a diff is drawn in the font the terminal was given', () => {
  // Anyone who has chosen a font for reading code has chosen the one they
  // want a diff in, and a column in a different face reads as another app.
  expect(codeStyle(settings, { natural: 22, dpr: 1 })).toEqual({
    fontFamily: 'Comic Mono',
    fontSize: '17px',
    // The terminal's own row height for those numbers, not 17 × 1.6.
    lineHeight: '35px',
    letterSpacing: '3px',
  })
})

test('a retina screen halves the spacing, as it does in the terminal', () => {
  const style = codeStyle(settings, { natural: 22, dpr: 2 })

  expect(style.letterSpacing).toBe('1.5px')
  expect(style.lineHeight).toBe('35px')
})

test('before anything is measured the settings are used as CSS means them', () => {
  // A row five pixels out for one frame beats a row laid out against zero.
  const style = codeStyle(settings, null)

  expect(style.lineHeight).toBe(1.6)
  expect(style.letterSpacing).toBe('3px')
})
