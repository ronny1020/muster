import { expect, test } from 'bun:test'

import { isWorking, QUIET_MS } from './working'

test('a session that just printed is working', () => {
  expect(isWorking(1_000, 1_000)).toBe(true)
  expect(isWorking(1_000, 1_000 + QUIET_MS - 1)).toBe(true)
})

test('a session silent for the whole window has stopped working', () => {
  expect(isWorking(1_000, 1_000 + QUIET_MS)).toBe(false)
})

test('a long silence is still just not working, not an error', () => {
  expect(isWorking(0, 60_000)).toBe(false)
})
