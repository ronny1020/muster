import { expect, test } from 'bun:test'

import { formatBytes } from './bytes'

test('a size reads in the unit a person would use for it', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(840)).toBe('840 B')
  expect(formatBytes(12 * 1024)).toBe('12 KB')
  expect(formatBytes(3.4 * 1_048_576)).toBe('3.4 MB')
})

test('the boundaries land in the larger unit, not at 1024 of the smaller', () => {
  expect(formatBytes(1024)).toBe('1 KB')
  expect(formatBytes(1_048_576)).toBe('1.0 MB')
})
