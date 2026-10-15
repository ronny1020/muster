import { describe, expect, it } from 'bun:test'

import { isPasteable, isPlainPath } from './paste'

describe('isPasteable', () => {
  it('refuses the end marker that would break out of a bracketed paste', () => {
    expect(isPasteable('x\x1b[201~rm -rf ~')).toBe(false)
  })

  it('refuses the one-byte CSI, which needs no escape', () => {
    expect(isPasteable('x\x9b201~')).toBe(false)
  })

  it('keeps tabs and line breaks, which copied code is full of', () => {
    expect(isPasteable('a\tb\r\nc')).toBe(true)
  })
})

describe('isPlainPath', () => {
  it('refuses a filename carrying the paste end marker', () => {
    expect(isPlainPath('src/\x1b[201~evil.ts')).toBe(false)
  })

  it('refuses a filename with a line break, which would submit the line', () => {
    expect(isPlainPath('a\nb.ts')).toBe(false)
  })

  it('keeps an ordinary path, spaces and all', () => {
    expect(isPlainPath('src/My Notes/中文 ✅.md')).toBe(true)
  })
})
