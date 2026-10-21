/**
 * The `:12` or `:12-30` that follows a path to name lines in it — the form
 * agents print and read, and the one the terminal makes clickable.
 *
 * Empty for no lines, so the reference is the bare path.
 */
export function lineSuffix(lines: Iterable<number>): string {
  let first = Infinity
  let last = -Infinity
  for (const line of lines) {
    if (!Number.isInteger(line) || line < 1) continue
    first = Math.min(first, line)
    last = Math.max(last, line)
  }
  if (first === Infinity) return ''
  return first === last ? `:${first}` : `:${first}-${last}`
}

/**
 * A dropped path's text with the line suffix joined onto it — `'a b.ts':12 `.
 * A path the drop refused stays refused: a suffix alone names nothing.
 */
export function withSuffix(dropped: string, suffix: string): string {
  if (!suffix || !dropped.trim()) return dropped
  return `${dropped.trimEnd()}${suffix} `
}
