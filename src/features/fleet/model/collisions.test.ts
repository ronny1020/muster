import { expect, test } from 'bun:test'

import {
  type TabChanges,
  collisionSummary,
  collisionsByTab,
  newCollisions,
} from './collisions'
import { i18n } from '../../../shared/i18n/i18n'

const t = i18n.getFixedT('en-US', 'workspace')

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
  expect(found.get('a')).toEqual([
    {
      path: 'src/auth.ts',
      commonDir: '/repo/.git',
      others: ['codex'],
      otherIds: ['b'],
    },
  ])
  expect(found.get('b')).toEqual([
    {
      path: 'src/auth.ts',
      commonDir: '/repo/.git',
      others: ['a'],
      otherIds: ['a'],
    },
  ])
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
  expect(found.get('a')).toEqual([
    {
      path: 'src/auth.ts',
      commonDir: '/repo/.git',
      others: ['codex'],
      otherIds: ['c'],
    },
  ])
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
  expect(
    collisionSummary(
      [
        {
          path: 'src/auth.ts',
          commonDir: '/repo/.git',
          others: ['codex'],
          otherIds: [],
        },
      ],
      t,
    ),
  ).toBe('src/auth.ts also in codex')
  expect(
    collisionSummary(
      [
        {
          path: 'src/auth.ts',
          commonDir: '/repo/.git',
          others: ['codex'],
          otherIds: [],
        },
        {
          path: 'README.md',
          commonDir: '/repo/.git',
          others: ['codex'],
          otherIds: [],
        },
      ],
      t,
    ),
  ).toBe('src/auth.ts +1 also in codex')
})

test('several other tabs are counted rather than listed', () => {
  expect(
    collisionSummary(
      [
        {
          path: 'src/auth.ts',
          commonDir: '/repo/.git',
          others: ['codex', 'gemini'],
          otherIds: [],
        },
      ],
      t,
    ),
  ).toBe('src/auth.ts also in 2 other tabs')
})

test('nothing to say is an empty string, not a zero', () => {
  expect(collisionSummary([], t)).toBe('')
})

test('the summary speaks the catalog it is given', () => {
  expect(
    collisionSummary(
      [
        {
          path: 'src/auth.ts',
          commonDir: '/repo/.git',
          others: ['codex', 'gemini'],
          otherIds: [],
        },
      ],
      i18n.getFixedT('ja', 'workspace'),
    ),
  ).toBe('src/auth.ts は他のタブ 2 件でも変更中')
})

test('a single tab is named apart from the sentence around it in any script', () => {
  const summary = collisionSummary(
    [
      {
        path: 'src/auth.ts',
        commonDir: '/repo/.git',
        others: ['api'],
        otherIds: [],
      },
    ],
    i18n.getFixedT('zh-TW', 'workspace'),
  )
  expect(summary).toBe('src/auth.ts 也在「api」中變更')
})

test('an overlap is new once, the first time a tab shares it', () => {
  const before = collisionsByTab([
    tab({ tabId: 'a', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', paths: ['src/auth.ts'] }),
  ])
  expect(newCollisions(new Map(), before)).toEqual([
    { path: 'src/auth.ts', tabIds: ['a', 'b'] },
  ])
  expect(newCollisions(before, before)).toEqual([])
})

test('a tab joining an overlap names every tab in it', () => {
  const before = collisionsByTab([
    tab({ tabId: 'a', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', paths: ['src/auth.ts'] }),
  ])
  const after = collisionsByTab([
    tab({ tabId: 'a', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', paths: ['src/auth.ts'] }),
    tab({ tabId: 'c', paths: ['src/auth.ts'] }),
  ])
  expect(newCollisions(before, after)).toEqual([
    { path: 'src/auth.ts', tabIds: ['a', 'b', 'c'] },
  ])
})

test('the same path changing in two repositories is two overlaps', () => {
  const after = collisionsByTab([
    tab({ tabId: 'a', commonDir: '/x/.git', paths: ['package.json'] }),
    tab({ tabId: 'b', commonDir: '/x/.git', paths: ['package.json'] }),
    tab({ tabId: 'c', commonDir: '/y/.git', paths: ['package.json'] }),
    tab({ tabId: 'd', commonDir: '/y/.git', paths: ['package.json'] }),
  ])
  expect(newCollisions(new Map(), after)).toEqual([
    { path: 'package.json', tabIds: ['a', 'b'] },
    { path: 'package.json', tabIds: ['c', 'd'] },
  ])
})

test('tabs sharing a tree see one new overlap, not one each', () => {
  const after = collisionsByTab([
    tab({ tabId: 'a', root: '/work/same', paths: ['src/auth.ts'] }),
    tab({ tabId: 'b', root: '/work/same', paths: ['src/auth.ts'] }),
    tab({ tabId: 'c', paths: ['src/auth.ts'] }),
  ])
  expect(newCollisions(new Map(), after)).toEqual([
    { path: 'src/auth.ts', tabIds: ['a', 'b', 'c'] },
  ])
})

test('a joiner in a tree already in the overlap names every tab on the file', () => {
  const before = collisionsByTab([
    tab({ tabId: 'a', paths: ['p'] }),
    tab({ tabId: 'b', paths: ['p'] }),
  ])
  const after = collisionsByTab([
    tab({ tabId: 'a', paths: ['p'] }),
    tab({ tabId: 'b', paths: ['p'] }),
    tab({ tabId: 'c', root: '/work/b', paths: ['p'] }),
  ])
  expect(newCollisions(before, after)).toEqual([
    { path: 'p', tabIds: ['a', 'b', 'c'] },
  ])
})

test('the same tabs and path in another repository are a new overlap', () => {
  const before = collisionsByTab([
    tab({ tabId: 'a', commonDir: '/x/.git', paths: ['package.json'] }),
    tab({ tabId: 'b', commonDir: '/x/.git', paths: ['package.json'] }),
  ])
  const after = collisionsByTab([
    tab({ tabId: 'a', commonDir: '/y/.git', paths: ['package.json'] }),
    tab({ tabId: 'b', commonDir: '/y/.git', paths: ['package.json'] }),
  ])
  expect(newCollisions(before, after)).toEqual([
    { path: 'package.json', tabIds: ['a', 'b'] },
  ])
})
