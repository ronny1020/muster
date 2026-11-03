import { describe, expect, test } from 'bun:test'

import type { ChangedFile } from '../../../shared/ipc'
import {
  barSplit,
  type Edit,
  freshLines,
  MAX_FEED,
  movedFiles,
  latestByPath,
  tally,
  withEdits,
} from './edits'

const file = (path: string, insertions = 1, deletions = 0): ChangedFile => ({
  path,
  status: 'modified',
  oldPath: null,
  insertions,
  deletions,
  binary: false,
  counted: true,
})

const patch = (...lines: string[]) =>
  `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,${lines.length} +1,${lines.length} @@
${lines.join('\n')}
`

describe('movedFiles', () => {
  test('a second edit to an already-modified file is caught by its counts', () => {
    expect(movedFiles([file('a.ts', 2)], [file('a.ts', 5)])).toEqual([
      { path: 'a.ts', status: 'modified' },
    ])
  })

  test('an untouched file is not reported', () => {
    expect(movedFiles([file('a.ts')], [file('a.ts')])).toEqual([])
  })

  test('a file returned to its committed state is an edit too', () => {
    expect(movedFiles([file('a.ts')], [])).toEqual([
      { path: 'a.ts', status: null },
    ])
  })

  test('uncounted zeros are not read as a change', () => {
    const uncounted = { ...file('a.ts', 0), counted: false }
    expect(movedFiles([file('a.ts', 4)], [uncounted])).toEqual([])
  })
})

describe('freshLines', () => {
  test('only the lines this edit wrote, not the ones already there', () => {
    const before = patch('+one')
    const after = patch('+one', '+two')
    expect(freshLines(before, after).map((line) => line.text)).toEqual(['two'])
  })

  test('a line shifted by an edit above it is not new', () => {
    const before = patch(' ctx', '+kept')
    const after = patch('+above', ' ctx', '+kept')
    expect(freshLines(before, after).map((line) => line.text)).toEqual([
      'above',
    ])
  })

  test('a line the agent took back reads as removed', () => {
    const lines = freshLines(patch('+oops'), '')
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ['del', 'oops'],
    ])
    expect(tally(lines)).toEqual({ added: 0, removed: 1 })
  })

  test('a repeated line counts once per occurrence', () => {
    const after = patch('+}', '+}')
    expect(freshLines(patch('+}'), after)).toHaveLength(1)
  })
})

const edit = (id: number, at = 0, path = `f${id}`): Edit => ({
  id,
  path,
  root: '/r',
  status: 'modified',
  added: 1,
  removed: 0,
  lines: [],
  at,
})

describe('the feed', () => {
  test('newest first, and capped', () => {
    const feed = withEdits([edit(1)], [edit(2), edit(3)])
    expect(feed.map((entry) => entry.id)).toEqual([3, 2, 1])
    const full = Array.from({ length: MAX_FEED }, (_, index) => edit(index))
    expect(withEdits(full, [edit(999)])).toHaveLength(MAX_FEED)
  })

  test('a path pulses for its newest edit, not its first', () => {
    const feed = [edit(3, 0, 'a.ts'), edit(2, 0, 'b.ts'), edit(1, 0, 'a.ts')]
    const latest = latestByPath(feed, (entry) => entry.path)
    expect(latest.get('a.ts')?.id).toBe(3)
    expect(latest.get('b.ts')?.id).toBe(2)
  })
})

describe('barSplit', () => {
  test('a side that is not zero always gets a block', () => {
    expect(barSplit(100, 1)).toEqual([4, 1])
    expect(barSplit(1, 100)).toEqual([1, 4])
  })

  test('one-sided edits fill the bar with their colour', () => {
    expect(barSplit(3, 0)).toEqual([5, 0])
    expect(barSplit(0, 3)).toEqual([0, 5])
    expect(barSplit(0, 0)).toEqual([0, 0])
  })
})
