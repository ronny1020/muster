import { useCallback, useEffect, useRef, useState } from 'react'

import { type Changes, gitChanges } from '../../../shared/ipc'

export interface ChangesSnapshot {
  changes: Changes | null
  /** True until the first read for the current directory has landed. */
  loading: boolean
  reload(): void
}

/**
 * The changed-file set of a directory.
 *
 * Deliberately has no timer of its own. Panes stay mounted for every tab, so a
 * poll here would be one per tab forever — instead `revision` is supplied by
 * the caller, which already polls git for the status bar. Re-reading when that
 * string moves means the list follows an agent's edits without a second clock.
 */
export function useChanges(
  cwd: string,
  base: string,
  revision: string,
): ChangesSnapshot {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [loading, setLoading] = useState(false)
  // Reads can overlap — a base switch over a poll — and only the newest may
  // write, or the list shows what the previous base held.
  const latest = useRef(0)

  const read = useCallback(async () => {
    if (!cwd) return
    const mine = (latest.current += 1)
    setLoading(true)
    const next = await gitChanges(cwd, base || undefined).catch(() => null)
    if (latest.current !== mine) return
    setChanges(next)
    setLoading(false)
  }, [cwd, base])

  useEffect(() => {
    void read()
    return () => {
      // Invalidates a read still in flight, so it cannot land on a directory
      // this pane has already left.
      latest.current += 1
    }
  }, [read, revision])

  // A directory or base change makes the previous list wrong rather than
  // stale, so it goes at once instead of lingering under a spinner.
  useEffect(() => setChanges(null), [cwd, base])

  return { changes, loading, reload: read }
}
