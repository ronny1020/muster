import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { type Changes, gitChanges } from '../../../shared/ipc'
import { useKeyChange } from '../../../shared/lib/useKeyChange'

export interface ChangesSnapshot {
  changes: Changes | null
  /** True while a read is in flight, after a change of input or a reload. */
  loading: boolean
  reload: () => void
}

/**
 * The changed-file set of a directory.
 *
 * `counts` says whether the line counts are wanted. They cost a read of every
 * new file, which is what raises a filesystem permission prompt — so the view
 * that shows no numbers asks for none.
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
  counts: boolean,
): ChangesSnapshot {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [loading, setLoading] = useState(Boolean(cwd))
  // Reads can overlap — a base switch over a poll — and only the newest may
  // write, or the list shows what the previous base held.
  const latest = useRef(0)
  // Moved in the commit that changes the inputs, so a read still in flight
  // cannot land before the read effect's cleanup runs.
  useLayoutEffect(() => {
    latest.current += 1
  }, [cwd, base, counts, revision])

  const read = useCallback(async () => {
    if (!cwd) return
    const mine = (latest.current += 1)
    const next = await gitChanges(cwd, base || undefined, counts).catch(
      () => null,
    )
    if (latest.current !== mine) return
    setChanges(next)
    setLoading(false)
  }, [cwd, base, counts])

  useEffect(() => {
    void read()
    return () => {
      // Invalidates a read still in flight, so it cannot land on a directory
      // this pane has already left.
      latest.current += 1
    }
  }, [read, revision])

  // Every input that restarts the read effect starts a read, so the spinner
  // is set in the same render rather than by the read itself.
  useKeyChange([cwd, base, counts, revision], () => setLoading(Boolean(cwd)))
  // A directory or base change makes the previous list wrong rather than
  // stale, so it goes at once instead of lingering under a spinner.
  useKeyChange([cwd, base], () => setChanges(null))

  const reload = useCallback(() => {
    setLoading(Boolean(cwd))
    void read()
  }, [cwd, read])

  return { changes, loading, reload }
}
