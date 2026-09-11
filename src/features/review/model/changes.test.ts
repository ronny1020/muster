import { describe, expect, test } from 'bun:test'

import {
  absolutePath,
  changeTotals,
  folderOf,
  matchChanged,
  relativeTo,
  sortChanges,
  statusMark,
} from './changes'
import type { ChangedFile } from '../../../shared/ipc'

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: 'modified',
  oldPath: null,
  insertions: 1,
  deletions: 0,
  binary: false,
  counted: true,
  ...over,
})

describe('sortChanges', () => {
  test('a file’s neighbours in the list are its neighbours on disk', () => {
    // git reports tracked files first and untracked ones after, so without
    // this the two passes interleave two alphabetical runs.
    const sorted = sortChanges([
      file('src/b.ts'),
      file('README.md'),
      file('src/a.ts', { status: 'untracked' }),
      file('docs/z.md'),
    ])

    expect(sorted.map((entry) => entry.path)).toEqual([
      'README.md',
      'docs/z.md',
      'src/a.ts',
      'src/b.ts',
    ])
  })

  test('case never decides the order', () => {
    const sorted = sortChanges([file('src/Zebra.ts'), file('src/apple.ts')])

    expect(sorted[0]!.path).toBe('src/apple.ts')
  })

  test('the input is left alone, because it is state elsewhere', () => {
    const files = [file('b.ts'), file('a.ts')]
    sortChanges(files)

    expect(files[0]!.path).toBe('b.ts')
  })
})

describe('matchChanged', () => {
  const files = [file('src/App.tsx'), file('src-tauri/src/pty.rs')]

  test('a path clicked in the terminal finds its changed file', () => {
    const found = matchChanged(files, '/code/app/src/App.tsx', '/code/app')

    expect(found?.path).toBe('src/App.tsx')
  })

  test('a file outside the repository matches nothing', () => {
    // It would otherwise match by suffix and open the wrong file's diff.
    expect(
      matchChanged(files, '/tmp/other/src/App.tsx', '/code/app'),
    ).toBeNull()
  })

  test('an unchanged file inside the repository matches nothing', () => {
    expect(
      matchChanged(files, '/code/app/src/main.tsx', '/code/app'),
    ).toBeNull()
  })

  test('a Windows path matches the forward slashes git reports', () => {
    const found = matchChanged(
      files,
      'C:\\code\\app\\src-tauri\\src\\pty.rs',
      'C:\\code\\app',
    )

    expect(found?.path).toBe('src-tauri/src/pty.rs')
  })

  test('a drive letter spelled the other way still matches', () => {
    // Agents print `c:\…` as often as `C:\…`, and Windows treats them alike.
    const found = matchChanged(
      files,
      'c:\\code\\app\\src\\App.tsx',
      'C:\\code\\app',
    )

    expect(found?.path).toBe('src/App.tsx')
  })

  test('an exactly-cased match wins over a case-folded one', () => {
    // Two files differing only in case are legal on Linux, and the click has
    // to reach the one the user actually named.
    const pair = [file('src/app.tsx'), file('src/App.tsx')]
    const found = matchChanged(pair, '/code/app/src/App.tsx', '/code/app')

    expect(found?.path).toBe('src/App.tsx')
  })

  test('a trailing separator on the root changes nothing', () => {
    expect(
      matchChanged(files, '/code/app/src/App.tsx', '/code/app/')?.path,
    ).toBe('src/App.tsx')
  })
})

describe('relativeTo', () => {
  test('the root itself is the empty path, not a non-match', () => {
    expect(relativeTo('/code/app', '/code/app')).toBe('')
  })

  test('a sibling whose name merely starts the same way is outside', () => {
    // `/code/app2` must not become `2` inside `/code/app`.
    expect(relativeTo('/code/app2/src/a.ts', '/code/app')).toBeNull()
  })
})

test('an absolute path is rebuilt from the root and the git path', () => {
  expect(absolutePath('/code/app/', 'src/App.tsx')).toBe(
    '/code/app/src/App.tsx',
  )
  expect(absolutePath('C:\\code\\app', 'src/App.tsx')).toBe(
    'C:/code/app/src/App.tsx',
  )
})

test('a file at the root has no folder', () => {
  expect(folderOf('README.md')).toBe('')
  expect(folderOf('src/features/review/ui/DiffView.tsx')).toBe(
    'src/features/review/ui',
  )
})

test('totals add up across the whole list', () => {
  const totals = changeTotals([
    file('a.ts', { insertions: 3, deletions: 1 }),
    file('b.ts', { insertions: 0, deletions: 9 }),
  ])

  expect(totals).toEqual({ files: 2, insertions: 3, deletions: 10 })
})

test('every status has a mark of its own', () => {
  const marks = (
    [
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'conflicted',
      'typechange',
      'untracked',
    ] as const
  ).map(statusMark)

  expect(new Set(marks).size).toBe(marks.length)
})
