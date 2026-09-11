import { expect, test } from 'bun:test'

import { branchLabel, chipGroups, gitChips, treeRevision } from './status'
import type { GitStatus } from '../../../shared/ipc'

const status = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  repo: true,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  ...overrides,
})

const texts = (git: GitStatus) => gitChips(git).map((chip) => chip.text)

test('a clean tree shows only a clean chip', () => {
  expect(texts(status())).toEqual(['clean'])
})

test('divergence comes before worktree counts', () => {
  expect(texts(status({ ahead: 2, behind: 1, modified: 3 }))).toEqual([
    '↑2',
    '↓1',
    '~3',
  ])
})

test('each kind of change gets its own chip', () => {
  expect(
    texts(status({ staged: 1, modified: 2, untracked: 3, conflicted: 4 })),
  ).toEqual(['+1', '~2', '?3', '!4'])
})

test('clean is dropped as soon as anything is dirty', () => {
  expect(texts(status({ untracked: 1 }))).not.toContain('clean')
})

test('a diverged but clean tree still reads as clean', () => {
  expect(texts(status({ ahead: 1 }))).toEqual(['↑1', 'clean'])
})

test('conflicts are toned as danger', () => {
  expect(gitChips(status({ conflicted: 1 })).at(-1)?.tone).toBe('conflict')
})

test('a detached head is spelled out', () => {
  expect(branchLabel(status({ detached: true, branch: 'a1b2c3d' }))).toBe(
    'detached @ a1b2c3d',
  )
})

test('an attached branch shows its bare name', () => {
  expect(branchLabel(status())).toBe('main')
})

test('a count opens the drawer that lists what it counts', () => {
  const opens = (git: GitStatus) =>
    gitChips(git).map((chip) => [chip.key, chip.opens])

  expect(
    opens(
      status({
        ahead: 2,
        behind: 1,
        staged: 1,
        modified: 2,
        untracked: 3,
        conflicted: 4,
      }),
    ),
  ).toEqual([
    // Commits are the history drawer's; files are the review drawer's.
    ['ahead', 'history'],
    ['behind', 'history'],
    ['staged', 'review'],
    ['modified', 'review'],
    ['untracked', 'review'],
    ['conflict', 'review'],
  ])
})

test('the clean chip goes nowhere, because there is nothing to look at', () => {
  expect(gitChips(status()).map((chip) => chip.opens)).toEqual([null])
})

test('the revision moves when the tree does', () => {
  const before = treeRevision('/work/repo', status({ modified: 1 }))

  expect(treeRevision('/work/repo', status({ modified: 1 }))).toBe(before)
  expect(treeRevision('/work/repo', status({ modified: 2 }))).not.toBe(before)
  expect(
    treeRevision('/work/repo', status({ untracked: 1, modified: 1 })),
  ).not.toBe(before)
  // A different directory is a different tree, whatever its counts.
  expect(treeRevision('/work/other', status({ modified: 1 }))).not.toBe(before)
})

test('the revision does not move on its own', () => {
  // It was a `Date.now()`, which tore down an open diff every poll.
  const twice = [1, 2].map(() => treeRevision('/work/repo', status()))

  expect(twice[0]).toBe(twice[1]!)
})

test('a directory that is not a repository still has a revision', () => {
  expect(treeRevision('/tmp/plain', null)).toBe('/tmp/plain')
})

test('the counts group into one target each', () => {
  const { history, review, clean } = chipGroups(
    status({ ahead: 2, behind: 1, staged: 1, modified: 2, untracked: 3 }),
  )

  expect(history.map((chip) => chip.text)).toEqual(['↑2', '↓1'])
  expect(review.map((chip) => chip.text)).toEqual(['+1', '~2', '?3'])
  expect(clean).toBeNull()
})

test('a clean tree has a chip that leads nowhere, and no groups', () => {
  const { history, review, clean } = chipGroups(status())

  expect([history, review]).toEqual([[], []])
  expect(clean?.text).toBe('clean')
})

test('a tree with no divergence offers no commits target', () => {
  expect(chipGroups(status({ modified: 1 })).history).toEqual([])
})
