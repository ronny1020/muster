import { describe, expect, it } from 'bun:test'

import { matchBranches, switchWarning } from './branches'
import { i18n } from '../../../shared/i18n/i18n'
import type { Branch, GitStatus } from '../../../shared/ipc'

const t = i18n.getFixedT('en-US', 'workspace')

const branch = (name: string, extra: Partial<Branch> = {}): Branch => ({
  name,
  current: false,
  upstream: null,
  at: 1_700_000_000,
  remote: false,
  worktree: null,
  ...extra,
})

const status = (extra: Partial<GitStatus> = {}): GitStatus => ({
  repo: true,
  branch: 'main',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  publishes: true,
  worktreeOf: null,
  ...extra,
})

describe('matchBranches', () => {
  it('keeps every branch when nothing has been typed', () => {
    const all = [branch('main'), branch('topic')]
    expect(matchBranches(all, '   ')).toEqual(all)
  })

  it('puts a branch that starts with the query above one that merely contains it', () => {
    const ordered = matchBranches(
      [branch('feature/login'), branch('login')],
      'login',
    )
    expect(ordered.map((b) => b.name)).toEqual(['login', 'feature/login'])
  })

  it('matches a path segment, which is how branch names are written', () => {
    const hits = matchBranches(
      [branch('feature/auth'), branch('fix/auth'), branch('docs')],
      'auth',
    )
    expect(hits.map((b) => b.name)).toEqual(['feature/auth', 'fix/auth'])
  })

  it('ignores case, since git names are typed casually', () => {
    expect(matchBranches([branch('Release/2.0')], 'release')).toHaveLength(1)
  })

  it('returns nothing rather than everything when there is no match', () => {
    expect(matchBranches([branch('main')], 'zzz')).toEqual([])
  })
})

describe('switchWarning', () => {
  it('says nothing about a clean tree', () => {
    expect(switchWarning(status(), t)).toBeNull()
  })

  it('counts staged and modified together, since both block a checkout', () => {
    expect(switchWarning(status({ staged: 1, modified: 2 }), t)).toContain(
      '3 uncommitted changes',
    )
  })

  it('reads as singular for one change', () => {
    expect(switchWarning(status({ modified: 1 }), t)).toContain(
      '1 uncommitted change —',
    )
  })

  it('does not warn about untracked files, which a checkout carries across', () => {
    expect(switchWarning(status({ untracked: 4 }), t)).toBeNull()
  })

  it('asks for conflicts to be resolved ahead of anything else', () => {
    expect(switchWarning(status({ conflicted: 1, modified: 9 }), t)).toBe(
      'Resolve the conflicts first.',
    )
  })

  it('speaks the catalog it is given', () => {
    expect(
      switchWarning(
        status({ conflicted: 1 }),
        i18n.getFixedT('ja', 'workspace'),
      ),
    ).toBe('先に競合を解決してください。')
  })
})
