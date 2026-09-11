import { useEffect, useState } from 'react'

import { type DirEntry, listDirectory } from '../../../shared/ipc'

export interface DirectorySnapshot {
  entries: DirEntry[] | null
  error: string | null
}

/**
 * One directory's entries, read when it is first expanded.
 *
 * A folder in the tree owns its own read rather than a store owning all of
 * them: collapsing one drops its children, which is what keeps a tree opened
 * deep into `node_modules` from being a permanent cost. `revision` is the
 * caller's "the tree moved" string, so an expanded folder re-reads with it.
 */
export function useDirectory(
  path: string,
  revision: string,
): DirectorySnapshot {
  const [snapshot, setSnapshot] = useState<DirectorySnapshot>({
    entries: null,
    error: null,
  })

  useEffect(() => {
    let live = true
    void listDirectory(path).then(
      (entries) => live && setSnapshot({ entries, error: null }),
      (error: unknown) =>
        live && setSnapshot({ entries: null, error: String(error) }),
    )
    return () => {
      live = false
    }
    // `revision` is what makes a folder follow the tree: read once per
    // expansion, the tree and the changed-file list disagreed indefinitely
    // about a file the agent had just written.
  }, [path, revision])

  return snapshot
}
