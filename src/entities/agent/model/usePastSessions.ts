import { useEffect, useState } from 'react'

import { agentSessions } from '../../../shared/ipc'
import type { Backend } from '../../../shared/lib/platform'

/**
 * How many conversations an agent already has in a directory, re-read when the
 * session goes quiet.
 *
 * `null` means the answer is unknown — the agent's store is not one the
 * backend reads, or the read has not landed yet — and every caller treats that
 * as "offer it anyway", because hiding a control on a guess is worse than
 * offering one that turns out to do nothing.
 *
 * Re-read rather than asked once, and on `status` rather than a timer: a brand
 * new session has no transcript until its first turn is written, so a count
 * taken at spawn would say zero for a conversation that exists moments later.
 * Every pane stays mounted, so a poll would cost one directory read per tab
 * forever — the quiet edge the deck already tracks is both the trigger and the
 * whole schedule.
 */
export function usePastSessions(
  agentId: string,
  cwd: string,
  backend: Backend,
  status: string,
): number | null {
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    if (!agentId || !cwd) {
      setCount(null)
      return
    }
    let live = true
    const read = async () => {
      try {
        const found = await agentSessions(agentId, cwd, backend)
        if (live) setCount(found)
      } catch {
        // An unreadable store is "unknown", not zero: see the doc comment.
        if (live) setCount(null)
      }
    }
    void read()
    return () => {
      live = false
    }
  }, [agentId, cwd, backend, status])

  return count
}

/**
 * Whether a control that reopens a conversation should be offered at all.
 *
 * Unknown offers. `null` is "not read yet, or a store the backend cannot
 * count", and hiding a working control on that is worse than offering one
 * that turns out to have nothing to do — only a measured zero hides it, and a
 * measured zero is the case where pressing it would end the session.
 */
export const canReopen = (past: number | null) => past !== 0
