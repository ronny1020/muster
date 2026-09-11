import { expect, test } from 'bun:test'

import { preferredEditor } from './useEditors'
import type { Editor } from '../ipc'

const code: Editor = { command: 'code', name: 'VS Code' }
const zed: Editor = { command: 'zed', name: 'Zed' }

test('no editor found means no button', () => {
  expect(preferredEditor([], '')).toBeNull()
  expect(preferredEditor([], 'code')).toBeNull()
})

test('no preference falls back to the first one available', () => {
  expect(preferredEditor([code, zed], '')).toBe(code)
})

test('a stated preference wins wherever it sits in the list', () => {
  expect(preferredEditor([code, zed], 'zed')).toBe(zed)
})

test('a preference for an editor that is gone falls back rather than breaking', () => {
  expect(preferredEditor([code], 'webstorm')).toBe(code)
})
