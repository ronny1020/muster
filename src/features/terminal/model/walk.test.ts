import { expect, test } from 'bun:test'

import { placeKey, walkTo, walkedKey } from './walk'

test('the walk starts below every message, so the first ↑ goes to the newest', () => {
  // The turns arrive after the first render, and a new message is the newest
  // thing to walk back from — so the walk is seeded at the bottom.
  expect(walkTo({ at: 3, count: 3, direction: -1 })).toBe(2)
})

test('↓ past the newest message goes to the live bottom, not back to it', () => {
  // The output after the last message is where the agent is working, and
  // nothing else in a clicks tab can reach it: the alternate buffer has no
  // scrollback, so `scrollToBottom` moves nothing.
  expect(walkTo({ at: 2, count: 3, direction: 1 })).toBe(3)
})

test('the walk stays at the bottom once it is there', () => {
  expect(walkTo({ at: 3, count: 3, direction: 1 })).toBe(3)
})

test('the walk stops at the oldest message rather than running off the top', () => {
  expect(walkTo({ at: 0, count: 3, direction: -1 })).toBe(0)
})

test('a walk over nothing has nowhere to go', () => {
  expect(walkTo({ at: 0, count: 0, direction: -1 })).toBe(0)
  expect(walkTo({ at: 0, count: 0, direction: 1 })).toBe(0)
})

test('the dot the rail fills is one of the dots it drew', () => {
  // The rail keys its entries by index, and a filled key spelled any other
  // way marks nothing — silently, since every dot simply looks unvisited.
  const drawn: (string | null)[] = [0, 1, 2].map(placeKey)
  expect(drawn).toContain(walkedKey(1, 3))
})

test('no dot is filled at the live bottom, which is below every message', () => {
  expect(walkedKey(3, 3)).toBe(null)
})

test('stepping down the conversation moves the filled dot with it', () => {
  const count = 3
  let at = count
  const seen: (string | null)[] = []
  for (const direction of [-1, -1, 1, 1] as const) {
    at = walkTo({ at, count, direction })
    seen.push(walkedKey(at, count))
  }
  expect(seen).toEqual(['said-2', 'said-1', 'said-2', null])
})
