import { describe, expect, test } from 'bun:test'

import {
  footerOwners,
  joinSyncs,
  panelLeads,
  panelRun,
  sharedRoots,
  treeRuns,
} from './trees'

describe('treeRuns', () => {
  test('neighbouring columns on one tree make one run', () => {
    expect(treeRuns(['/x', '/x', '/y'])).toEqual([
      { root: '/x', first: 0, last: 1 },
      { root: '/y', first: 2, last: 2 },
    ])
  })

  test('a column on another tree between them splits the tree in two', () => {
    expect(treeRuns(['/x', '/y', '/x'])).toEqual([
      { root: '/x', first: 0, last: 0 },
      { root: '/y', first: 1, last: 1 },
      { root: '/x', first: 2, last: 2 },
    ])
  })

  test('columns with no tree never join, even side by side', () => {
    expect(treeRuns(['', ''])).toEqual([
      { root: '', first: 0, last: 0 },
      { root: '', first: 1, last: 1 },
    ])
  })
})

describe('sharedRoots', () => {
  test('a tree shown in two columns is shared whether or not they touch', () => {
    expect([...sharedRoots(['/x', '/y', '/x', ''])]).toEqual(['/x'])
  })

  test('no tree is shared by columns that have none', () => {
    expect(sharedRoots(['', '']).size).toBe(0)
  })
})

describe('panelRun', () => {
  const runs = treeRuns(['/x', '/y', '/x']).filter((run) => run.root === '/x')

  test('the run holding the keyboard draws the panels', () => {
    expect(panelRun(runs, { focus: 0, drewLast: () => false })?.first).toBe(0)
  })

  test('with the keyboard elsewhere, the run that drew them keeps them', () => {
    expect(
      panelRun(runs, { focus: 1, drewLast: (run) => run.last === 0 })?.first,
    ).toBe(0)
  })

  test('with neither, the rightmost run draws them', () => {
    expect(panelRun(runs, { focus: 1, drewLast: () => false })?.first).toBe(2)
  })
})

describe('joinSyncs', () => {
  const map = (entries: [string, string][] = []) => new Map(entries)

  test('a column arriving on a tree takes the view of the one already there', () => {
    expect(
      joinSyncs({
        now: map([
          ['a', '/x'],
          ['b', '/x'],
        ]),
        previous: map([
          ['a', '/x'],
          ['b', '/y'],
        ]),
        activeId: 'b',
      }),
    ).toEqual([{ from: 'a', to: ['b'] }])
  })

  test('of the columns already there, the one with the keyboard is the source', () => {
    expect(
      joinSyncs({
        now: map([
          ['a', '/x'],
          ['b', '/x'],
          ['c', '/x'],
        ]),
        previous: map([
          ['a', '/x'],
          ['b', '/x'],
          ['c', ''],
        ]),
        activeId: 'a',
      }),
    ).toEqual([{ from: 'a', to: ['c'] }])
  })

  test('a hidden tab a card brings forward takes the view of the column there', () => {
    // The card's own tab replaces column 1's, so it was not shown before.
    expect(
      joinSyncs({
        now: map([
          ['a', '/x'],
          ['card', '/x'],
        ]),
        previous: map([
          ['a', '/x'],
          ['other', '/y'],
        ]),
        activeId: 'card',
      }),
    ).toEqual([{ from: 'a', to: ['card'] }])
  })

  test('columns arriving together take the keyboard column’s view', () => {
    expect(
      joinSyncs({
        now: map([
          ['a', '/x'],
          ['b', '/x'],
        ]),
        previous: map(),
        activeId: 'a',
      }),
    ).toEqual([{ from: 'a', to: ['b'] }])
  })

  test('nothing moves while the same columns stay on a tree', () => {
    const same = map([
      ['a', '/x'],
      ['b', '/x'],
    ])
    expect(joinSyncs({ now: same, previous: same, activeId: 'a' })).toEqual([])
  })

  test('a column alone on its tree takes nothing', () => {
    expect(
      joinSyncs({
        now: map([
          ['a', '/x'],
          ['b', '/y'],
        ]),
        previous: map(),
        activeId: 'a',
      }),
    ).toEqual([])
  })
})

describe('panelLeads', () => {
  test('a run’s rightmost column draws its tree’s panels', () => {
    const leads = panelLeads(
      { shown: ['a', 'b', 'c'], roots: ['/x', '/x', '/y'], focus: 0 },
      {},
    )
    expect([...leads]).toEqual([['/x', 'b']])
  })

  test('a tree split by another column draws them in the run last used', () => {
    const leads = panelLeads(
      { shown: ['a', 'b', 'c'], roots: ['/x', '/y', '/x'], focus: 1 },
      { '/x': 'a' },
    )
    expect(leads.get('/x')).toBe('a')
  })
})

describe('footerOwners', () => {
  test('a run’s footer is drawn by the column with the keyboard', () => {
    const owners = footerOwners({
      shown: ['a', 'b', 'c'],
      roots: ['/x', '/x', ''],
      focus: 0,
    })
    expect(owners.map(({ owner }) => owner)).toEqual(['a', 'c'])
  })

  test('with the keyboard elsewhere, the rightmost column draws it', () => {
    const owners = footerOwners({
      shown: ['a', 'b', 'c'],
      roots: ['/x', '/x', ''],
      focus: 2,
    })
    expect(owners.map(({ owner }) => owner)).toEqual(['b', 'c'])
  })
})
