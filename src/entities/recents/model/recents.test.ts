import { beforeEach, expect, test } from 'bun:test'

import { recentDirs, rememberDir } from './recents'

beforeEach(() => localStorage.clear())

test('no history yet reads as an empty list', () => {
  expect(recentDirs()).toEqual([])
})

test('the newest directory comes first', () => {
  rememberDir('/a')
  rememberDir('/b')
  expect(recentDirs()).toEqual(['/b', '/a'])
})

test('revisiting a directory moves it to the front instead of duplicating it', () => {
  rememberDir('/a')
  rememberDir('/b')
  rememberDir('/a')
  expect(recentDirs()).toEqual(['/a', '/b'])
})

test('history is capped at eight entries', () => {
  for (let index = 0; index < 12; index += 1) rememberDir(`/dir-${index}`)
  expect(recentDirs()).toHaveLength(8)
  expect(recentDirs()[0]).toBe('/dir-11')
})

test('corrupt storage degrades to an empty list', () => {
  localStorage.setItem('muster.recent-dirs', '{not json')
  expect(recentDirs()).toEqual([])
})

test('non-string entries are discarded', () => {
  localStorage.setItem('muster.recent-dirs', JSON.stringify(['/a', 7, null]))
  expect(recentDirs()).toEqual(['/a'])
})
