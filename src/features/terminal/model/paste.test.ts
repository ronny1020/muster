import { expect, test } from 'bun:test'

import { ATTACH_THRESHOLD, routePaste } from './paste'

test('an ordinary paste goes to the session as text', () => {
  const route = routePaste('git status')
  expect(route.kind).toBe('inline')
})

test('a paste at the threshold is still text', () => {
  // Off-by-one here is the difference between a long command working as it
  // always has and silently turning into a file.
  expect(routePaste('x'.repeat(ATTACH_THRESHOLD)).kind).toBe('inline')
  expect(routePaste('x'.repeat(ATTACH_THRESHOLD + 1)).kind).toBe('attach')
})

test('a pasted log becomes a file', () => {
  const log = 'error at line 1\n'.repeat(1000)
  expect(routePaste(log).kind).toBe('attach')
})

test('an empty paste is never attached', () => {
  expect(routePaste('').kind).toBe('inline')
})

test('the threshold is adjustable so the rule can be tested at any size', () => {
  expect(routePaste('abcdef', 3).kind).toBe('attach')
  expect(routePaste('ab', 3).kind).toBe('inline')
})
