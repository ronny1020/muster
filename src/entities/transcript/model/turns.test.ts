import { expect, test } from 'bun:test'

import type { Turn } from '../../../shared/ipc'
import { MAX_PLACES, messagesIn } from './turns'

const said = (label: string): Turn => ({
  kind: 'message',
  label,
  text: label,
  path: '',
  at: '',
})
const touched = (path: string): Turn => ({
  kind: 'file',
  label: path.split('/').pop() ?? path,
  text: '',
  path,
  at: '',
})

test('messages keep the order they were sent in', () => {
  expect(messagesIn([said('first'), touched('/a.ts'), said('second')])).toEqual(
    [
      { label: 'first', text: 'first', path: '', at: '' },
      { label: 'second', text: 'second', path: '', at: '' },
    ],
  )
})

test('a long conversation keeps its newest messages', () => {
  // The rail clips past a dozen dots at the window's floor, so the cap
  // belongs here rather than in the component that draws them.
  const many = Array.from({ length: MAX_PLACES + 5 }, (_, i) => said(`m${i}`))
  const kept = messagesIn(many)
  expect(kept).toHaveLength(MAX_PLACES)
  expect(kept.at(-1)?.label).toBe(`m${MAX_PLACES + 4}`)
})

test('a transcript with nothing in it yields no places', () => {
  expect(messagesIn([])).toEqual([])
})
