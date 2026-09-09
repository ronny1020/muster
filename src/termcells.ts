/**
 * Turning a terminal row into text you can match, and mapping the result back
 * to the cells it came from.
 *
 * Two things make a string offset the wrong answer for a column. A wide glyph
 * — CJK, most emoji — occupies two cells but one character, so every offset
 * after it drifts. And a long line is stored as several rows, so a path can
 * start on one row and end on the next.
 *
 * Typed structurally rather than against xterm's own interfaces, so the
 * mapping can be tested without a terminal.
 */

export interface Cell {
  getChars(): string
  /** 2 for a wide glyph, 0 for the placeholder cell that follows it. */
  getWidth(): number
}

export interface BufferLine {
  isWrapped: boolean
  length: number
  getCell(index: number): Cell | undefined
}

export interface Buffer {
  getLine(index: number): BufferLine | undefined
}

/** Where one character of the flattened text sits in the buffer. */
export interface CellPosition {
  /** 1-based column, as xterm's ranges expect. */
  x: number
  /** 1-based buffer row. */
  y: number
}

export interface FlatRow {
  text: string
  /** One entry per character of `text`. */
  positions: CellPosition[]
}

/**
 * The whole logical line containing buffer row `index`, with every character
 * mapped back to its cell.
 *
 * A wrapped line is reassembled from all of its rows, so a path split across a
 * wrap is matched once and points at the right place.
 */
export function flattenLogicalLine(buffer: Buffer, index: number): FlatRow {
  const text: string[] = []
  const positions: CellPosition[] = []

  for (let row = firstRowOfLine(buffer, index); ; row += 1) {
    const line = buffer.getLine(row)
    if (!line) break
    if (row !== firstRowOfLine(buffer, index) && !line.isWrapped) break

    for (let column = 0; column < line.length; column += 1) {
      const cell = line.getCell(column)
      if (!cell) continue
      // Width 0 is the placeholder that follows a wide glyph: it holds no
      // character of its own and must not consume an offset.
      if (cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (const character of chars) {
        text.push(character)
        positions.push({ x: column + 1, y: row + 1 })
      }
    }
  }

  return { text: text.join(''), positions }
}

/** Walks back over wrapped rows to the row the logical line starts on. */
function firstRowOfLine(buffer: Buffer, index: number): number {
  let row = index
  while (row > 0 && buffer.getLine(row)?.isWrapped) row -= 1
  return row
}

/**
 * The buffer range covering `[start, end)` of a flattened line, or `null` when
 * the offsets fall outside it.
 */
export function rangeOf(
  flat: FlatRow,
  start: number,
  end: number,
): { start: CellPosition; end: CellPosition } | null {
  const first = flat.positions[start]
  // Ranges are inclusive at both ends, so the last character is `end - 1`.
  const last = flat.positions[end - 1]
  return first && last ? { start: first, end: last } : null
}
