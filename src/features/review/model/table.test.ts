import { describe, expect, test } from 'bun:test'

import { parseTable, tableDelimiter } from './table'

const csv = (text: string, cells = 1000, columns = 100, characters = 1000) =>
  parseTable(text, { delimiter: ',', cells, columns, characters })

describe('parseTable', () => {
  test('a quoted field keeps its delimiter, line break and doubled quote', () => {
    const { rows } = csv('name,note\n"Lee, A","said ""hi""\nthen left"\n')

    expect(rows).toEqual([
      ['name', 'note'],
      ['Lee, A', 'said "hi"\nthen left'],
    ])
  })

  test('CRLF line endings end a row once, not twice', () => {
    expect(csv('a,b\r\n1,2\r\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('a last row with no trailing newline is kept', () => {
    expect(csv('a,b\n1,2').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('short rows are padded to the widest, so columns stay aligned', () => {
    const table = csv('a,b,c\n1\n')

    expect(table.width).toBe(3)
    expect(table.rows[1]).toEqual(['1', '', ''])
  })

  test('parsing stops at the limit and says there is more', () => {
    const table = csv('h\n1\n2\n3\n', 2)

    expect(table.rows).toEqual([['h'], ['1']])
    expect(table.more).toBe(true)
  })

  test('one wide row counts against the limit for every row it widens', () => {
    // Padding lays out rows times the widest row, so a narrow header must
    // not let one long row multiply the table past the limit.
    const table = csv(`a\n${'x,'.repeat(9)}x\n1\n2\n3\n`, 20)

    expect(table.rows.length * table.width).toBeLessThanOrEqual(20)
    expect(table.more).toBe(true)
  })

  test('a wide row after many narrow ones is refused, not padded into them', () => {
    const table = csv('a\n1\n2\n3\nx,x,x,x\n', 8)

    expect(table.rows).toEqual([['a'], ['1'], ['2'], ['3']])
    expect(table.width).toBe(1)
    expect(table.more).toBe(true)
  })

  test('cells past the column limit are dropped and the table says so', () => {
    const table = csv('a,b,c,d\n', 1000, 2)

    expect(table.rows).toEqual([['a', 'b']])
    expect(table.clipped).toBe(true)
  })

  test('an empty file is an empty table, not a row of one empty cell', () => {
    expect(csv('')).toEqual({
      rows: [],
      width: 0,
      more: false,
      clipped: false,
      shortened: false,
    })
  })

  test('a row refused by the cell limit does not report clipped columns', () => {
    // The notice describes rows the table shows, and this one is not.
    const table = csv('a\n1\n2\nx,x,x,x\n', 6, 3)

    expect(table.rows).toEqual([['a'], ['1'], ['2']])
    expect(table.clipped).toBe(false)
  })

  test('an unclosed quote is one cell, cut to the character limit', () => {
    // It swallows the rest of the file: one cell to the count, and every
    // byte of it to lay out.
    const table = csv(`a\n"${'x\n'.repeat(50)}`, 1000, 100, 10)

    expect(table.rows[1]?.[0]).toBe(`${'x\n'.repeat(5)}…`)
    expect(table.shortened).toBe(true)
  })

  test('a quoted empty field is a record, not a blank line', () => {
    expect(csv('a\n""\n').rows).toEqual([['a'], ['']])
  })

  test('a quoted empty field ending the file is still a record', () => {
    expect(csv('a\n""').rows).toEqual([['a'], ['']])
  })

  test('a field opened at the end of the file is a record, as a typed one is', () => {
    expect(csv('a\n"').rows).toEqual([['a'], ['']])
  })

  test('blank lines are not rows', () => {
    expect(csv('a,b\n\n1,2\n\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('a tab-separated file splits on tabs and leaves commas alone', () => {
    const { rows } = parseTable('a\tb,c\n', {
      delimiter: '\t',
      cells: 10,
      columns: 10,
      characters: 10,
    })

    expect(rows).toEqual([['a', 'b,c']])
  })
})

describe('tableDelimiter', () => {
  test('names the delimiter from the extension, in any case', () => {
    expect(tableDelimiter('/x/data.CSV')).toBe(',')
    expect(tableDelimiter('C:\\x\\data.tsv')).toBe('\t')
  })

  test('anything else is not a table', () => {
    expect(tableDelimiter('/x/notes.md')).toBeNull()
    expect(tableDelimiter('/x/.csv')).toBeNull()
  })

  test('a name the object prototype carries is not an extension', () => {
    expect(tableDelimiter('/x/foo.constructor')).toBeNull()
    expect(tableDelimiter('/x/foo.__proto__')).toBeNull()
  })
})
