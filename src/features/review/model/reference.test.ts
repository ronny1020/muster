import { describe, expect, test } from 'bun:test'

import { lineSuffix, withSuffix } from './reference'

describe('lineSuffix', () => {
  test('one line names that line', () => {
    expect(lineSuffix([12])).toBe(':12')
  })

  test('a selection names its first and last line, in any order', () => {
    expect(lineSuffix([30, 12, 14])).toBe(':12-30')
  })

  test('no lines is the bare path', () => {
    expect(lineSuffix([])).toBe('')
  })

  test('a row with no line on the new side is not a line', () => {
    // A removed row has no number in the file as it is now.
    expect(lineSuffix([Number.NaN, 0, 7])).toBe(':7')
  })
})

describe('withSuffix', () => {
  test('joins the range to the quoted path, keeping the trailing space', () => {
    expect(withSuffix("'/a b/x.ts' ", ':3-9')).toBe("'/a b/x.ts':3-9 ")
  })

  test('a refused path stays empty rather than typing a bare range', () => {
    expect(withSuffix('', ':3')).toBe('')
  })

  test('no range leaves the drop untouched', () => {
    expect(withSuffix('/x.ts ', '')).toBe('/x.ts ')
  })
})
