import { describe, expect, it } from 'bun:test'

import { clipboardIntent, type KeyChord } from './clipboard'

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
})
