import { expect, test } from 'bun:test'

import { matchShortcut, shortcutLabels, type ShortcutEvent } from './shortcuts'

const press = (over: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: 't',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

test('macOS puts the tab shortcuts on command', () => {
  expect(matchShortcut(press({ key: 't', metaKey: true }), true)).toEqual({
    type: 'open',
  })
  expect(matchShortcut(press({ key: 'w', metaKey: true }), true)).toEqual({
    type: 'closeActive',
  })
  expect(matchShortcut(press({ key: 'y', metaKey: true }), true)).toEqual({
    type: 'toggleHistory',
  })
})

test('elsewhere they take ctrl and shift, leaving bare ctrl to the terminal', () => {
  expect(
    matchShortcut(press({ key: 'T', ctrlKey: true, shiftKey: true }), false),
  ).toEqual({ type: 'open' })
  expect(matchShortcut(press({ key: 't', ctrlKey: true }), false)).toBeNull()
  expect(matchShortcut(press({ key: 'w', ctrlKey: true }), false)).toBeNull()
})

test("the other platform's modifier never fires a shortcut", () => {
  expect(
    matchShortcut(press({ key: 't', ctrlKey: true, shiftKey: true }), true),
  ).toBeNull()
  expect(matchShortcut(press({ key: 't', metaKey: true }), false)).toBeNull()
})

test('digits jump to a tab without the extra shift on either platform', () => {
  expect(matchShortcut(press({ key: '1', metaKey: true }), true)).toEqual({
    type: 'activateIndex',
    index: 0,
  })
  expect(matchShortcut(press({ key: '8', ctrlKey: true }), false)).toEqual({
    type: 'activateIndex',
    index: 7,
  })
})

test('nine means the last tab, however many there are', () => {
  expect(matchShortcut(press({ key: '9', metaKey: true }), true)).toEqual({
    type: 'activateIndex',
    index: -1,
  })
  expect(matchShortcut(press({ key: '9', ctrlKey: true }), false)).toEqual({
    type: 'activateIndex',
    index: -1,
  })
})

test('zero is not a tab', () => {
  expect(matchShortcut(press({ key: '0', metaKey: true }), true)).toBeNull()
})

test('brackets cycle whichever way the layout spells them under shift', () => {
  for (const key of ['[', '{']) {
    expect(
      matchShortcut(press({ key, metaKey: true, shiftKey: true }), true),
    ).toEqual({ type: 'cycle', step: -1 })
  }
  for (const key of [']', '}']) {
    expect(
      matchShortcut(press({ key, metaKey: true, shiftKey: true }), true),
    ).toEqual({ type: 'cycle', step: 1 })
  }
})

test('page keys cycle tabs on every platform', () => {
  expect(matchShortcut(press({ key: 'PageUp', ctrlKey: true }), false)).toEqual(
    { type: 'cycle', step: -1 },
  )
  expect(
    matchShortcut(press({ key: 'PageDown', metaKey: true }), true),
  ).toEqual({ type: 'cycle', step: 1 })
})

test('the comma opens settings without a shift anywhere', () => {
  expect(matchShortcut(press({ key: ',', metaKey: true }), true)).toEqual({
    type: 'openSettings',
  })
  expect(matchShortcut(press({ key: ',', ctrlKey: true }), false)).toEqual({
    type: 'openSettings',
  })
})

test('alt is left alone, since a TUI may want it', () => {
  expect(
    matchShortcut(press({ key: 't', metaKey: true, altKey: true }), true),
  ).toBeNull()
  expect(
    matchShortcut(
      press({ key: 'T', ctrlKey: true, shiftKey: true, altKey: true }),
      false,
    ),
  ).toBeNull()
})

test('an unmodified key always reaches the terminal', () => {
  expect(matchShortcut(press({ key: 't' }), true)).toBeNull()
  expect(matchShortcut(press({ key: 'PageUp' }), false)).toBeNull()
})

test("labels are written in each platform's own notation", () => {
  expect(shortcutLabels(true).open).toBe('⌘T')
  expect(shortcutLabels(false).open).toBe('Ctrl+Shift+T')
  expect(shortcutLabels(true).next).toBe('⌘⇧]')
  expect(shortcutLabels(false).next).toBe('Ctrl+PageDown')
})

test('find is ⌘F on macOS and Ctrl+Shift+F elsewhere', () => {
  expect(matchShortcut(press({ key: 'f', metaKey: true }), true)).toEqual({
    type: 'find',
  })
  expect(
    matchShortcut(press({ key: 'f', ctrlKey: true, shiftKey: true }), false),
  ).toEqual({ type: 'find' })
})

test('plain Ctrl+F stays with the program, which uses it to page forward', () => {
  expect(matchShortcut(press({ key: 'f', ctrlKey: true }), false)).toBeNull()
})

test('review is on G, the key every editor gives source control', () => {
  expect(matchShortcut(press({ key: 'g', metaKey: true }), true)).toEqual({
    type: 'toggleReview',
  })
  expect(
    matchShortcut(press({ key: 'g', ctrlKey: true, shiftKey: true }), false),
  ).toEqual({ type: 'toggleReview' })
})

test('a bare Ctrl+G still reaches the terminal, where readline owns it', () => {
  expect(matchShortcut(press({ key: 'g', ctrlKey: true }), false)).toBeNull()
})
