import { beforeEach, expect, test } from 'bun:test'

import { clampWidth, maxWidth, MIN_WIDTH, storedWidth } from './usePanelWidth'

const KEY = 'muster.test.panelWidth'

beforeEach(() => localStorage.removeItem(KEY))

test('a width is held between readable and leaving the terminal room', () => {
  expect(clampWidth(100, 1400)).toBe(MIN_WIDTH)
  expect(clampWidth(600, 1400)).toBe(600)
  expect(clampWidth(9000, 1400)).toBe(maxWidth(1400))
})

test('a window too narrow for the minimum still gets the minimum', () => {
  // Otherwise the clamp inverts and the panel collapses to nothing.
  expect(clampWidth(500, 200)).toBe(MIN_WIDTH)
})

test('a fractional drag lands on a whole pixel', () => {
  expect(clampWidth(480.6, 1400)).toBe(481)
})

test('nothing stored yet means the default', () => {
  expect(storedWidth(KEY, 520, 1400)).toBe(520)
})

test('a stored width is read back', () => {
  localStorage.setItem(KEY, '640')
  expect(storedWidth(KEY, 520, 1400)).toBe(640)
})

test('a hand-edited or stale value repairs instead of rendering', () => {
  // A panel three pixels wide leaves no edge to drag it back with.
  localStorage.setItem(KEY, 'wide please')
  expect(storedWidth(KEY, 520, 1400)).toBe(MIN_WIDTH)

  localStorage.setItem(KEY, '3')
  expect(storedWidth(KEY, 520, 1400)).toBe(MIN_WIDTH)

  // Stored on a wide monitor, opened on a laptop.
  localStorage.setItem(KEY, '1800')
  expect(storedWidth(KEY, 520, 1400)).toBe(maxWidth(1400))
})
