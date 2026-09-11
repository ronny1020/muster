import { useEffect, useState } from 'react'

import { readTextFile, type TextFile } from '../../../shared/ipc'

export interface TextFileState {
  file: TextFile | null
  error: string | null
}

/**
 * A file read as text.
 *
 * Shared by the two views that read one — the plain preview and the markdown
 * render — so switching between them repeats one read rather than two
 * implementations of it. It re-reads when `revision` moves, which is how the
 * column follows an agent still editing the file you are looking at.
 */
export function useTextFile(path: string, revision: string): TextFileState {
  const [state, setState] = useState<TextFileState>({
    file: null,
    error: null,
  })

  useEffect(() => {
    let live = true
    setState({ file: null, error: null })
    void readTextFile(path).then(
      (file) => live && setState({ file, error: null }),
      (error: unknown) =>
        live && setState({ file: null, error: String(error) }),
    )
    return () => {
      live = false
    }
    // `revision` is the caller's "the tree moved": without it a file rewritten
    // by the agent sat on screen unchanged, beside a drawer that had updated.
  }, [path, revision])

  return state
}
