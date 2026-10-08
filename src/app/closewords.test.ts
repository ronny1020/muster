import { expect, test } from 'bun:test'

import { closeWords } from './closewords'
import { i18n } from '../shared/i18n/i18n'

test('the close dialog keeps its count for the backend to fill in', () => {
  const words = closeWords(i18n.getFixedT('en-US', 'chrome'))
  expect(words.quitBodyOne).toStartWith('{{count}} session still running')
  expect(words.quitBodyOther).toStartWith('{{count}} sessions still running')
})

test('the close dialog is worded in the language it is given', () => {
  const words = closeWords(i18n.getFixedT('zh-TW', 'chrome'))
  expect(words.quitTitle).toBe('要結束 Muster 嗎？')
  expect(words.closeBodyOther).toContain('{{count}}')
})
