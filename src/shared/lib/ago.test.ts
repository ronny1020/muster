import { expect, test } from 'bun:test'

import { agoLabel, relativeAge } from './ago'
import { i18n } from '../i18n/i18n'

const american = i18n.getFixedT('en-US', 'common')

const NOW = 1_700_000_000_000

test('a moment ago reads as just now', () => {
  expect(agoLabel(NOW / 1000 - 5, NOW, american)).toBe('just now')
})

test('ages coarsen from minutes to hours to days', () => {
  expect(agoLabel(NOW / 1000 - 90, NOW, american)).toBe('1m ago')
  expect(agoLabel(NOW / 1000 - 3 * 3600, NOW, american)).toBe('3h ago')
  expect(agoLabel(NOW / 1000 - 50 * 3600, NOW, american)).toBe('2d ago')
})

test('a clock that has gone backwards still reads as an age', () => {
  // A record written on a machine whose clock was later corrected would
  // otherwise show a negative age, which reads as a bug in the app.
  expect(agoLabel(NOW / 1000 + 600, NOW, american)).toBe('just now')
})

test('the label is written in the catalog it is given', () => {
  expect(
    agoLabel(NOW / 1000 - 3 * 3600, NOW, i18n.getFixedT('zh-TW', 'common')),
  ).toBe('3 小時前')
})

test('a full age climbs through weeks and months to years', () => {
  const ago = (seconds: number) =>
    relativeAge(NOW / 1000 - seconds, NOW, 'en-US')
  expect(ago(3 * 3600)).toBe('3 hours ago')
  expect(ago(15 * 86400)).toBe('2 weeks ago')
  expect(ago(100 * 86400)).toBe('3 months ago')
  expect(ago(800 * 86400)).toBe('2 years ago')
})

test('a rounded-down age is never worded as a calendar neighbour', () => {
  const ago = (seconds: number) =>
    relativeAge(NOW / 1000 - seconds, NOW, 'en-US')
  expect(ago(13 * 86400)).toBe('1 week ago')
  expect(ago(700 * 86400)).toBe('1 year ago')
})

test('a full age is worded in the locale it is given', () => {
  expect(relativeAge(NOW / 1000 - 3 * 3600, NOW, 'ja')).toBe('3 時間前')
})
