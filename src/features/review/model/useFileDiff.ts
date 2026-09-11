import { useEffect, useRef, useState } from 'react'

import { type FileDiff, gitFileDiff } from '../../../shared/ipc'

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
    loading: false,
  })
  const latest = useRef(0)

  // A different file is not a re-read: its rows must go at once.
  useEffect(
    () => setState({ diff: null, error: null, loading: Boolean(path) }),
    [cwd, path, base],
  )

  useEffect(() => {
    if (!cwd || !path) {
      setState({ diff: null, error: null, loading: false })
      return
    }
    const mine = (latest.current += 1)
    // The previous diff stays on screen while the new one is read: clearing it
    // unmounted the rows, which lost the scroll position — and the tree moves
    // on every git poll, so that happened while you were reading.
    setState((before) => ({ ...before, loading: true }))
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
