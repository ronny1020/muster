/**
 * The file lines the text selection covers inside `host`, read off the rows'
 * `data-line`. Empty when nothing inside it is selected.
 *
 * Rows rather than offsets: a wrapped row is several screen lines, and only
 * the row knows which line of the file it is. A row the selection only
 * touches at an edge is not covered — a drag that ends at a line's start, or
 * one that starts past a line's end, reaches one row further than the lines
 * it shows selected.
 */
export function selectedLines(host: HTMLElement): number[] {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return []
  const range = selection.getRangeAt(0)
  return [...host.querySelectorAll<HTMLElement>('[data-line]')]
    .filter(
      (row) =>
        range.intersectsNode(row) &&
        !endsAtStartOf(row, range) &&
        !startsAtEndOf(row, range),
    )
    .map((row) => Number(row.dataset.line))
}

/**
 * Whether `range` ends inside `row` before any of its code. Measured from the
 * row's `code`, because the gutter's number is text to a range even though
 * it cannot be selected.
 */
function endsAtStartOf(row: HTMLElement, range: Range): boolean {
  const end = range.endContainer
  if (!row.contains(end) || row.contains(range.startContainer)) return false
  const code = row.querySelector('code')
  if (!code?.contains(end)) return true
  const before = document.createRange()
  before.setStart(code, 0)
  before.setEnd(end, range.endOffset)
  return before.toString() === ''
}

/**
 * Whether `range` starts inside `row` after all of its code. A start in the
 * gutter is before the code, so that row is covered.
 */
function startsAtEndOf(row: HTMLElement, range: Range): boolean {
  const start = range.startContainer
  if (!row.contains(start) || row.contains(range.endContainer)) return false
  const code = row.querySelector('code')
  // An empty line's start is its end too, and a drag from there means it. Its
  // text may be the one space an uncoloured row draws to keep its height.
  if (!code?.contains(start) || code.textContent?.trim() === '') return false
  const after = document.createRange()
  after.setStart(start, range.startOffset)
  after.setEnd(code, code.childNodes.length)
  return after.toString() === ''
}
