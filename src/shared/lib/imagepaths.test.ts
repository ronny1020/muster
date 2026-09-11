import { expect, test } from 'bun:test'

import { isImagePath } from './imagepaths'

test('recognises image extensions, whatever the case', () => {
  for (const path of ['/a/b.png', 'x.JPG', 'd.jpeg', 'i.svg', 'p.WEBP']) {
    expect(isImagePath(path)).toBe(true)
  }
})

test('code and data files are not images', () => {
  for (const path of ['src/App.tsx', 'notes.md', 'a.tar.gz', 'Makefile']) {
    expect(isImagePath(path)).toBe(false)
  }
})

test('a dotfile named like an extension is not an image', () => {
  expect(isImagePath('.png')).toBe(false)
  expect(isImagePath('/home/ada/.png')).toBe(false)
})

test('a Windows path is recognised as an image', () => {
  // A WSL session shows Windows paths, and splitting on `/` alone left the
  // whole path as the filename.
  expect(isImagePath('C:\\Users\\me\\Pictures\\shot.png')).toBe(true)
  expect(isImagePath('C:\\Users\\me\\notes.txt')).toBe(false)
})

test('a leading-dot Windows filename is not an image', () => {
  // The guard only worked once the filename was isolated from the path.
  expect(isImagePath('C:\\Users\\me\\.png')).toBe(false)
})
