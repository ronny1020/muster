import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'

import type { Mark, MessageBuffer } from '../model/messages'

/** Whether two scans found the same places with the same names. */
const same = (a: Mark[], b: Mark[]) =>
  a.length === b.length &&
  a.every(
    (mark, i) =>
      mark.row === b[i]?.row &&
      mark.endRow === b[i]?.endRow &&
      mark.label === b[i]?.label,
  )

/**
 * The marks a scan finds in the scrollback, kept current as the session writes.
 *
 * Gated on `active` because every pane stays mounted, and identity is kept when
 * nothing moved because consumers key effects on this array — a fresh array per
 * write batch would re-register every decoration in the overview ruler.
 */
export function useBufferMarks(
  term: Terminal | null,
  active: boolean,
  scan: (buffer: MessageBuffer) => Mark[],
): Mark[] {
  const [marks, setMarks] = useState<Mark[]>([])

  useEffect(() => {
    if (!term || !active) {
      setMarks([])
      return
    }
    let frame = 0

    const read = () => {
      frame = 0
      const found = scan(term.buffer.active)
      setMarks((previous) => (same(previous, found) ? previous : found))
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read)
    }

    // The first read is synchronous: an occluded window gets no animation
    // frames, so marks that waited for one would stay empty until it came
    // forward.
    read()
    const written = term.onWriteParsed(schedule)
    return () => {
      written.dispose()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [term, active, scan])

  return marks
}
