import { expect, test } from 'bun:test'

import { findPaths, resolvePath } from './termlinks'

const paths = (text: string) => findPaths(text).map((match) => match.path)

test('finds an absolute path on its own', () => {
  expect(paths('/tmp/shot.png')).toEqual(['/tmp/shot.png'])
})

test('finds a path in the middle of a sentence', () => {
  expect(paths('wrote src/App.tsx and left it there')).toEqual(['src/App.tsx'])
})

test('finds several paths on one line', () => {
  expect(paths('moved src/a.ts to lib/b.ts')).toEqual(['src/a.ts', 'lib/b.ts'])
})

test('a bare word is not a path, however file-like it looks', () => {
  // The common false positive: prose that happens to name a file.
  expect(paths('check package.json for the version')).toEqual([])
  expect(paths('README and LICENSE')).toEqual([])
})

test('a path needs more than a separator', () => {
  expect(paths('/')).toEqual([])
  expect(paths('//')).toEqual([])
})

test('reads a line number off a compiler-style reference', () => {
  const [match] = findPaths('src/deck.ts:187: unreachable')
  expect(match.path).toBe('src/deck.ts')
  expect(match.line).toBe(187)
  expect(match.column).toBeUndefined()
})

test('reads line and column', () => {
  const [match] = findPaths('at src/App.tsx:42:9')
  expect(match).toMatchObject({ path: 'src/App.tsx', line: 42, column: 9 })
})

test('a trailing sentence period is not part of the path', () => {
  expect(paths('see src/notify.ts.')).toEqual(['src/notify.ts'])
  expect(paths('in /tmp/out.png, then')).toEqual(['/tmp/out.png'])
})

test('quotes and brackets around a path are not part of it', () => {
  expect(paths('"src/a.ts"')).toEqual(['src/a.ts'])
  expect(paths('(see ./lib/b.ts)')).toEqual(['./lib/b.ts'])
  expect(paths('[src/c.ts]')).toEqual(['src/c.ts'])
})

test('leaves URLs alone — the web-links addon owns those', () => {
  expect(paths('https://example.com/a/b')).toEqual([])
  expect(paths('open http://localhost:1420/ now')).toEqual([])
  expect(paths('file:///tmp/x.png')).toEqual([])
})

test('finds a Windows path', () => {
  expect(paths('C:\\Users\\ada\\shot.png')).toEqual([
    'C:\\Users\\ada\\shot.png',
  ])
})

test('offsets point at the whole match, suffix included', () => {
  const text = 'at src/App.tsx:42 today'
  const [match] = findPaths(text)
  expect(text.slice(match.start, match.end)).toBe('src/App.tsx:42')
})

test('an empty line yields nothing', () => {
  expect(findPaths('')).toEqual([])
  expect(findPaths('   ')).toEqual([])
})

test('an absolute path resolves to itself', () => {
  expect(resolvePath('/tmp/a.png', '/work', '/home/ada')).toBe('/tmp/a.png')
})

test('a relative path resolves against the session directory', () => {
  expect(resolvePath('src/a.ts', '/work/repo', '/home/ada')).toBe(
    '/work/repo/src/a.ts',
  )
  expect(resolvePath('./src/a.ts', '/work/repo', '/home/ada')).toBe(
    '/work/repo/src/a.ts',
  )
})

test('a tilde resolves against home, not the session directory', () => {
  expect(resolvePath('~/notes.md', '/work/repo', '/home/ada')).toBe(
    '/home/ada/notes.md',
  )
})

test('resolving does not double a separator', () => {
  expect(resolvePath('src/a.ts', '/work/repo/', '/home/ada')).toBe(
    '/work/repo/src/a.ts',
  )
})

test('a Windows session directory joins with a backslash', () => {
  expect(resolvePath('src\\a.ts', 'C:\\work', 'C:\\Users\\ada')).toBe(
    'C:\\work\\src\\a.ts',
  )
})
