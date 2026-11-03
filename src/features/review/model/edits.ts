/**
 * Edits as they land: which files moved between two reads of the working
 * tree, and which lines each move added or took away.
 *
 * Pure, so the attribution — the part a live view gets wrong silently — is
 * testable without git or a timer.
 */
import type { ChangedFile, ChangeStatus } from '../../../shared/ipc'
import { type DiffLine, parsePatch } from './diff'

/** One file changing once, as the live surfaces draw it. */
export interface Edit {
  /** Unique within a pane, and increasing, so newer always sorts first. */
  id: number
  /** Repo-relative, as git reports it. */
  path: string
  /** The repository root `path` is relative to. */
  root: string
  /** `null` when the edit took the file back to its committed state. */
  status: ChangeStatus | null
  /** Where a renamed file came from, so its diff pairs the two names. */
  oldPath?: string
  /** Lines this edit added and removed — not the file's running total. */
  added: number
  removed: number
  /** The lines themselves, capped at `MAX_LINES`. */
  lines: DiffLine[]
  /** `Date.now()` when it was seen. */
  at: number
}

/** A file whose entry differs between two reads. */
export interface Moved {
  path: string
  status: ChangeStatus | null
}

/**
 * Enough lines to show what an edit was; a rewrite of a whole file is
 * summarised by its counts, not drawn.
 */
export const MAX_LINES = 200

/** Edits a pane remembers. Older ones are in the Changes view and git log. */
export const MAX_FEED = 100

/**
 * The files whose entry moved between `before` and `after`: a new entry, a
 * changed status or count, or an entry gone — which is a file returned to its
 * committed state, and as much an edit as any other.
 *
 * Counts are compared only where both reads have them, since an uncounted
 * entry's zeros are placeholders rather than answers.
 */
export function movedFiles(
  before: ChangedFile[],
  after: ChangedFile[],
): Moved[] {
  const earlier = new Map(before.map((file) => [file.path, file]))
  const moved: Moved[] = []
  for (const file of after) {
    const was = earlier.get(file.path)
    earlier.delete(file.path)
    if (!was || was.status !== file.status || countsDiffer(was, file)) {
      moved.push({ path: file.path, status: file.status })
    }
  }
  for (const gone of earlier.keys()) moved.push({ path: gone, status: null })
  return moved
}

const countsDiffer = (was: ChangedFile, now: ChangedFile) =>
  was.counted &&
  now.counted &&
  (was.insertions !== now.insertions || was.deletions !== now.deletions)

/**
 * What one edit did, from the file's patch before it and after it.
 *
 * Compared as multisets of changed lines, not positions: a hunk shifts
 * whenever an edit above it adds a line, so matching by place would report
 * every line below an edit as new. A line the earlier patch added and the
 * later one no longer has was taken back, and reads as removed; the reverse
 * reads as added.
 */
export function freshLines(before: string, after: string): DiffLine[] {
  const earlier = patchChanges(before)
  const later = patchChanges(after)
  const fresh = without(later, earlier)
  const undone = without(earlier, later).map((line): DiffLine => ({
    ...line,
    kind: line.kind === 'add' ? 'del' : 'add',
  }))
  return [...fresh, ...undone]
}

const patchChanges = (patch: string) =>
  parsePatch(patch).hunks.flatMap((hunk) =>
    hunk.lines.filter((line) => line.kind === 'add' || line.kind === 'del'),
  )

/** `lines` with one occurrence of each of `taken` removed. */
function without(lines: DiffLine[], taken: DiffLine[]): DiffLine[] {
  const counts = new Map<string, number>()
  for (const line of taken) {
    const key = lineKey(line)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return lines.filter((line) => {
    const key = lineKey(line)
    const left = counts.get(key) ?? 0
    if (left === 0) return true
    counts.set(key, left - 1)
    return false
  })
}

const lineKey = (line: DiffLine) => `${line.kind}:${line.text}`

/** How many of `lines` add and remove, for the `+N −M` beside an edit. */
export const tally = (lines: DiffLine[]) => ({
  added: lines.filter((line) => line.kind === 'add').length,
  removed: lines.filter((line) => line.kind === 'del').length,
})

/**
 * How many of five blocks are green and how many red. A side that is not zero
 * always gets a block, so a one-line removal beside a hundred additions still
 * shows.
 */
export function barSplit(added: number, removed: number): [number, number] {
  const total = added + removed
  if (total === 0) return [0, 0]
  const green = Math.round((added / total) * 5)
  if (removed === 0) return [5, 0]
  if (added === 0) return [0, 5]
  const clamped = Math.min(4, Math.max(1, green))
  return [clamped, 5 - clamped]
}

/**
 * `edits` put in front of `feed`, newest first, and the feed held at
 * `MAX_FEED`.
 */
export const withEdits = (feed: Edit[], edits: Edit[]) =>
  [...[...edits].sort((a, b) => b.id - a.id), ...feed].slice(0, MAX_FEED)

/**
 * Each edited path's newest edit, keyed by `keyOf(edit)`. A row pulses when
 * its edit is newer than the list it sits in, and keying the pulse on the
 * edit's id is what plays it again for the next edit — no clock involved.
 */
export function latestByPath(feed: Edit[], keyOf: (edit: Edit) => string) {
  const latest = new Map<string, Edit>()
  for (const edit of feed) {
    const key = keyOf(edit)
    if (!latest.has(key)) latest.set(key, edit)
  }
  return latest
}
