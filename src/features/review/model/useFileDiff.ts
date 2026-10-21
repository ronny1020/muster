import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { type FileDiff, gitFileDiff } from '../../../shared/ipc'
import { useKeyChange } from '../../../shared/lib/useKeyChange'

export interface DiffSnapshot {
  diff: FileDiff | null
  error: string | null
  loading: boolean
}

export interface FileDiffRequest {
  cwd: string
  /** Repo-relative, or `null` for nothing to read. */
  path: string | null
  /** Branch being compared against, or `''` for uncommitted work. */
  base: string
  context: number
  /** Changes whenever the tree may have moved, which re-reads the diff. */
  revision: string
  /** One commit's own change, read instead of the comparison with `base`. */
  commit?: string
  /** With `commit`: the name it renamed the file from. */
  oldPath?: string
}

/** One file's diff, re-read whenever the file, base, commit, context or tree moves. */
export function useFileDiff({
  cwd,
  path,
  base,
  context,
  revision,
  commit,
  oldPath,
}: FileDiffRequest): DiffSnapshot {
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
  }, [cwd, path, base, commit, oldPath, context, revision])

  const reading = Boolean(cwd && path)
  // A different file is not a re-read: its rows must go at once.
  useKeyChange([cwd, path, base, commit, oldPath], () =>
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
    void gitFileDiff(cwd, path, {
      base: base || undefined,
      context,
      commit,
      oldPath,
    }).then(
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
  }, [cwd, path, base, commit, oldPath, context, revision])

  return state
}
