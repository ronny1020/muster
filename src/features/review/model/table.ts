/**
 * Reading a delimited file — CSV or TSV — as a table for the preview.
 *
 * Agents write these as fixtures, exports and test data, and the source of a
 * thirty-column CSV is not something anyone reads by eye.
 */
export interface Table {
  /** Every row, the header first, each padded to `width` cells. */
  rows: string[][]
  /** The widest row's cell count, after `columns` cut it. */
  width: number
  /** Rows the file holds beyond what was parsed. */
  more: boolean
  /** A kept row held more cells than `columns`, and the rest were dropped. */
  clipped: boolean
  /** A kept cell ran past `characters`, and its end was dropped. */
  shortened: boolean
}

export interface TableLimits {
  delimiter: string
  /** Cells to lay out, padding included: rows times the widest row. */
  cells: number
  /** Cells kept from any one row. */
  columns: number
  /**
   * Characters kept from any one cell. An unclosed quote swallows the rest of
   * the file into one cell, which is one cell to the count above and a
   * megabyte of text to lay out.
   */
  characters: number
}

/** A `Map`, so a name like `x.constructor` is not found on the prototype. */
const DELIMITERS = new Map([
  ['csv', ','],
  ['tsv', '\t'],
])

/** The delimiter a path's extension names, or `null` for a file that is no table. */
export function tableDelimiter(path: string): string | null {
  const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? (DELIMITERS.get(name.slice(dot + 1)) ?? null) : null
}

/**
 * RFC 4180: a quoted field may hold the delimiter, a line break and a doubled
 * quote. Splitting on lines first is the common shortcut, and it breaks every
 * row after the first quoted newline.
 *
 * A table is drawn as real elements, and padding makes every row as wide as
 * the widest, so the limit is on rows times width. A row is refused before it
 * is kept, because one long row late in a file widens every row before it.
 */
export function parseTable(
  text: string,
  { delimiter, cells, columns, characters }: TableLimits,
): Table {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let width = 0
  let clipped = false
  let shortened = false
  let rowClipped = false
  let rowShortened = false
  /** The row so far had a quote in it, so `""` is a record, not a blank. */
  let rowQuoted = false
  let stopped = false
  let i = 0

  const endCell = () => {
    if (row.length >= columns) rowClipped = true
    else if (cell.length > characters) {
      row.push(`${cell.slice(0, characters)}…`)
      rowShortened = true
    } else row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    const blank = row.length === 1 && row[0] === '' && !rowQuoted
    const wider = Math.max(width, row.length)
    if (!blank && (rows.length + 1) * wider > cells) {
      stopped = true
      return
    }
    // A blank line is no record, and a file's trailing one is the usual case.
    if (!blank) {
      rows.push(row)
      width = wider
      clipped ||= rowClipped
      shortened ||= rowShortened
    }
    row = []
    rowClipped = false
    rowShortened = false
    rowQuoted = false
  }

  while (i < text.length && !stopped) {
    const char = text[i]
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 2
        continue
      }
      if (char === '"') quoted = false
      else cell += char
    } else if (char === '"' && cell === '') {
      quoted = true
      rowQuoted = true
    } else if (char === delimiter) {
      endCell()
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      endRow()
    } else {
      cell += char
    }
    i += 1
  }

  // A file without a trailing newline still ends its last row — a closed
  // `""` included, which leaves no text behind to say a row was there.
  const pending = cell !== '' || row.length > 0 || rowQuoted
  if (!stopped && i >= text.length && pending) endRow()
  const more = stopped || i < text.length

  return {
    rows: rows.map((kept) =>
      kept.length < width
        ? [...kept, ...Array<string>(width - kept.length).fill('')]
        : kept,
    ),
    width,
    more,
    clipped,
    shortened,
  }
}
