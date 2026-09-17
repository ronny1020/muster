import { useEffect, useState } from 'react'
import type { Terminal } from '@xterm/xterm'

import { findMessageRows, type Message } from '../model/messages'

/** Whether two scans found the same messages in the same places. */
const same = (a: Message[], b: Message[]) =>
  a.length === b.length &&
  a.every(
    (message, i) => message.row === b[i]?.row && message.label === b[i]?.label,
  )

/**
 * The rows your own messages start on, newest first, kept current as the
 * session writes. See AGENTS.md's message-marks invariant.
 *
 * Gated on `active` because every pane stays mounted, and identity is kept
 * when nothing moved because consumers key effects on this array.
 */
export function useMessages(term: Terminal | null, active: boolean): Message[] {
  const [messages, setMessages] = useState<Message[]>([])

  useEffect(() => {
    if (!term || !active) {
      setMessages([])
      return
    }
    let frame = 0

    const read = () => {
      frame = 0
      const found = findMessageRows(term.buffer.active)
      setMessages((previous) => (same(previous, found) ? previous : found))
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read)
    }

    // The first read is synchronous: an occluded window gets no animation
    // frames, so a rail that waited for one would stay empty until it came
    // forward.
    read()
    const written = term.onWriteParsed(schedule)
    return () => {
      written.dispose()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [term, active])

  return messages
}
