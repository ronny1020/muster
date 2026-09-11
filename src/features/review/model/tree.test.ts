import { describe, expect, test } from 'bun:test'

import { visibleEntries } from './tree'
import type { DirEntry } from '../../../shared/ipc'

const entry = (name: string, directory = false): DirEntry => ({
  name,
  path: `/code/app/${name}`,
  directory,
  bytes: 0,
  symlink: false,
  ignored: false,
})

describe('visibleEntries', () => {
  test('folders come first, then names, whatever their case', () => {
    const shown = visibleEntries(
      [
        entry('README.md'),
        entry('src', true),
        entry('build.ts'),
        entry('Docs', true),
      ],
      false,
    )

    // Case-insensitive, so `README.md` sorts by its `r` and lands last.
    expect(shown.map((item) => item.name)).toEqual([
      'Docs',
      'src',
      'build.ts',
      'README.md',
    ])
  })

  test('the repository’s own bookkeeping is never shown', () => {
    // `.git` holds thousands of files and none of them are the user's.
    const shown = visibleEntries(
      [entry('.git', true), entry('src', true)],
      true,
    )

    expect(shown.map((item) => item.name)).toEqual(['src'])
  })

  test('dotfiles are hidden until asked for', () => {
    const all = [entry('.env'), entry('src', true)]

    expect(visibleEntries(all, false).map((item) => item.name)).toEqual(['src'])
    expect(visibleEntries(all, true).map((item) => item.name)).toEqual([
      'src',
      '.env',
    ])
  })
})
