import { expect, test } from 'bun:test'

import { splitFlags } from './flags'

test('splits on whitespace', () => {
  expect(splitFlags('  --model  opus ')).toEqual(['--model', 'opus'])
})

test('returns nothing for a blank string', () => {
  expect(splitFlags('   ')).toEqual([])
})

test('keeps a double-quoted value as one argument', () => {
  expect(splitFlags('--append-system-prompt "be terse, no preamble"')).toEqual([
    '--append-system-prompt',
    'be terse, no preamble',
  ])
})

test('keeps a single-quoted value as one argument', () => {
  expect(splitFlags("-p 'what changed?'")).toEqual(['-p', 'what changed?'])
})

test('tolerates an unclosed quote while the user is still typing', () => {
  expect(splitFlags('-p "half a thou')).toEqual(['-p', 'half a thou'])
})
