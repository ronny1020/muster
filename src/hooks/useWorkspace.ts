import { useEffect, useState } from 'react'

import { ptyCwd, type Workspace, workspaceInfo } from '../ipc'

export interface WorkspaceSnapshot {
  /** Absolute directory the session is in right now. */
  cwd: string
  workspace: Workspace | null
  /**
   * Whether `cwd` came from the live session or is still the directory it
   * launched in. Reading it back needs a foreground process group, which
   * Windows has no equivalent of.
   */
  tracked: boolean
}

/**
 * Follows a session's working directory and the git state of that tree.
 *
 * The directory is read back from the session's foreground process on every
 * poll, so a `cd` typed in the terminal moves the status bar with it. Where the
 * host cannot report one it stays on the launch directory, and `tracked` says
 * so. Polling also happens whenever the window regains focus — the moment a
 * commit or checkout has most likely just happened elsewhere.
 */
export function useWorkspace(
  sessionId: string | null,
  launchCwd: string | null,
  pollSeconds: number,
): WorkspaceSnapshot {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({
    cwd: launchCwd ?? '',
    workspace: null,
    tracked: false,
  })

  useEffect(() => {
    if (!sessionId || !launchCwd) return
    let cancelled = false

    const read = async () => {
      try {
        const live = await ptyCwd(sessionId).catch(() => null)
        const cwd = live ?? launchCwd
        const workspace = await workspaceInfo(cwd)
        if (!cancelled) setSnapshot({ cwd, workspace, tracked: live !== null })
      } catch {
        /* directory vanished mid-poll; keep the last known state */
      }
    }

    void read()
    const timer = setInterval(read, pollSeconds * 1000)
    window.addEventListener('focus', read)
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', read)
    }
  }, [sessionId, launchCwd, pollSeconds])

  return snapshot
}
