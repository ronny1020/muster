import { useCallback, useEffect, useRef, useState } from 'react'

import { ptyCwd, type Workspace, workspaceInfo } from '../../../shared/ipc'

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
  /** Re-reads at once, for when the app itself has just changed the tree. */
  refresh(): void
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
  const [snapshot, setSnapshot] = useState<Omit<WorkspaceSnapshot, 'refresh'>>({
    cwd: launchCwd ?? '',
    workspace: null,
    tracked: false,
  })
  // Two reads can overlap — a poll and a manual refresh, or a poll straddling
  // a tab switch. Only the newest may write, or a slow earlier read lands last
  // and the footer shows the directory the session has already left.
  const latest = useRef(0)

  const read = useCallback(async () => {
    if (!sessionId || !launchCwd) return
    const mine = (latest.current += 1)
    try {
      const live = await ptyCwd(sessionId).catch(() => null)
      const cwd = live ?? launchCwd
      const workspace = await workspaceInfo(cwd)
      if (latest.current === mine) {
        setSnapshot({ cwd, workspace, tracked: live !== null })
      }
    } catch {
      /* directory vanished mid-poll; keep the last known state */
    }
  }, [sessionId, launchCwd])

  useEffect(() => {
    if (!sessionId || !launchCwd) return
    void read()
    const poll = () => void read()
    const timer = setInterval(poll, pollSeconds * 1000)
    window.addEventListener('focus', poll)
    return () => {
      // Invalidates any read still in flight, so it cannot write after this
      // tab's pane has moved on.
      latest.current += 1
      clearInterval(timer)
      window.removeEventListener('focus', poll)
    }
  }, [read, sessionId, launchCwd, pollSeconds])

  return { ...snapshot, refresh: read }
}
