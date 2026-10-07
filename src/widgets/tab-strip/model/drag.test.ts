import { expect, test } from 'bun:test'

import {
  clampLeft,
  dropIndex,
  edgeSpeed,
  insertionIndex,
  isTornOff,
  offsets,
  type Slot,
} from './drag'

/** Three tabs 100, 150 and 100 wide with a 2px gap, starting at 0. */
const slots: Slot[] = [
  { left: 0, width: 100 },
  { left: 102, width: 150 },
  { left: 254, width: 100 },
]

test('a tab stays put until its leading edge crosses a neighbour’s centre', () => {
  expect(dropIndex(slots, 0, 0)).toBe(0)
  expect(dropIndex(slots, 0, 70)).toBe(0)
  expect(dropIndex(slots, 0, 80)).toBe(1)
  expect(dropIndex(slots, 2, 180)).toBe(2)
  expect(dropIndex(slots, 2, 170)).toBe(1)
  expect(dropIndex(slots, 2, 254)).toBe(2)
})

test('a tab clamped at either end lands there, whatever the widths', () => {
  expect(dropIndex(slots, 0, clampLeft(slots, 0, 999))).toBe(2)
  expect(dropIndex(slots, 2, clampLeft(slots, 2, -999))).toBe(0)
  expect(dropIndex(slots, 1, clampLeft(slots, 1, 999))).toBe(2)
  expect(dropIndex(slots, 1, clampLeft(slots, 1, -999))).toBe(0)
})

test('dropping a tab at its own index moves nothing', () => {
  expect(offsets(slots, 1, 1)).toEqual([0, 0, 0])
})

test('neighbours make room for a tab of a different width, gap intact', () => {
  // The first tab dropped last: the others close up by its width plus the gap,
  // and it lands flush against the far end.
  expect(offsets(slots, 0, 2)).toEqual([254, -102, -102])
  // The wide tab dropped first: the narrow one before it moves right by 152.
  expect(offsets(slots, 1, 0)).toEqual([152, -102, 0])
})

test('a dragged tab cannot leave either end of the strip', () => {
  expect(clampLeft(slots, 1, -40)).toBe(0)
  expect(clampLeft(slots, 1, 400)).toBe(204)
  expect(clampLeft(slots, 1, 80)).toBe(80)
})

test('the strip scrolls only near its edges, faster the deeper', () => {
  const edges = { left: 100, right: 500 }
  expect(edgeSpeed(edges, 300)).toBe(0)
  expect(edgeSpeed(edges, 110)).toBeLessThan(0)
  expect(edgeSpeed(edges, 495)).toBeGreaterThan(0)
  expect(edgeSpeed(edges, 2000)).toBe(16)
  expect(edgeSpeed(edges, -2000)).toBe(-16)
})

test('a tab tears off only once pulled well clear of the strip', () => {
  const strip = { top: 0, bottom: 38 }
  const viewport = { width: 1000, height: 700 }
  expect(isTornOff(strip, viewport, { x: 300, y: 60 }, false)).toBe(false)
  expect(isTornOff(strip, viewport, { x: 300, y: 69 }, false)).toBe(true)
  expect(isTornOff(strip, viewport, { x: -1, y: 20 }, false)).toBe(true)
  expect(isTornOff(strip, viewport, { x: 300, y: 701 }, false)).toBe(true)
})

test('a torn-off tab comes back only once brought well onto the strip', () => {
  const strip = { top: 0, bottom: 38 }
  const viewport = { width: 1000, height: 700 }
  // Between the two distances it stays as it was.
  expect(isTornOff(strip, viewport, { x: 300, y: 62 }, true)).toBe(true)
  expect(isTornOff(strip, viewport, { x: 300, y: 62 }, false)).toBe(false)
  expect(isTornOff(strip, viewport, { x: 300, y: 50 }, true)).toBe(false)
})

test('a dropped tab joins before the first tab whose middle is past it', () => {
  expect(insertionIndex(slots, 10)).toBe(0)
  expect(insertionIndex(slots, 60)).toBe(1)
  expect(insertionIndex(slots, 200)).toBe(2)
  expect(insertionIndex(slots, 900)).toBe(3)
  expect(insertionIndex([], 50)).toBe(0)
})
