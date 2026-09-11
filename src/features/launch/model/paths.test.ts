import { expect, test } from 'bun:test'

import { basename } from './paths'

test('takes the last segment of a unix path', () => {
  expect(basename('/Users/ada/code/project')).toBe('project')
  expect(basename('/home/ada')).toBe('ada')
})

test('takes the last segment of a windows path', () => {
  expect(basename('C:\\Users\\ada\\code\\project')).toBe('project')
  expect(basename('\\\\wsl$\\Ubuntu\\home\\ada\\code')).toBe('code')
})

test('a trailing separator does not swallow the name', () => {
  expect(basename('/Users/ada/code/')).toBe('code')
  expect(basename('C:\\code\\')).toBe('code')
})

test('a root has no segment to take, so it stands for itself', () => {
  expect(basename('/')).toBe('/')
  expect(basename('')).toBe('')
})
