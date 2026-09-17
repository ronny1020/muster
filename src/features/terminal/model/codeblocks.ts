import { type Mark, MAX_SCANNED, type MessageBuffer } from './messages'

/**
 * The headers an agent prints when it touches a file, which is how the output
 * around a row is attributed to one.
 *
 * Measured over 4.1 MB of recorded sessions on this machine: Claude Code
 * names the file **after** the fact and with a space — `Updated` 320 times,
 * `Created` 44, `Deleted` 7 — and printed `Read(…)`, `Write(…)` or
 * `Update(…)` not once. The parenthesised form is kept for the CLIs that do
 * write it, and `Bash(…)` is deliberately not among the verbs: it names a
 * command, not a file.
 *
 * The past-tense form needs an extension on the path, or an ordinary sentence
 * about having updated something reads as a filename.
 */
const TOUCHED = [
  /(?:^|[\s⏺⎿·])(?:Updated|Created|Deleted|Wrote|Renamed)\s+([~\w@./-]*[\w-]\.[A-Za-z]{1,6})\b/,
  /(?:^|\s)(?:Update|Write|Edit|Read|Create|Delete|MultiEdit)\(([^)]{1,200})\)/,
]

/** The file a single rendered row names, if it names one. */
function pathOn(row: string): string | null {
  for (const pattern of TOUCHED) {
    const found = pattern.exec(row)
    if (found) return found[1]!
  }
  return null
}

/**
 * How far above the viewport to look before giving up.
 *
 * Far enough to cross a long diff or a wall of tool output, short enough that
 * scrolling stays cheap — this runs on every scroll, not once per session.
 */
const LOOK_BACK = 400

/** A file the output names: as the agent printed it, and as it is shown. */
export interface NamedFile {
  /** What the agent printed, so the reader can be asked to open it. */
  path: string
  /** The tail of it, which is what identifies the file in a narrow strip. */
  label: string
}

/**
 * The file the row is inside, or `null` when nothing above it names one.
 *
 * Pass the **last** visible row, not the first: a session sitting at the
 * bottom has the agent's most recent `Updated …` on screen, and searching up
 * from the top of the viewport would step straight over it and only ever find
 * files that had already scrolled away.
 *
 * Searched upward rather than by scanning the whole buffer: only the nearest
 * match matters, and it is usually a few lines up.
 *
 * Both forms come back because they answer different questions: the label is
 * what fits beside the scrollbar, and the path is what opens the file.
 */
export function fileAbove(
  buffer: MessageBuffer,
  row: number,
): NamedFile | null {
  const floor = Math.max(0, row - LOOK_BACK)
  for (let at = Math.min(row, buffer.length - 1); at >= floor; at--) {
    const found = pathOn(buffer.getLine(at)?.translateToString(true) ?? '')
    if (!found) continue
    const label = tidy(found)
    // An agent elides a long path to `…`, which names nothing: keep looking
    // rather than labelling the strip with punctuation.
    if (readable(label)) return { path: found.trim(), label }
  }
  return null
}

/** Whether a captured path carries anything that identifies a file. */
const readable = (path: string) => /[\p{L}\p{N}]/u.test(path)

/**
 * The path as it is worth showing: agents print absolute paths and `~` ones,
 * and the tail is what identifies the file in a strip a few characters wide.
 */
function tidy(path: string): string {
  const parts = path.trim().split('/').filter(Boolean)
  return parts.slice(-2).join('/') || path.trim()
}

/**
 * How many file marks the ruler can carry and still say something.
 *
 * The bar is a few hundred pixels tall, so past this the marks merge into one
 * line — which says the session touched files, the thing you already knew.
 */
const MAX_FILE_MARKS = 40

/**
 * How far below its header a file's mark may reach.
 *
 * Headers tile the scrollback — every row belongs to the nearest one above it
 * — so a block left to run until the next header painted 93% of the bar in one
 * colour, which says no more than an unmarked bar does. What the mark is for
 * is where a file was *touched*, and an agent prints that in the rows just
 * below the header: the diff, the counts, the confirmation.
 *
 * The number is small because the ruler is already generous. A mark there is
 * never thinner than `clamp(canvasHeight / bufferLines, 6, 12)` device pixels,
 * so one row already draws as a band — the span's job is only to make a large
 * edit read taller than a one-line one. Eighty rows stacked ten of those
 * minimums and tiled the bar again; this leaves the gaps that make the marks
 * worth looking at.
 */
const MAX_BLOCK_ROWS = 24

/**
 * Every file the scrollback names, newest first, as the span of output it owns.
 *
 * The label beside the bar answers "what am I looking at" for one position;
 * these answer "where was each file touched" for the whole session, which is
 * why this scans rather than walking up from one row. It shares `MAX_SCANNED`
 * with `findMessageRows`, which bounds the walk for the same reason there —
 * but not its match cap: `MAX_MARKS` is what the rail can draw as clickable
 * dots, where `MAX_FILE_MARKS` is what the ruler can show before the marks
 * merge.
 *
 * The two surfaces answer those different questions with different extents,
 * and that is deliberate: a row a hundred lines below a header still reads as
 * that file's in the label, and is not part of its mark.
 */
export function findFileBlocks(
  buffer: MessageBuffer,
  limit = MAX_FILE_MARKS,
): Mark[] {
  const found: Mark[] = []
  const floor = Math.max(0, buffer.length - MAX_SCANNED)
  // Walking up, the previous header found is where this block has to stop.
  let nextHeader = buffer.length
  for (
    let row = buffer.length - 1;
    row >= floor && found.length < limit;
    row--
  ) {
    const named = pathOn(buffer.getLine(row)?.translateToString(true) ?? '')
    if (!named) continue
    const label = tidy(named)
    if (!readable(label)) continue
    found.push({
      row,
      endRow: Math.min(nextHeader - 1, row + MAX_BLOCK_ROWS),
      label,
    })
    nextHeader = row
  }
  return found
}
