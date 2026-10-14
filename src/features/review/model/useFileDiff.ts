import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { type FileDiff, gitFileDiff } from '../../../shared/ipc'
import { useKeyChange } from '../../../shared/lib/useKeyChange'

export interface DiffSnapshot {
  diff: FileDiff | null
  error: string | null
  loading: boolean
}

/** One file's diff, re-read whenever the file, base, context or tree moves. */
export function useFileDiff(
  cwd: string,
  path: string | null,
  base: string,
  context: number,
  revision: string,
): DiffSnapshot {
  const [state, setState] = useState<DiffSnapshot>({
    diff: null,
    error: null,
    loading: Boolean(cwd && path),
  })
  const latest = useRef(0)
  // Moved in the commit that changes the inputs, so a read still in flight
  // cannot land before the read effect's cleanup runs.
  useLayoutEffect(() => {
    latest.current += 1
  }, [cwd, path, base, context, revision])

  const reading = Boolean(cwd && path)
  // A different file is not a re-read: its rows must go at once.
  useKeyChange([cwd, path, base], () =>
    setState({ diff: null, error: null, loading: reading }),
  )
  // A re-read of the same file keeps the previous diff on screen, so the rows
  // keep their scroll position while the tree moves under an agent.
  useKeyChange([context, revision], () =>
    setState((before) => ({ ...before, loading: reading })),
  )

  useEffect(() => {
    if (!cwd || !path) return
    const mine = (latest.current += 1)
    void gitFileDiff(cwd, path, base || undefined, context).then(
      (diff) => {
        if (latest.current === mine)
          setState({ diff, error: null, loading: false })
      },
      (error: unknown) => {
        if (latest.current === mine)
          setState({ diff: null, error: String(error), loading: false })
      },
    )
    return () => {
      latest.current += 1
    }
  }, [cwd, path, base, context, revision])

  return state
}
