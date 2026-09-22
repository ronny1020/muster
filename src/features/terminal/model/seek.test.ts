import { expect, test } from 'bun:test'

import {
  moved,
  needleFor,
  normalise,
  onScreen,
  rowsOf,
  type Screen,
} from './seek'

const screenOf = (lines: string[]): Screen => ({
  rows: lines.length,
  row: (index) => lines[index] ?? '',
})

test('a message is found however the agent re-wrapped and prefixed it', () => {
  // The transcript holds what was typed; the agent draws it inside its own
  // frame, with a prompt marker and its own spacing.
  const needle = needleFor('the resize feature, rail/path/find all disappear')
  expect(
    onScreen(
      screenOf(['│ ❯  The Resize Feature,   rail/path/find all disappear  │']),
      needle,
    ),
  ).toBe(true)
})

test('a screen without it says so', () => {
  const needle = needleFor('the resize feature, rail/path/find all disappear')
  expect(onScreen(screenOf(['something else entirely', '']), needle)).toBe(
    false,
  )
})

test('a message too short to be unique is not sought at all', () => {
  // "do that" appears in half a conversation; landing on the wrong one is
  // worse than not moving.
  expect(needleFor('do that')).toBe('')
  expect(onScreen(screenOf(['do that']), needleFor('do that'))).toBe(false)
})

test('normalising collapses the whitespace a redraw introduces', () => {
  expect(normalise('  two   words\n')).toBe('two words')
})

test('a spinner ticking is not the view moving', () => {
  // This is what tells a stalled seek from a working one. An agent repaints
  // its own status between frames, so an exact comparison would call a view
  // that is standing still "moved" and the seek would grind on to its bound.
  const rows = ['line one', 'line two', 'line three', 'line four']
  const before = rowsOf(screenOf(['⠋ Thinking… 1.2k tokens', ...rows]))
  const after = rowsOf(screenOf(['⠙ Thinking… 1.3k tokens', ...rows]))
  expect(moved(before, after)).toBe(false)
})

test('a scrolled screen reads as moved', () => {
  const before = rowsOf(screenOf(['one', 'two', 'three', 'four']))
  const after = rowsOf(screenOf(['five', 'six', 'seven', 'eight']))
  expect(moved(before, after)).toBe(true)
})

test('nothing to compare reads as moved, so a seek gets its first burst', () => {
  expect(moved([], [])).toBe(true)
})

test('a message wrapped onto two rows is still found', () => {
  // The agent wraps to its own width inside its own frame, so a needle of a
  // few words lands on two rows as often as one. Searching row by row walks
  // straight past it — measured on an 82-character prompt the seek scrolled
  // clean over.
  const needle = needleFor(
    "no..., i don't talk about click tab. i say click or hover",
  )
  expect(
    onScreen(
      screenOf([
        "│ ❯ no..., i don't talk about click",
        '│   tab. i say click or hover on │',
      ]),
      needle,
    ),
  ).toBe(true)
})

test('joining rows does not invent a match across the whole screen', () => {
  const needle = needleFor('the resize and the default click feature')
  expect(
    onScreen(screenOf(['the resize and', 'something else entirely']), needle),
  ).toBe(false)
})
