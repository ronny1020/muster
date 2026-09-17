/**
 * Finding the user's own messages in what an agent drew.
 *
 * A CLI that renders the prompt you typed as a tinted block leaves that tint as
 * the only thing in the stream marking it. Measured on Claude Code; every other
 * agent is untested.
 * The text cannot be matched: the prompt characters differ per agent and change
 * between releases. The cell attribute does not.
 *
 * Reading the buffer rather than the DOM is not a preference. The WebGL
 * renderer paints the grid onto a canvas, so there are no nodes to query.
 */

/** The parts of xterm's buffer this needs, so a test can supply them. */
export interface MessageCell {
  isBgDefault(): boolean
}
export interface MessageLine {
  getCell(column: number): MessageCell | undefined
  translateToString(
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
  ): string
}
export interface MessageBuffer {
  readonly length: number
  getLine(row: number): MessageLine | undefined
}

/**
 * How far into a row to look for the tint.
 *
 * A block indented past this is missed, which is the trade for not walking
 * every column of every row in a 20,000-line scrollback.
 */
const PROBE_COLUMNS = 4

/** Newest first, since the rail shows the most recent and they are what a reader wants. */
const MOST_RECENT_FIRST = (a: Message, b: Message) => b.row - a.row

/** A place in the scrollback with a name: what every ruler mark is. */
export interface Mark {
  row: number
  label: string
  /** The last row the mark covers, when it stands for a span rather than a point. */
  endRow?: number
}

/** Where a message starts, and enough of it to tell one mark from another. */
export type Message = Mark

/**
 * As many marks as the rail can draw and still show every one of them: the
 * window floor is 420px tall, a pane loses the tab strip, the status bar and
 * its inset, and each mark costs 12px plus an 11px gap. Past this the oldest
 * would be clipped while the step buttons still walked it, so the count of
 * dots would stop matching the count of presses.
 */
const MAX_MARKS = 12

/**
 * How far back a single scan reads. Enough to cover many screens of history,
 * and far short of the 200,000-row scrollback a user can configure — the scan
 * runs per frame while output flows, and the buffer API allocates per row.
 * Shared with the file scan, which reads the same buffer for the same reason.
 */
export const MAX_SCANNED = 4000

/** Long enough to recognise a message by, short enough for a tooltip. */
const LABEL_LENGTH = 80

/**
 * The buffer row each user message starts on, newest first.
 *
 * Only the first row of a run: a message spanning five lines is one place to
 * jump to, not five. `limit` is what the rail can draw as evenly spaced dots
 * in a pane's height and still leave each one clickable, and the rail and the
 * step buttons read this one list — so the number of dots is always the number
 * of presses it takes to walk them. It bounds the walk only once that many
 * messages are found, so a buffer of plain output is scanned whole.
 */
export function findMessageRows(
  buffer: MessageBuffer,
  limit = MAX_MARKS,
): Message[] {
  const found: Message[] = []
  let below = false

  // Bounded by rows as well as by matches: the match bound only stops the walk
  // once `limit` messages exist, so a buffer of untinted output was scanned end
  // to end on every frame output arrived.
  const floor = Math.max(0, buffer.length - MAX_SCANNED)
  for (
    let row = buffer.length - 1;
    row >= floor && found.length < limit;
    row--
  ) {
    const tinted = isTinted(buffer.getLine(row))
    // Walking upward, the run's first row is the tinted one whose neighbour
    // above is not — so it is recorded when the tint stops.
    if (below && !tinted) found.push(labelled(buffer, row + 1))
    below = tinted
  }
  // Still inside a tinted run when the walk stopped: it starts at the row the
  // walk reached, which is `floor` — not row 0, whose text is unrelated.
  if (below) found.push(labelled(buffer, floor))

  return found.sort(MOST_RECENT_FIRST)
}

function labelled(buffer: MessageBuffer, row: number): Message {
  // Bounded at the source: a cell accumulates combining marks without limit,
  // so translating a whole row can materialise far more than it can show.
  const text =
    buffer.getLine(row)?.translateToString(true, 0, LABEL_LENGTH * 2) ?? ''
  // The prompt glyph and its padding are the agent's decoration, not the
  // message, and they are what the reader would otherwise see on every mark.
  const cut = text.replace(/^[\s>$❯•│|]+/, '').slice(0, LABEL_LENGTH)
  return { row, label: displayable(cut) }
}

function isTinted(line: MessageLine | undefined): boolean {
  if (!line) return false
  for (let column = 0; column < PROBE_COLUMNS; column++) {
    if (line.getCell(column)?.isBgDefault() === false) return true
  }
  return false
}

/**
 * The newest message that starts above the screen, or `null` if none does.
 *
 * Strictly above, so repeating the gesture walks the list instead of sticking
 * on whatever is already on screen.
 */
export function previousMessage(
  rows: Message[],
  viewportTop: number,
): Message | null {
  return nearest(
    rows.filter(({ row }) => row < viewportTop),
    (a, b) => a > b,
  )
}

/**
 * The oldest message that starts below the screen, or `null` if none does.
 *
 * Compared against the **bottom** of the viewport, not its top: a message
 * already visible in the lower rows is not somewhere to scroll to, and xterm
 * clamps a scroll past the last row to a no-op — so treating it as a target
 * made the button do nothing at the end of a session.
 */
export function nextMessage(
  rows: Message[],
  viewportBottom: number,
): Message | null {
  return nearest(
    rows.filter(({ row }) => row > viewportBottom),
    (a, b) => a < b,
  )
}

/**
 * The message the screen is currently showing, or `null` above the first one.
 *
 * Measured against the bottom of the viewport for the same reason: xterm
 * clamps the top row to `length - rows`, so a message you just sent sits below
 * the top row for its whole first screenful and would never read as current.
 */
export function currentMessage(
  rows: Message[],
  viewportBottom: number,
): Message | null {
  return nearest(
    rows.filter(({ row }) => row <= viewportBottom),
    (a, b) => a > b,
  )
}

/** The candidate whose row `wins` against every other. */
function nearest(
  candidates: Message[],
  wins: (row: number, against: number) => boolean,
): Message | null {
  if (candidates.length === 0) return null
  return candidates.reduce((best, next) =>
    wins(next.row, best.row) ? next : best,
  )
}

/**
 * `text` as something a tooltip and an accessible name can carry, or `''` so
 * the caller's fallback takes over.
 *
 * Two hazards, both chosen by whatever drew the row. A slice counts UTF-16
 * code units, so it can cut a surrogate pair and leave an orphan the platform
 * renders as a replacement glyph. And a run of zero-width characters — which
 * `\s` does not match, so the prompt strip leaves them — is a non-empty string
 * that shows nothing, which would pass an emptiness test and leave a control
 * with no readable name.
 */
function displayable(text: string): string {
  const last = text.charCodeAt(text.length - 1)
  const whole = last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
  const visible = whole.replace(
    /[\u200b-\u200f\u2028\u2029\u2060\u2800\u3164\ufeff]/g,
    '',
  )
  return /\S/.test(visible) ? whole : ''
}
