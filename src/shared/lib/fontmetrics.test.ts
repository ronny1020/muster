import { expect, test } from 'bun:test'

import { cellHeight, cellSpacing } from './fontmetrics'

test('a row is as tall as xterm makes it, not fontSize times lineHeight', () => {
  // 13px monospace measures about 17px of line box, so the naive 16.25px would
  // be five pixels short of the terminal's own 21px row.
  expect(cellHeight({ natural: 17, dpr: 1 }, 1.25)).toBe(21)
})

test('the device-pixel rounding is the terminal’s, so rows cannot drift', () => {
  // xterm ceils the measured height into device pixels, then floors the row.
  expect(cellHeight({ natural: 17, dpr: 2 }, 1.25)).toBe(21)
  expect(cellHeight({ natural: 17.5, dpr: 2 }, 1.25)).toBe(21.5)
})

test('a line height of one is the font’s own line box', () => {
  expect(cellHeight({ natural: 18, dpr: 1 }, 1)).toBe(18)
})

test('letter spacing is device pixels in a terminal and CSS pixels here', () => {
  // Which is why 3 becomes 1.5 on a retina screen: the terminal only widened
  // its cells by three device pixels.
  expect(cellSpacing({ natural: 17, dpr: 2 }, 3)).toBe(1.5)
  expect(cellSpacing({ natural: 17, dpr: 1 }, 3)).toBe(3)
})

test('a fractional setting rounds the way xterm rounds it', () => {
  expect(cellSpacing({ natural: 17, dpr: 1 }, 2.6)).toBe(3)
})
