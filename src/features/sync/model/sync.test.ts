import { describe, expect, test } from 'bun:test'

import type { GitStatus } from '../../../shared/ipc'
import { commitControl, commitWarning, pullControl, pushControl } from './sync'

const clean: GitStatus = {
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
  publishes: false,
}

describe('commitControl', () => {
  test('a clean tree has nothing to commit', () => {
    expect(commitControl(clean).blocked).not.toBeNull()
  })

  test('a new file alone is enough to commit', () => {
    expect(commitControl({ ...clean, untracked: 1 }).blocked).toBeNull()
  })

  test('staged work is named, because only it will be committed', () => {
    const control = commitControl({ ...clean, staged: 2, modified: 5 })
    expect(control.label).toBe('Commit 2 staged')
  })

  test('with nothing staged the button says it takes everything', () => {
    expect(commitControl({ ...clean, modified: 3 }).label).toBe('Commit all')
  })
})

describe('pullControl', () => {
  test('shows how far behind the branch is', () => {
    expect(pullControl({ ...clean, behind: 4 }).label).toBe('Pull ↓4')
  })

  test('a branch with no upstream has nothing to pull from', () => {
    expect(pullControl({ ...clean, upstream: null }).blocked).not.toBeNull()
  })

  test('a detached head cannot pull', () => {
    expect(pullControl({ ...clean, detached: true }).blocked).not.toBeNull()
  })
})

describe('pushControl', () => {
  test('shows how many commits are waiting to go', () => {
    expect(pushControl({ ...clean, ahead: 2 }).label).toBe('Push ↑2')
  })

  test('a branch with no upstream is published', () => {
    const control = pushControl({
      ...clean,
      upstream: null,
      publishes: true,
    })
    expect(control.label).toBe('Publish')
    expect(control.blocked).toBeNull()
  })

  test('a detached head has no branch to push', () => {
    expect(pushControl({ ...clean, detached: true }).blocked).not.toBeNull()
  })
})

describe('commitWarning', () => {
  test('a detached head warns that the commit belongs to no branch', () => {
    expect(commitWarning({ ...clean, detached: true })).not.toBeNull()
  })

  test('a branch needs no warning', () => {
    expect(commitWarning(clean)).toBeNull()
  })
})

describe('pushControl on an upstream of another name', () => {
  test('a branch made from origin/main is published, not pushed onto main', () => {
    const control = pushControl({
      ...clean,
      branch: 'agent/fix',
      upstream: 'origin/main',
      publishes: true,
      ahead: 3,
    })
    expect(control.label).toBe('Publish')
  })
})
