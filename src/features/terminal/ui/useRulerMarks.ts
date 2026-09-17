import { useEffect } from 'react'
import type { IDisposable, Terminal } from '@xterm/xterm'

import type { Message } from '../model/messages'

/** The accent, so a mark reads as "you" rather than as a warning. */
const MARK_COLOR = '#d97757'

/**
 * Marks each message in xterm's overview ruler, which overlays the scrollbar
 * at each message's true position. See AGENTS.md's message-marks invariant for
 * why this exists beside the rail rather than instead of it.
 */
export function useRulerMarks(term: Terminal | null, messages: Message[]) {
  useEffect(() => {
    if (!term) return
    const marks: IDisposable[] = []
    // `registerMarker` counts from the cursor, so an absolute row has to be
    // expressed as a distance from it.
    const cursor = term.buffer.active.baseY + term.buffer.active.cursorY
    for (const { row } of messages) {
      const marker = term.registerMarker(row - cursor)
      if (!marker) continue
      const decoration = term.registerDecoration({
        marker,
        overviewRulerOptions: { color: MARK_COLOR, position: 'full' },
      })
      marks.push(marker, ...(decoration ? [decoration] : []))
    }
    return () => {
      for (const mark of marks) mark.dispose()
    }
  }, [term, messages])
}
