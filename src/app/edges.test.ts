import { expect, test } from 'bun:test'

import { movedEdge } from './edges'

test('moving an edge resizes only the two columns beside it', () => {
  expect(movedEdge([400, 400, 400], { edge: 0, delta: 50, min: 100 })).toEqual([
    450, 350, 400,
  ])
})

test('an edge stops where a neighbour would fall under the minimum', () => {
  expect(movedEdge([400, 400], { edge: 0, delta: 500, min: 100 })).toEqual([
    700, 100,
  ])
  expect(movedEdge([400, 400], { edge: 0, delta: -500, min: 100 })).toEqual([
    100, 700,
  ])
})

test('a column already under the minimum is not grown by a drag away from it', () => {
  expect(movedEdge([80, 400], { edge: 0, delta: 30, min: 100 })).toEqual([
    110, 370,
  ])
  expect(movedEdge([80, 400], { edge: 0, delta: -30, min: 100 })).toEqual([
    80, 400,
  ])
})
