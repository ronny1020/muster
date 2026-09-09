import { expect, test } from 'bun:test'

import { type BellContext, decideBellResponse } from './notify'

const context = (overrides: Partial<BellContext> = {}): BellContext => ({
  enabled: true,
  onlyWhenUnfocused: true,
  tabActive: false,
  windowFocused: false,
  lastNotifiedAt: null,
  now: 100_000,
  ...overrides,
})

test('a bell on a background tab notifies and marks the tab', () => {
  expect(decideBellResponse(context())).toEqual({
    attention: true,
    notify: true,
  })
})

test('nothing fires while the user is watching that very tab', () => {
  const response = decideBellResponse(
    context({ tabActive: true, windowFocused: true }),
  )
  expect(response).toEqual({ attention: false, notify: false })
})

test('an active tab in an unfocused window still notifies', () => {
  expect(
    decideBellResponse(context({ tabActive: true, windowFocused: false })),
  ).toEqual({
    attention: true,
    notify: true,
  })
})

test('a focused window on another tab still notifies', () => {
  expect(
    decideBellResponse(context({ tabActive: false, windowFocused: true })),
  ).toEqual({
    attention: true,
    notify: true,
  })
})

test('turning notifications off keeps the tab mark', () => {
  expect(decideBellResponse(context({ enabled: false }))).toEqual({
    attention: true,
    notify: false,
  })
})

test('dropping the unfocused-only rule notifies even while watching', () => {
  const response = decideBellResponse(
    context({ onlyWhenUnfocused: false, tabActive: true, windowFocused: true }),
  )
  expect(response).toEqual({ attention: false, notify: true })
})

test('a repeat bell within the cooldown does not notify twice', () => {
  const response = decideBellResponse(context({ lastNotifiedAt: 98_000 }))
  expect(response).toEqual({ attention: true, notify: false })
})

test('a bell after the cooldown notifies again', () => {
  expect(decideBellResponse(context({ lastNotifiedAt: 95_000 })).notify).toBe(
    true,
  )
})

test('the cooldown boundary counts as elapsed', () => {
  expect(decideBellResponse(context({ lastNotifiedAt: 96_000 })).notify).toBe(
    true,
  )
})
