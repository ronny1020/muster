/**
 * Finding a message again in a session that owns its own scrolling.
 *
 * A clickable agent draws inside the alternate buffer, so there is no
 * scrollback for the terminal to move and `scrollToLine` does nothing — the
 * agent scrolls its own view, and the only thing that moves it is the wheel,
 * which xterm forwards as a mouse report. So a dot seeks: send a burst, read
 * what is on screen, stop when the message is there. Closed-loop because
 * nothing reports the agent's scroll position back.
 */

/** What a seek reads: the rows the agent is showing right now. */
export interface Screen {
  readonly rows: number
  row(index: number): string
}

/**
 * How many bursts to try before giving up.
 *
 * Each is `NOTCHES_PER_LOOK` notches, and a notch is worth whatever the row
 * height makes of it — the event carries pixels, so xterm divides. The reach
 * is therefore a few thousand lines rather than an exact number, and the
 * stall check below almost always ends it sooner anyway.
 */
export const MAX_LOOKS = 40

/**
 * Notches per look.
 *
 * The agent repaints its whole frame for each one and the repaint, not the
 * notch, is what costs: measured at roughly four lines a second sending them
 * one at a time, which is a crawl across a long conversation.
 */
export const NOTCHES_PER_LOOK = 8

/**
 * How many unchanged screens mean the view is not going to move.
 *
 * Two things stop it, and neither reports itself: the top of what the agent
 * kept, and the agent **printing** — it pins its view to the bottom on every
 * repaint, so a seek during a turn is pushed back as fast as it climbs.
 * Measured: 60 notches at a working session moved the top row not one line.
 * Without this the seek spends its whole bound going nowhere, which is how
 * the first version took fifty seconds to fail.
 */
export const MAX_STALLS = 2

/**
 * How much of a message to match on.
 *
 * Enough to be unique in a conversation, short enough to survive the agent
 * re-wrapping the line it is drawn on — at its own width, inside its own
 * frame, with its own prompt marker in front.
 */
const MATCH_CHARS = 36

/**
 * Collapses what the agent drew and what the transcript stored to one form.
 *
 * Box-drawing goes first, and that is not tidiness: the agent wraps a message
 * inside a bordered frame, so the row break falls between two words with a
 * `│` on either side of it. Joining the rows without dropping those leaves
 * the border sitting in the middle of the sentence being matched.
 */
export const normalise = (text: string) =>
  text
    .replace(/[\u2500-\u257f\u2580-\u259f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** The needle a message is sought by, or empty when it is too short to find. */
export function needleFor(label: string): string {
  const flat = normalise(label)
  // A two-word message matches half the session, and landing on the wrong
  // one is worse than not moving.
  return flat.length >= 8 ? flat.slice(0, MATCH_CHARS) : ''
}

/**
 * Whether what the agent is showing contains the message being sought.
 *
 * Searched across the joined screen rather than row by row, because the agent
 * wraps a message to its own width inside its own frame: a needle of a few
 * words lands on two rows as often as one, and a per-row search then walks
 * straight past the message it was sent to find. Measured: a seek for an
 * 82-character prompt scrolled past it and carried on to the top.
 */
export function onScreen(screen: Screen, needle: string): boolean {
  if (!needle) return false
  const rows: string[] = []
  for (let index = 0; index < screen.rows; index += 1) {
    rows.push(normalise(screen.row(index)))
  }
  return rows.join(' ').includes(needle)
}

/**
 * How much of the screen has to survive a burst for it to count as unmoved.
 *
 * Not all of it: an agent repaints a spinner, a token count and an elapsed
 * timer between frames, so an exact comparison says "moved" on a view that is
 * standing still — which is the case the stall check exists to catch.
 */
const STILL_FRACTION = 0.75

/** The rows on screen, flattened for comparison. */
export function rowsOf(screen: Screen): string[] {
  const rows: string[] = []
  for (let index = 0; index < screen.rows; index += 1) {
    rows.push(normalise(screen.row(index)))
  }
  return rows
}

/** Whether a burst moved the view, judged on how much of it stayed put. */
export function moved(before: string[], after: string[]): boolean {
  if (before.length !== after.length || before.length === 0) return true
  const same = before.filter((row, index) => row === after[index]).length
  return same < before.length * STILL_FRACTION
}

/** One run of the wheel over a view the agent owns. */
export interface Sweep {
  /** What the agent is showing right now. */
  screen: Screen
  /** Which way it is going. Carried so a caller can undo what it sent. */
  up: boolean
  /** Turns the wheel one notch. */
  notch(up: boolean): void
  /** Waits for the agent's repaint to arrive. */
  settle(): Promise<void>
  /** Whether this sweep still owns the view, re-read after every await. */
  owns(): boolean
  /** Whether it has arrived. A sweep to the end never has. */
  done(): boolean
}

/**
 * Sends bursts one way until the sweep has arrived or the view stops moving.
 *
 * Answers how many notches actually moved it, because only those are worth
 * undoing: a burst the agent absorbed — at the end of what it kept, or while
 * it was printing — scrolled nothing, so counting it into the way back drives
 * the view past where it started and pins it to the bottom.
 */
export async function sweep(run: Sweep): Promise<number> {
  let travelled = 0
  let stalls = 0
  // Read before the first burst, not left empty: `moved` calls two empty
  // screens moved so a sweep always gets its first burst, and seeding this
  // with one would bill that burst to the way back even when it scrolled
  // nothing.
  let before = rowsOf(run.screen)
  for (let look = 0; look < MAX_LOOKS; look += 1) {
    if (run.done()) return travelled
    for (let i = 0; i < NOTCHES_PER_LOOK; i += 1) run.notch(run.up)
    // The agent answers a burst by repainting over the pty, so the screen
    // read next is only current once that has arrived.
    await run.settle()
    // Re-checked, not just tested once: a TUI can drop tracking mid-sweep,
    // and every later notch would then be typed rather than reported.
    if (!run.owns()) return travelled
    const after = rowsOf(run.screen)
    const shifted = moved(before, after)
    if (shifted) travelled += NOTCHES_PER_LOOK
    stalls = shifted ? 0 : stalls + 1
    before = after
    if (stalls >= MAX_STALLS) break
  }
  return travelled
}
