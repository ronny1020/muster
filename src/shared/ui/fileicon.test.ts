import { describe, expect, test } from 'bun:test'

import {
  fileIconName,
  fileIconUrl,
  folderIconName,
  folderIconUrl,
} from './fileicon'
import {
  DEFAULT_FOLDER,
  DEFAULT_ICON,
  FILE_EXTENSIONS,
  FILE_NAMES,
  FOLDER_NAMES,
  ICON_URLS,
} from './materialicons'

describe('fileIconName', () => {
  test('languages that used to share one glyph are told apart', () => {
    expect(fileIconName('a.ts')).toBe('typescript')
    expect(fileIconName('a.tsx')).toBe('react_ts')
    expect(fileIconName('a.rs')).toBe('rust')
  })

  test('a known file name wins over its extension', () => {
    expect(fileIconName('README.md')).toBe('readme')
    expect(fileIconName('AGENTS.md')).toBe('agent')
    expect(fileIconName('CLAUDE.md')).toBe('claude')
    expect(fileIconName('notes.md')).toBe('markdown')
  })

  test('the longest extension the theme knows wins', () => {
    expect(fileIconName('types.d.ts')).toBe('typescript-def')
    expect(fileIconName('edits.test.ts')).toBe('test-ts')
  })

  test('a full path is judged by its filename, not its folders', () => {
    expect(fileIconName('src/features/review/ui/DiffView.tsx')).toBe('react_ts')
    expect(fileIconName('C:\\code\\app\\main.rs')).toBe('rust')
  })

  test('case never decides the icon, because filesystems disagree about it', () => {
    expect(fileIconName('README.MD')).toBe(fileIconName('readme.md'))
    expect(fileIconName('App.TSX')).toBe('react_ts')
  })

  test('a name the theme qualifies with a folder matches only in that folder', () => {
    expect(fileIconName('/repo/.config/graphqlrc')).toBe('graphql')
    expect(fileIconName('/repo/graphqlrc')).not.toBe('graphql')
  })

  test('a filename that is an object property name finds no icon of its own', () => {
    // The tables are plain objects; `constructor` must not find `Object`.
    expect(fileIconName('constructor')).toBe(DEFAULT_ICON)
    expect(fileIconName('x.__proto__')).toBe(DEFAULT_ICON)
  })

  test('a name the theme does not know gets its default file icon', () => {
    expect(fileIconName('unknown.zzz')).toBe(DEFAULT_ICON)
    expect(fileIconName('LICENSE-ish')).toBe(DEFAULT_ICON)
  })
})

describe('the generated tables', () => {
  test('come from the installed theme, not the empty stand-in', () => {
    // An empty table would leave every row without an icon, and nothing else
    // would fail.
    expect(Object.keys(FILE_NAMES).length).toBeGreaterThan(100)
    expect(Object.keys(FILE_EXTENSIONS).length).toBeGreaterThan(100)
  })

  test('every icon a table can name has a bundled file', () => {
    const named = new Set([
      DEFAULT_ICON,
      ...Object.values(FILE_NAMES),
      ...Object.values(FILE_EXTENSIONS),
    ])
    const missing = [...named].filter((icon) => !ICON_URLS[icon])
    expect(missing).toEqual([])
    expect(fileIconUrl('a.ts')).toMatch(/typescript\.svg$/)
  })
})

describe('folderIconName', () => {
  test('a folder the theme names gets its own icon, open or closed', () => {
    expect(folderIconName('/repo/src', false)).toBe('folder-src')
    expect(folderIconName('/repo/src', true)).toBe('folder-src-open')
    expect(folderIconName('/repo/.github', false)).toBe('folder-github')
  })

  test('a folder the theme names with its parent matches only there', () => {
    expect(folderIconName('/repo/.github/workflows', false)).toBe(
      'folder-gh-workflows',
    )
    expect(folderIconName('/repo/workflows', false)).toBe(DEFAULT_FOLDER)
  })

  test('any other folder gets the plain one', () => {
    expect(folderIconName('/repo/zzz-unnamed', false)).toBe(DEFAULT_FOLDER)
    expect(folderIconName('/repo/constructor', true)).toBe(
      `${DEFAULT_FOLDER}-open`,
    )
  })

  test('every folder icon, open and closed, has a bundled file', () => {
    const named = [DEFAULT_FOLDER, ...Object.values(FOLDER_NAMES)]
    const missing = named
      .flatMap((icon) => [icon, `${icon}-open`])
      .filter((icon) => !ICON_URLS[icon])
    expect(missing).toEqual([])
    expect(folderIconUrl('/repo/src', true)).toMatch(/folder-src-open\.svg$/)
  })
})
