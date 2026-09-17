import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'

/**
 * The buffer row at the top of the screen, as xterm scrolls and writes.
 *
 * An effect because it synchronises with xterm's own scroll position, which
 * nothing in the component tree owns. Coalesced into a frame: pinned to the
 * bottom every write batch moves the viewport, and each move re-renders the
 * pane and every mark in the rail.
 */
export function useViewportRow(term: Terminal | null, active: boolean): number {
  const [row, setRow] = useState(0)

  useEffect(() => {
    if (!term || !active) return
    let frame = 0

    const read = () => {
      frame = 0
      setRow(term.buffer.active.viewportY)
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read)
    }

    read()
    // `onScroll` covers API scrolls only: xterm's viewport passes
    // `suppressScrollEvent` for a wheel or a scrollbar drag, so it never fires
    // for the gesture a reader actually uses. `onRender` does.
    const scrolled = term.onScroll(schedule)
    const written = term.onWriteParsed(schedule)
    const rendered = term.onRender(schedule)
    return () => {
      scrolled.dispose()
      written.dispose()
      rendered.dispose()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [term, active])

  return row
}
