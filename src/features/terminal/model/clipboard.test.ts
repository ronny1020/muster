import { describe, expect, it } from 'bun:test'

import { clipboardIntent, clipboardWrite, type KeyChord } from './clipboard'

const chord = (extra: Partial<KeyChord> = {}): KeyChord => ({
  type: 'keydown',
  key: 'c',
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  ...extra,
})

describe('clipboardIntent', () => {
  it('leaves macOS alone, where the native menu already delivers copy', () => {
    expect(clipboardIntent(chord(), true)).toBeNull()
    expect(clipboardIntent(chord({ key: 'v' }), true)).toBeNull()
  })

  it('reads Ctrl+Shift+C as copy elsewhere', () => {
    expect(clipboardIntent(chord(), false)).toBe('copy')
  })

  it('reads Ctrl+Shift+V as paste elsewhere', () => {
    expect(clipboardIntent(chord({ key: 'v' }), false)).toBe('paste')
  })

  it('never claims plain Ctrl+C, which the program needs as SIGINT', () => {
    expect(clipboardIntent(chord({ shiftKey: false }), false)).toBeNull()
  })

  it('ignores the key going back up, so one press is one action', () => {
    expect(clipboardIntent(chord({ type: 'keyup' }), false)).toBeNull()
  })

  it('leaves the chord to the program when another modifier is held', () => {
    expect(clipboardIntent(chord({ altKey: true }), false)).toBeNull()
    expect(clipboardIntent(chord({ metaKey: true }), false)).toBeNull()
  })

  it('accepts the uppercase key browsers report while Shift is down', () => {
    expect(clipboardIntent(chord({ key: 'C' }), false)).toBe('copy')
    expect(clipboardIntent(chord({ key: 'V' }), false)).toBe('paste')
  })

  it('claims nothing for other letters', () => {
    expect(clipboardIntent(chord({ key: 'a' }), false)).toBeNull()
    expect(clipboardIntent(chord({ key: 'x' }), false)).toBeNull()
  })

  it('reads the copy-output chord on every platform, in its own idiom', () => {
    expect(
      clipboardIntent(chord({ key: 'o', ctrlKey: false, metaKey: true }), true),
    ).toBe('copyOutput')
    expect(clipboardIntent(chord({ key: 'o' }), false)).toBe('copyOutput')
  })

  it('leaves the copy-output chord to the program without Shift', () => {
    expect(
      clipboardIntent(
        chord({ key: 'o', shiftKey: false, ctrlKey: false, metaKey: true }),
        true,
      ),
    ).toBeNull()
    expect(
      clipboardIntent(chord({ key: 'o', shiftKey: false }), false),
    ).toBeNull()
  })
})

describe('clipboardWrite', () => {
  const encode = (text: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text)))

  it('decodes a write as UTF-8, which is how Claude Code sends CJK text', () => {
    expect(clipboardWrite(`c;${encode('中文 ✅')}`)).toBe('中文 ✅')
  })

  it('accepts a write that names no selection', () => {
    expect(clipboardWrite(`;${encode('hello')}`)).toBe('hello')
  })

  it('never answers a query, so no process can read the clipboard back', () => {
    expect(clipboardWrite('c;?')).toBeNull()
  })

  it('ignores an empty write rather than clearing the clipboard', () => {
    expect(clipboardWrite('c;')).toBeNull()
  })

  it('refuses text that would end a bracketed paste and type the rest', () => {
    expect(clipboardWrite(`c;${encode('x\x1b[201~rm -rf ~\r')}`)).toBeNull()
    expect(clipboardWrite(`c;${encode('x\x9b201~')}`)).toBeNull()
  })

  it('keeps tabs and line breaks, which copied code is full of', () => {
    expect(clipboardWrite(`c;${encode('a\tb\r\nc')}`)).toBe('a\tb\r\nc')
  })

  it('drops bytes that are not UTF-8 rather than pasting replacement marks', () => {
    expect(clipboardWrite(`c;${btoa('\xff\xfe')}`)).toBeNull()
  })

  it('drops a payload that is not base64 instead of throwing in the parser', () => {
    expect(clipboardWrite('c;not base64!')).toBeNull()
    expect(clipboardWrite('no separator')).toBeNull()
  })
})
