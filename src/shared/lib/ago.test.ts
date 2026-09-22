import { expect, test } from 'bun:test'

import { agoLabel } from './ago'

const NOW = 1_700_000_000_000

test('a moment ago reads as just now', () => {
  expect(agoLabel(NOW / 1000 - 5, NOW)).toBe('just now')
})

test('ages coarsen from minutes to hours to days', () => {
  expect(agoLabel(NOW / 1000 - 90, NOW)).toBe('1m ago')
  expect(agoLabel(NOW / 1000 - 3 * 3600, NOW)).toBe('3h ago')
  expect(agoLabel(NOW / 1000 - 50 * 3600, NOW)).toBe('2d ago')
})

test('a clock that has gone backwards still reads as an age', () => {
  // A record written on a machine whose clock was later corrected would
  // otherwise show a negative age, which reads as a bug in the app.
  expect(agoLabel(NOW / 1000 + 600, NOW)).toBe('just now')
})
