import { useEffect } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'

import type { Mark } from '../model/messages'

/** The accent, so a message mark reads as "you" rather than as a warning. */
export const MESSAGE_MARK = { color: '#d97757', position: 'full' } as const

/**
 * A theme blue in the bar's left third.
 *
 * The lane is what makes the two kinds tell apart by **shape** as well as by
 * colour, which the accessibility bar asks for. It is not what protects the
 * message marks: `_refreshDecorations` draws every non-`full` zone and then
 * every `full` one over the top with an opaque fill, so a message mark wins a
 * shared row whatever lane the file mark takes.
 */
export const FILE_MARK = { color: '#6f9ede', position: 'left' } as const

/**
 * How many decorations one rescan may register.
 *
 * Each is a marker the terminal holds and the ruler walks every frame. Marks
 * are newest first, so spending the budget in order gives the recent work its
 * full bar and leaves the oldest blocks as a single row — which is what a
 * reader is looking at anyway.
 */
const MAX_DECORATIONS = 300

/**
 * Rows between decorations inside one span.
 *
 * The ruler has no notion of a tall mark: `ColorZoneStore.addDecoration` reads
 * `marker.line` and ignores a decoration's `height`, and a zone grows only by
 * merging another decoration of the same colour and position that falls within
 * its padding. So a span is drawn by sampling it exactly that often, and the
 * padding is worth reproducing rather than under-estimating — a stride finer
 * than it needs multiplies the decorations a long block costs by ten, and the
 * budget below then spends the lot on the newest block and leaves the rest of
 * the session unmarked.
 *
 * `OverviewRulerRenderer`'s own arithmetic: a non-`full` mark is
 * `clamp(canvasHeight / bufferLines, 6, 12) * dpr` device pixels tall, a
 * `full` one is `2 * dpr`, and the padding is
 * `floor(bufferLines / (canvasHeight - 1) * markHeight)`.
 */
function strideFor(term: Terminal, canvasHeight: number, full: boolean) {
  const lines = Math.max(1, term.buffer.active.length)
  const height = Math.max(2, canvasHeight)
  const dpr = window.devicePixelRatio || 1
  const mark = full ? 2 * dpr : Math.min(Math.max(height / lines, 6), 12) * dpr
  return Math.max(1, Math.floor((lines / (height - 1)) * mark))
}

/** The ruler canvas of this terminal, or `null` before it has one. */
const rulerOf = (term: Terminal) =>
  term.element?.querySelector<HTMLCanvasElement>(
    '.xterm-decoration-overview-ruler',
  ) ?? null

/**
 * Marks rows in xterm's overview ruler, which overlays the scrollbar and is
 * drawn against the same scroll extent — so a mark sits at the row's true
 * position. See AGENTS.md's message-marks invariant for why this exists beside
 * the rail rather than instead of it.
 *
 * A mark carrying an `endRow` is drawn as the whole span, so a file's bar is
 * as tall as the output it owns.
 */
export function useRulerMarks(
  term: Terminal | null,
  marks: Mark[],
  style: typeof MESSAGE_MARK | typeof FILE_MARK,
) {
  useEffect(() => {
    if (!term) return
    const drawn: IDisposable[] = []
    const stride = strideFor(
      term,
      rulerOf(term)?.height ?? term.rows,
      style.position === 'full',
    )
    // A fair share each, so one long block cannot spend the budget and leave
    // the older marks off the bar entirely.
    const share = Math.max(2, Math.floor(MAX_DECORATIONS / (marks.length || 1)))
    // `registerMarker` counts from the cursor, so an absolute row has to be
    // expressed as a distance from it. Read here rather than per mark: the
    // offset and the cursor it is relative to have to come from one moment.
    const cursor = term.buffer.active.baseY + term.buffer.active.cursorY
    let budget = MAX_DECORATIONS

    const draw = (row: number) => {
      const marker = term.registerMarker(row - cursor)
      if (!marker) return
      const decoration = term.registerDecoration({
        marker,
        overviewRulerOptions: { color: style.color, position: style.position },
      })
      drawn.push(marker, ...(decoration ? [decoration] : []))
      budget--
    }

    for (const { row, endRow } of marks) {
      if (budget <= 0) break
      const last = Math.max(row, endRow ?? row)
      let spent = 0
      for (
        let at = row;
        at < last && budget > 0 && spent < share - 1;
        at += stride
      ) {
        draw(at)
        spent++
      }
      // The span's last row explicitly, so its bar reaches the end rather than
      // stopping at whatever the stride happened to land on.
      if (budget > 0) draw(last)
    }
    return () => {
      for (const mark of drawn) mark.dispose()
    }
  }, [term, marks, style])
}
