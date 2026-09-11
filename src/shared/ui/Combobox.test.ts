import { expect, test } from 'bun:test'

import { matching, stepped, type ComboboxOption } from './Combobox'

const options: ComboboxOption[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'shell', label: 'Shell' },
]

const ids = (query: string) => matching(options, query).map((o) => o.id)

test('an empty query is every option, not none', () => {
  expect(ids('')).toHaveLength(options.length)
  expect(ids('   ')).toHaveLength(options.length)
})

test('matching is case-insensitive, because nobody types capitals here', () => {
  expect(ids('CLAUDE')).toEqual(['claude'])
  expect(ids('gemini')).toEqual(['gemini'])
})

test('it matches any part of the name, not just the start', () => {
  // `code` has to find OpenCode, which is the whole reason for the filter —
  // and Codex too, since that is what "any part" means.
  expect(ids('code')).toEqual(['claude', 'codex', 'opencode'])
})

test('a query nothing matches yields nothing, rather than everything', () => {
  expect(ids('emacs')).toEqual([])
})

test('the active option is held inside the list, not merely drawn inside it', () => {
  // Letting it run past the end left a number nothing could see: an arrow key
  // held down then reversed did nothing for the next few presses.
  expect(stepped(4, 1, 5)).toBe(4)
  expect(stepped(4, 1, 5)).toBe(stepped(stepped(4, 1, 5), 1, 5))
  expect(stepped(4, -1, 5)).toBe(3)
  expect(stepped(0, -1, 5)).toBe(0)
})

test('an empty list has no active option to hold', () => {
  expect(stepped(3, 1, 0)).toBe(0)
})

test('a list that shrinks under the cursor pulls it back', () => {
  // Typing narrows the matches while `active` still points past the end.
  expect(stepped(7, 0, 2)).toBe(1)
})
