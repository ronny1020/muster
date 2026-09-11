/**
 * Reading a unified diff.
 *
 * The backend hands over `git diff` output verbatim, and this turns it into
 * the rows the diff view draws. Kept pure and here rather than in the
 * component so the line numbering — the part that is wrong in most hand-rolled
 * diff viewers — is directly testable.
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'meta'

export interface DiffLine {
  kind: DiffLineKind
  /** Content without the leading marker. */
  text: string
  /** Line number on the old side, or `null` for an added line. */
  oldLine: number | null
  /** Line number on the new side, or `null` for a removed line. */
  newLine: number | null
}

export interface Hunk {
  /** The `@@ … @@` line as git wrote it, section heading included. */
  header: string
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface ParsedDiff {
  hunks: Hunk[]
  /** git refused to diff the contents, so there are no lines to show. */
  binary: boolean
}

/** `@@ -12,7 +12,9 @@ fn main()`, where either count may be left out. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parsePatch(patch: string): ParsedDiff {
  const hunks: Hunk[] = []
  let hunk: Hunk | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[3])
      hunk = { header: line, oldStart: oldLine, newStart: newLine, lines: [] }
      hunks.push(hunk)
      continue
    }

    // `Binary files … differ` replaces the hunks entirely, so it can only be
    // read before the first one.
    if (!hunk) {
      if (
        line.startsWith('Binary files') ||
        line.startsWith('GIT binary patch')
      )
        return { hunks: [], binary: true }
      continue
    }

    const marker = line[0]
    if (marker === '+') {
      hunk.lines.push({
        kind: 'add',
        text: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      })
    } else if (marker === '-') {
      hunk.lines.push({
        kind: 'del',
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      })
    } else if (marker === ' ') {
      hunk.lines.push({
        kind: 'context',
        text: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      })
    } else if (marker === '\\') {
      // "\ No newline at end of file" describes the line above it and numbers
      // nothing of its own.
      hunk.lines.push({
        kind: 'meta',
        text: line.slice(2),
        oldLine: null,
        newLine: null,
      })
    } else {
      // Anything else is the next file's header, or the trailing blank line of
      // the patch. Either way this hunk is over.
      hunk = null
    }
  }

  return { hunks, binary: false }
}

/**
 * Rows a viewer will draw at once.
 *
 * Each row is a flex element with a gutter button and a span per token, so a
 * whole-file diff of something large — the `All` context button on a generated
 * file — is a quarter of a million nodes built synchronously.
 */
export const MAX_ROWS = 5000

export interface Budgeted {
  hunks: Hunk[]
  /** Rows in `hunks`. */
  rows: number
  /** Rows in the diff, which may be more. */
  total: number
}

/**
 * As many whole hunks as fit in the row budget.
 *
 * Whole hunks, because half a hunk under a `@@` header that promises more is
 * worse than an honest "the rest is not shown" — with one exception: a first
 * hunk bigger than the whole budget is cut, since a diff of one enormous hunk
 * is what `All` context produces and it has to yield something.
 */
export function hunksWithin(hunks: Hunk[], budget = MAX_ROWS): Budgeted {
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0)
  if (total <= budget) return { hunks, rows: total, total }

  const shown: Hunk[] = []
  let rows = 0
  for (const hunk of hunks) {
    const room = budget - rows
    if (room <= 0) break
    if (hunk.lines.length <= room) {
      shown.push(hunk)
      rows += hunk.lines.length
      continue
    }
    // Cut only when stopping here would show nothing at all. `All` context
    // asks git for `-U100000`, which answers with the whole file as a single
    // hunk — so a rule that only ever took whole hunks either showed every
    // row of it or none, and showing every row is the freeze this exists to
    // prevent. Anywhere else, a partial hunk under a `@@` header that promises
    // more is worse than stopping cleanly.
    if (rows === 0) {
      shown.push({ ...hunk, lines: hunk.lines.slice(0, room) })
      rows += room
    }
    break
  }
  return { hunks: shown, rows, total }
}

/**
 * Which sides of the diff have numbers at all.
 *
 * A new file is every line added and an erased one is every line removed, so
 * one of the two gutters would be an empty column on every row — a third of
 * the width of a drawer, spent on nothing.
 */
export function usedSides(hunks: Hunk[]): { old: boolean; new: boolean } {
  const lines = hunks.flatMap((hunk) => hunk.lines)
  return {
    old: lines.some((line) => line.oldLine !== null),
    new: lines.some((line) => line.newLine !== null),
  }
}

/**
 * The text of one side of the diff, as the highlighter needs it.
 *
 * Highlighting each hunk on its own would restart the grammar mid-file and
 * mis-colour anything spanning lines, so both sides are reassembled whole —
 * one string per side, in file order — and the tokens are then handed back to
 * the rows by index.
 */
export function sideText(hunks: Hunk[], side: 'old' | 'new'): string {
  return hunks
    .flatMap((hunk) => hunk.lines.filter((line) => onSide(line, side)))
    .map((line) => line.text)
    .join('\n')
}

/**
 * Where each row's text sits in [`sideText`]'s output, by side. A row with no
 * counterpart on a side is absent from that side's index.
 */
export function sideIndex(
  hunks: Hunk[],
  side: 'old' | 'new',
): Map<DiffLine, number> {
  const index = new Map<DiffLine, number>()
  let row = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (onSide(line, side)) index.set(line, row++)
    }
  }
  return index
}

const onSide = (line: DiffLine, side: 'old' | 'new') =>
  line.kind === 'context' || line.kind === (side === 'old' ? 'del' : 'add')
