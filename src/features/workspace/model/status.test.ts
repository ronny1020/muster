import { expect, test } from 'bun:test'

import { branchLabel, gitChips } from './status'
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
