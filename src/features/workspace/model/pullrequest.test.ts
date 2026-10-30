import { expect, test } from 'bun:test'

import { pullRequestChip, withLastKnown } from './pullrequest'
import type { PullRequest } from '../../../shared/ipc'
import { i18n } from '../../../shared/i18n/i18n'

const t = i18n.getFixedT('en-US', 'workspace')

const found = (overrides: Partial<PullRequest> = {}) => ({
  kind: 'found' as const,
  number: 18,
  title: 'Worktrees',
  url: 'https://github.com/o/r/pull/18',
  stage: 'open' as const,
  review: null,
  checks: null,
  ...overrides,
})

const chip = (overrides: Partial<PullRequest> = {}) => {
  const drawn = pullRequestChip(found(overrides), t)
  if (drawn?.kind !== 'pullRequest') throw new Error('expected a chip')
  return drawn
}

test('nothing to show draws nothing, and neither does a read not yet back', () => {
  expect(pullRequestChip({ kind: 'absent' }, t)).toBeNull()
  expect(pullRequestChip(null, t)).toBeNull()
})

test('a missing gh and a missing login each say what to do about it', () => {
  const missing = pullRequestChip({ kind: 'missing' }, t)
  const signedOut = pullRequestChip({ kind: 'signedOut' }, t)
  expect(missing?.kind).toBe('hint')
  expect(missing?.title).toContain('Install gh')
  expect(signedOut?.title).toContain('gh auth login')
})

test('the chip shows the number and opens the pull request', () => {
  const drawn = chip()
  expect(drawn.text).toBe('#18')
  expect(drawn.stageText).toBeNull()
  expect(drawn.url).toBe('https://github.com/o/r/pull/18')
  expect(drawn.title.split('\n')).toEqual([
    'Pull request o/r#18: Worktrees',
    'Open',
    'Click to open it on GitHub',
  ])
})

test('one failing check outranks any number running or passed', () => {
  expect(chip({ checks: { passed: 5, failed: 1, pending: 2 } }).checks).toBe(
    'failed',
  )
  expect(chip({ checks: { passed: 5, failed: 0, pending: 2 } }).checks).toBe(
    'pending',
  )
  expect(chip({ checks: { passed: 5, failed: 0, pending: 0 } }).checks).toBe(
    'passed',
  )
  expect(chip().checks).toBeNull()
})

test('the title and the spoken label both carry the review and the counts', () => {
  const drawn = chip({
    stage: 'draft',
    review: 'changesRequested',
    checks: { passed: 3, failed: 1, pending: 0 },
  })
  const summary = 'Draft · changes requested · 1 check failing, 3 checks passed'
  expect(drawn.title.split('\n')[1]).toBe(summary)
  expect(drawn.label).toBe(`Pull request o/r#18, ${summary} — open on GitHub`)
})

test('a stage other than open is named beside the number, not left to colour', () => {
  expect(chip({ stage: 'merged' }).stageText).toBe('merged')
  expect(chip({ stage: 'draft' }).stageText).toBe('draft')
  expect(chip({ stage: 'closed' }).stageText).toBe('closed')
})

test('a repository on another host is named with its host', () => {
  const drawn = chip({ url: 'https://ghe.example.com/o/r/pull/18' })
  expect(drawn.title.split('\n')[0]).toBe(
    'Pull request ghe.example.com/o/r#18: Worktrees',
  )
})

const counted = found({ checks: { passed: 2, failed: 1, pending: 0 } })
const shown = { state: counted, misses: 0 }

test('a read whose checks gh could not give keeps the counts it had for that pull request', () => {
  expect(withLastKnown(found(), shown).state).toEqual(counted)
  const other = found({ url: 'https://github.com/o/r/pull/19' })
  expect(withLastKnown(other, shown).state).toEqual(other)
  const none = found({ checks: { passed: 0, failed: 0, pending: 0 } })
  expect(withLastKnown(none, shown)).toEqual({ state: none, misses: 0 })
})

test('a failed read keeps the pull request it had, but a signed-out gh does not', () => {
  expect(withLastKnown(null, shown).state).toEqual(counted)
  expect(withLastKnown({ kind: 'absent' }, shown).state).toEqual(counted)
  expect(withLastKnown({ kind: 'signedOut' }, shown).state).toEqual({
    kind: 'signedOut',
  })
  expect(
    withLastKnown({ kind: 'absent' }, { state: null, misses: 0 }).state,
  ).toEqual({ kind: 'absent' })
})

test('a second failed read in a row shows what gh said', () => {
  const once = withLastKnown({ kind: 'absent' }, shown)
  expect(withLastKnown({ kind: 'absent' }, once).state).toEqual({
    kind: 'absent',
  })
  expect(withLastKnown(found(), withLastKnown(found(), shown)).state).toEqual(
    found(),
  )
  expect(withLastKnown(null, once).state).toEqual({ kind: 'absent' })
})
