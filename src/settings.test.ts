import { beforeEach, expect, test } from 'bun:test'

import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from './settings'

beforeEach(() => localStorage.clear())

test('an empty object yields the defaults', () => {
  expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
})

test('junk in place of settings yields the defaults', () => {
  for (const junk of [null, undefined, 7, 'settings', []]) {
    expect(normalizeSettings(junk)).toEqual(DEFAULT_SETTINGS)
  }
})

test('known values are kept', () => {
  expect(normalizeSettings({ fontSize: 16, cursorBlink: false }).fontSize).toBe(
    16,
  )
  expect(normalizeSettings({ cursorBlink: false }).cursorBlink).toBe(false)
})

test('numbers are clamped to their range instead of rejected', () => {
  expect(normalizeSettings({ fontSize: 400 }).fontSize).toBe(28)
  expect(normalizeSettings({ fontSize: 1 }).fontSize).toBe(9)
  expect(normalizeSettings({ scrollback: -5 }).scrollback).toBe(1000)
})

test('a numeric string is accepted, a non-numeric one is not', () => {
  expect(normalizeSettings({ fontSize: '15' }).fontSize).toBe(15)
  expect(normalizeSettings({ fontSize: 'large' }).fontSize).toBe(
    DEFAULT_SETTINGS.fontSize,
  )
})

test('NaN and Infinity fall back rather than clamping', () => {
  expect(normalizeSettings({ lineHeight: NaN }).lineHeight).toBe(
    DEFAULT_SETTINGS.lineHeight,
  )
  expect(normalizeSettings({ lineHeight: Infinity }).lineHeight).toBe(
    DEFAULT_SETTINGS.lineHeight,
  )
})

test('a blank font family falls back, but a blank directory is a real choice', () => {
  expect(normalizeSettings({ fontFamily: '   ' }).fontFamily).toBe(
    DEFAULT_SETTINGS.fontFamily,
  )
  expect(normalizeSettings({ defaultDirectory: '  ' }).defaultDirectory).toBe(
    '',
  )
})

test('a directory is trimmed', () => {
  expect(
    normalizeSettings({ defaultDirectory: ' /work/repo ' }).defaultDirectory,
  ).toBe('/work/repo')
})

test('unknown keys are dropped', () => {
  expect(normalizeSettings({ hackTheGibson: true })).toEqual(DEFAULT_SETTINGS)
})

test('settings survive a save and load round trip', () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    fontSize: 17,
    defaultDirectory: '/work',
  }
  saveSettings(settings)
  expect(loadSettings()).toEqual(settings)
})

test('corrupt storage loads the defaults', () => {
  localStorage.setItem('muster.settings', '{not json')
  expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
})

test('a stored value outside its range is repaired on load', () => {
  localStorage.setItem('muster.settings', JSON.stringify({ fontSize: 999 }))
  expect(loadSettings().fontSize).toBe(28)
})

test('the backend falls back to the host for anything that is not wsl', () => {
  expect(normalizeSettings({ defaultBackend: 'wsl' }).defaultBackend).toBe(
    'wsl',
  )
  expect(normalizeSettings({ defaultBackend: 'native' }).defaultBackend).toBe(
    'native',
  )
  expect(normalizeSettings({ defaultBackend: 'docker' }).defaultBackend).toBe(
    'native',
  )
  expect(normalizeSettings({ defaultBackend: 7 }).defaultBackend).toBe('native')
})

test('a blank distro is kept, since it means whichever one wsl defaults to', () => {
  expect(normalizeSettings({ defaultDistro: '' }).defaultDistro).toBe('')
  expect(normalizeSettings({ defaultDistro: '  Ubuntu  ' }).defaultDistro).toBe(
    'Ubuntu',
  )
})

test('notifications are on by default, and quiet while you are watching', () => {
  expect(DEFAULT_SETTINGS.notifyOnDone).toBe(true)
  expect(DEFAULT_SETTINGS.notifyOnlyWhenUnfocused).toBe(true)
})

test('notification flags round trip and reject non-booleans', () => {
  expect(normalizeSettings({ notifyOnDone: false }).notifyOnDone).toBe(false)
  expect(normalizeSettings({ notifyOnDone: 'yes' }).notifyOnDone).toBe(true)
  expect(normalizeSettings({ notifySound: 0 }).notifySound).toBe(true)
})
