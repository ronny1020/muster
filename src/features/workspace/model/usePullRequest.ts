import { useEffect, useRef } from 'react'

import { pullRequest, type PullRequestState } from '../../../shared/ipc'
import { useKeyedState } from '../../../shared/lib/useKeyedState'
import { type Known, withLastKnown } from './pullrequest'

/**
 * The pull request of `branch`, checked out in `cwd`, while `enabled`.
 *
 * Callers enable it only for the tab on screen: every pane stays mounted, and
 * a hidden tab asking GitHub every minute would spend the user's rate limit
 * on a chip nobody sees. A window whose document the webview reports hidden
 * skips its reads for the same reason. It is read when the tab comes into
 * view, when the window regains focus — the moment a push or a review has
 * most likely happened elsewhere — and once a minute, the scale a check
 * finishes on.
 */
export function usePullRequest(
  cwd: string,
  branch: string,
  enabled: boolean,
): PullRequestState | null {
  const [state, setState] = useKeyedState<PullRequestState | null>(
    [cwd, branch],
    null,
  )
  // Outlives the effect, which re-runs each time the tab comes back into view.
  const known = useRef<Known & { key: string }>({
    key: '',
    state: null,
    misses: 0,
  })

  useEffect(() => {
    if (!enabled || !cwd || !branch) return
    // One read at a time per run of this effect: a focus can arrive while the
    // last read is still waiting on the network. A read from a run already
    // torn down is dropped instead, so two replies never land out of order.
    let reading = false
    let live = true
    const key = JSON.stringify([cwd, branch])
    const poll = async () => {
      if (reading || document.visibilityState === 'hidden') return
      reading = true
      const last =
        known.current.key === key ? known.current : { state: null, misses: 0 }
      const next = withLastKnown(await readPullRequest(cwd), last)
      reading = false
      if (!live) return
      known.current = { key, ...next }
      if (next.state) setState([cwd, branch], next.state)
    }
    void poll()
    const onTick = () => void poll()
    const timer = setInterval(onTick, 60_000)
    window.addEventListener('focus', onTick)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('focus', onTick)
    }
  }, [cwd, branch, enabled, setState])

  return enabled && branch ? state : null
}

const readPullRequest = async (cwd: string) => {
  try {
    return await pullRequest(cwd)
  } catch {
    /* the backend answers every failure as a state; this is the IPC itself */
    return null
  }
}
