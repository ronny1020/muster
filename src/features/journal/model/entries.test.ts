import { expect, test } from 'bun:test'

import { agoLabel, earlierThan } from './entries'

const NOW = 1_700_000_000_000

test('a session that just stopped printing reads as just now', () => {
  expect(agoLabel(NOW / 1000 - 5, NOW)).toBe('just now')
})

test('ages coarsen from minutes to hours to days', () => {
  expect(agoLabel(NOW / 1000 - 90, NOW)).toBe('1m ago')
  expect(agoLabel(NOW / 1000 - 3 * 3600, NOW)).toBe('3h ago')
  expect(agoLabel(NOW / 1000 - 50 * 3600, NOW)).toBe('2d ago')
})

test('a clock that has gone backwards still reads as an age', () => {
  // A record written on a machine whose clock was later corrected would
  // otherwise show a negative age, which reads as a bug in the app.
  expect(agoLabel(NOW / 1000 + 600, NOW)).toBe('just now')
})

test('the run this tab is recording now is not offered', () => {
  // Records are named `<tab id>-<started at>`, so one tab accumulates one per
  // run and the match has to be on the prefix.
  const entries = [
    {
      id: 'tab-a-200',
      bytes: 10,
      endedAt: 2,
      agentId: 'claude',
      sessionId: '',
    },
    {
      id: 'tab-b-100',
      bytes: 10,
      endedAt: 1,
      agentId: 'claude',
      sessionId: '',
    },
  ]
  expect(earlierThan(entries, 'tab-a').map((entry) => entry.id)).toEqual([
    'tab-b-100',
  ])
})

test("this tab's own earlier runs are still offered", () => {
  // The point of the feature: the run that just ended, in this very tab.
  const entries = [
    {
      id: 'tab-a-100',
      bytes: 10,
      endedAt: 1,
      agentId: 'claude',
      sessionId: '',
    },
  ]
  expect(earlierThan(entries, null)).toHaveLength(1)
})

test('a session that recorded nothing is not offered', () => {
  // A tab opened and closed without the agent printing leaves an empty file;
  // offering it gives the reader a blank screen and no way to tell why.
  const entries = [
    { id: 'empty', bytes: 0, endedAt: 1, agentId: 'claude', sessionId: '' },
  ]
  expect(earlierThan(entries, null)).toEqual([])
})
