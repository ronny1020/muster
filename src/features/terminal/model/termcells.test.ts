import { expect, test } from 'bun:test'

import {
  type Buffer,
  type BufferLine,
  flattenLogicalLine,
  rangeOf,
} from './termcells'

/**
 * A row built from `[chars, width]` pairs, the way xterm stores cells: a wide
 * glyph is one cell of width 2 followed by an empty cell of width 0.
 */
function row(cells: [string, number][], isWrapped = false): BufferLine {
  return {
    isWrapped,
    length: cells.length,
    getCell: (index) => {
      const cell = cells[index]
      return cell && { getChars: () => cell[0], getWidth: () => cell[1] }
    },
  }
}

const plain = (text: string, isWrapped = false) =>
  row(
    [...text].map((character) => [character, 1] as [string, number]),
    isWrapped,
  )

const buffer = (lines: BufferLine[]): Buffer => ({
  getLine: (index) => lines[index],
})

test('a plain row flattens to itself, one column per character', () => {
  const flat = flattenLogicalLine(buffer([plain('abc')]), 0)
  expect(flat.text).toBe('abc')
  expect(flat.positions).toEqual([
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
  ])
})

test('a wide glyph takes two columns but one offset', () => {
  // `完` is one character occupying cells 1-2, so `a` is at column 3.
  const flat = flattenLogicalLine(
    buffer([
      row([
        ['完', 2],
        ['', 0],
        ['a', 1],
      ]),
    ]),
    0,
  )
  expect(flat.text).toBe('完a')
  expect(flat.positions).toEqual([
    { x: 1, y: 1 },
    { x: 3, y: 1 },
  ])
})

test('the column after a wide glyph is not the string offset', () => {
  const flat = flattenLogicalLine(
    buffer([
      row([
        ['完', 2],
        ['', 0],
        ['了', 2],
        ['', 0],
        ['x', 1],
      ]),
    ]),
    0,
  )
  // Two wide glyphs: `x` is offset 2 but column 5.
  expect(flat.text.indexOf('x')).toBe(2)
  expect(flat.positions[2]).toEqual({ x: 5, y: 1 })
})

test('a wrapped line is reassembled across its rows', () => {
  const flat = flattenLogicalLine(
    buffer([plain('/long/pa'), plain('th/x.ts', true)]),
    0,
  )
  expect(flat.text).toBe('/long/path/x.ts')
})

test('a wrapped line is found from any of its rows', () => {
  const lines = [plain('/long/pa'), plain('th/x.ts', true)]
  expect(flattenLogicalLine(buffer(lines), 1).text).toBe('/long/path/x.ts')
})

test('a following unwrapped row is a different line and is left out', () => {
  const flat = flattenLogicalLine(buffer([plain('first'), plain('second')]), 0)
  expect(flat.text).toBe('first')
})

test('positions carry the row a character came from', () => {
  const flat = flattenLogicalLine(buffer([plain('ab'), plain('cd', true)]), 0)
  expect(flat.positions.map((p) => p.y)).toEqual([1, 1, 2, 2])
})

test('an empty cell still holds a column, so offsets stay aligned', () => {
  const flat = flattenLogicalLine(
    buffer([
      row([
        ['a', 1],
        ['', 1],
        ['b', 1],
      ]),
    ]),
    0,
  )
  expect(flat.text).toBe('a b')
  expect(flat.positions[2]).toEqual({ x: 3, y: 1 })
})

test('a range is inclusive at both ends', () => {
  const flat = flattenLogicalLine(buffer([plain('abcd')]), 0)
  expect(rangeOf(flat, 1, 3)).toEqual({
    start: { x: 2, y: 1 },
    end: { x: 3, y: 1 },
  })
})

test('a range spanning a wrap carries both rows', () => {
  const flat = flattenLogicalLine(buffer([plain('ab'), plain('cd', true)]), 0)
  expect(rangeOf(flat, 1, 4)).toEqual({
    start: { x: 2, y: 1 },
    end: { x: 2, y: 2 },
  })
})

test('offsets outside the line yield no range rather than a wrong one', () => {
  const flat = flattenLogicalLine(buffer([plain('ab')]), 0)
  expect(rangeOf(flat, 0, 99)).toBeNull()
  expect(rangeOf(flat, 5, 6)).toBeNull()
})

test('a missing row flattens to nothing', () => {
  expect(flattenLogicalLine(buffer([]), 0)).toEqual({ text: '', positions: [] })
})
