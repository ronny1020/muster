import { expect, test } from 'bun:test'

import { surfacesFor, type ViewState } from './surfaces'

const view = (over: Partial<ViewState> = {}): ViewState => ({
  buffer: 'normal',
  bufferRows: 4000,
  screenRows: 40,
  turns: 0,
  ...over,
})

test('a session with history gets the terminal’s own scrollbar', () => {
  expect(surfacesFor(view()).scrollbar).toBe(true)
})

test('a clickable session gets no scrollbar, because there is nothing to scroll', () => {
  // The alternate buffer is exactly `rows` tall, so xterm has no extent to
  // draw a thumb against. These assertions pin the conditions for a bar, not
  // a rendered one: there is no component layer here, so whether xterm drew
  // it is answered by running the app.
  const clicks = view({ buffer: 'alternate', bufferRows: 40, turns: 12 })
  expect(surfacesFor(clicks).scrollbar).toBe(false)
  expect(surfacesFor(clicks).rail).toBe('transcript')
})

test('a session that has not filled a screen yet has no scrollbar either', () => {
  expect(surfacesFor(view({ bufferRows: 40 })).scrollbar).toBe(false)
})

test('a clicks tab whose CLI fell back to its classic renderer keeps both', () => {
  // The CLI chooses its renderer, so a tab asked for clicks can still run in
  // the normal buffer and build real history. Gating the width repair on the
  // tab's mode left that session cleared on every resize with no way back.
  const fellBack = view({ buffer: 'normal', bufferRows: 900, turns: 12 })
  expect(surfacesFor(fellBack).scrollbar).toBe(true)
  expect(surfacesFor(fellBack).replay).toBe(true)
  expect(surfacesFor(fellBack).rail).toBe('buffer')
})

test('a clickable session has nothing for the width repair to redraw', () => {
  expect(
    surfacesFor(view({ buffer: 'alternate', bufferRows: 40 })).replay,
  ).toBe(false)
})

test('a clickable session with no transcript draws no rail at all', () => {
  // A shell, another agent, or a record whose id was never published: the
  // scan has nothing in that buffer and the transcript answered nothing.
  expect(surfacesFor(view({ buffer: 'alternate', bufferRows: 40 })).rail).toBe(
    'none',
  )
})
