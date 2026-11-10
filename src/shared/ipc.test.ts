import { expect, test } from 'bun:test'

import { describeError } from './ipc'

test('a logged error keeps its message when the stack holds only frames', () => {
  const error = new Error('disk full')
  error.stack = 'write@app.js:1:2'
  expect(describeError(error)).toBe('Error: disk full\nwrite@app.js:1:2')
})

test('a rejection that is not an Error is logged as text', () => {
  expect(describeError('session 3 has closed')).toBe('session 3 has closed')
})
