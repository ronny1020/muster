import { expect, test } from 'bun:test'

import {
  type TabChanges,
  collisionSummary,
  collisionsByTab,
} from './collisions'

const tab = (over: Partial<TabChanges> & { tabId: string }): TabChanges => ({
  title: over.tabId,
  commonDir: '/repo/.git',
  root: `/work/${over.tabId}`,
  paths: [],
  ...over,
})

test('two worktrees of one repo editing one file collide', () => {
  const found = collisionsByTab([
    tab({ tabId: 'a', paths: ['src/auth.ts', 'README.md'] }),
    tab({ tabId: 'b', title: 'codex', paths: ['src/auth.ts'] }),
  ])
  expect(found.get('a')).toEqual([{ path: 'src/auth.ts', others: ['codex'] }])
  expect(found.get('b')).toEqual([{ path: 'src/auth.ts', others: ['a'] }])
})

test('two tabs in the same working tree never collide', () => {
  // They are one tree, so they share every file by definition. Warning about
  // it would light permanently and teach everyone to ignore the warning.
  const found = collisionsByTab([
    tab({ tabId: 'a', root: '/work/same', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', root: '/work/same', paths: ['src/auth.ts'] }),
  ])
  expect(found.size).toBe(0)
})

test('a third tab in a shared tree does not hide a real collision', () => {
  // Two tabs sit in one tree and a third in its own worktree. The pair must
  // not warn about each other, and all three must see the real overlap.
  const found = collisionsByTab([
    tab({ tabId: 'a', root: '/work/same', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', root: '/work/same', paths: ['src/auth.ts'] }),
    tab({ tabId: 'c', title: 'codex', paths: ['src/auth.ts'] }),
  ])
  expect(found.get('a')).toEqual([{ path: 'src/auth.ts', others: ['codex'] }])
  expect(found.get('c')?.[0].others.sort()).toEqual(['a', 'b'])
})

test('tabs in unrelated repositories never collide', () => {
  const found = collisionsByTab([
    tab({ tabId: 'a', commonDir: '/one/.git', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', commonDir: '/two/.git', paths: ['src/auth.ts'] }),
  ])
  expect(found.size).toBe(0)
})

test('a tab outside any repository is never compared', () => {
  // An empty common dir means "not in a repo", not "in the same repo as every
  // other directory that is not in one".
  const found = collisionsByTab([
    tab({ tabId: 'a', commonDir: '', paths: ['x'] }),
    tab({ tabId: 'b', commonDir: '', paths: ['x'] }),
  ])
  expect(found.size).toBe(0)
})

test('a tab changing nothing collides with nobody', () => {
  const found = collisionsByTab([
    tab({ tabId: 'a', paths: [] }),
    tab({ tabId: 'b', paths: ['src/auth.ts'] }),
  ])
  expect(found.size).toBe(0)
})

test('one tab listing a path twice does not collide with itself', () => {
  // `git rm --cached x` leaves a path both deleted against HEAD and untracked.
  const found = collisionsByTab([
    tab({ tabId: 'a', paths: ['x', 'x'] }),
    tab({ tabId: 'b', paths: [] }),
  ])
  expect(found.size).toBe(0)
})

test('the summary leads with the file, not the count', () => {
  expect(collisionSummary([{ path: 'src/auth.ts', others: ['codex'] }])).toBe(
    'src/auth.ts also in codex',
  )
  expect(
    collisionSummary([
      { path: 'src/auth.ts', others: ['codex'] },
      { path: 'README.md', others: ['codex'] },
    ]),
  ).toBe('src/auth.ts +1 also in codex')
})

test('several other tabs are counted rather than listed', () => {
  expect(
    collisionSummary([{ path: 'src/auth.ts', others: ['codex', 'gemini'] }]),
  ).toBe('src/auth.ts also in 2 other tabs')
})

test('nothing to say is an empty string, not a zero', () => {
  expect(collisionSummary([])).toBe('')
})
