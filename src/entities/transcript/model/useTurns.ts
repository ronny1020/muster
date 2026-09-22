import { useEffect, useState } from 'react'

import { agentTurns, type Turn } from '../../../shared/ipc'

/**
 * The turns of a tab's conversation, re-read when the agent stops working.
 *
 * No timer: a turn is finished exactly when the session goes quiet, which the
 * deck already tracks, so `status` is both the trigger and the whole schedule.
 * That matters more here than elsewhere — every pane stays mounted, so a poll
 * would read one file per tab forever.
 */
export function useTurns(cwd: string, id: string, status: string): Turn[] {
  const [turns, setTurns] = useState<Turn[]>([])

  useEffect(() => {
    if (!cwd) {
      setTurns([])
      return
    }
    let live = true
    const read = async () => {
      try {
        const found = await agentTurns(cwd, id)
        if (live) setTurns(found)
      } catch {
        // A transcript is another program's file: unreadable is a fallback to
        // the terminal, not an error to show.
      }
    }
    void read()
    return () => {
      live = false
    }
  }, [cwd, id, status])

  return turns
}
