import { expect, test } from 'bun:test'

import {
  MAX_STALLS,
  moved,
  needleFor,
  normalise,
  NOTCHES_PER_LOOK,
  onScreen,
  rowsOf,
  type Screen,
  sweep,
  type Sweep,
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

/** A sweep over a view that answers each burst by moving `step` rows. */
function sweeping({ step, rows = 4 }: { step: number; rows?: number }) {
  let top = 1000
  const notches: number[] = []
  const run: Sweep = {
    screen: {
      get rows() {
        return rows
      },
      row: (index) => `line ${top + index}`,
    },
    up: true,
    notch: (up) => notches.push(up ? -1 : 1),
    settle: () => {
      top -= step
      return Promise.resolve()
    },
    owns: () => true,
    done: () => false,
  }
  return { run, notches: () => notches }
}

test('a sweep gives up once the view stops moving', async () => {
  // The agent pins its view to the bottom while it prints, so a sweep that
  // kept going would spend its whole bound sending notches into a turn.
  const { run, notches } = sweeping({ step: 0 })
  const travelled = await sweep(run)
  expect(travelled).toBe(0)
  expect(notches().length).toBe(MAX_STALLS * NOTCHES_PER_LOOK)
})

test('a sweep counts only the bursts that moved the view', async () => {
  const { run } = sweeping({ step: 6 })
  let looks = 0
  // Arrives on the third look, so two bursts are the way back.
  const travelled = await sweep({ ...run, done: () => (looks += 1) > 2 })
  expect(travelled).toBe(2 * NOTCHES_PER_LOOK)
})

test('a sweep that loses the view stops sending notches', async () => {
  // A TUI can drop mouse tracking mid-sweep, and every later notch would
  // then be typed into the agent rather than reported to it.
  const { run, notches } = sweeping({ step: 6 })
  const travelled = await sweep({ ...run, owns: () => false })
  expect(travelled).toBe(0)
  expect(notches().length).toBe(NOTCHES_PER_LOOK)
})
