import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react'

import { type Collision, collisionsByTab } from './collisions'
import { gitChanges } from '../../../shared/ipc'

/** One tab, as the detector needs to see it. */
export interface FleetTab {
  id: string
  title: string
  cwd: string
}

const CollisionContext = createContext<Map<string, Collision[]>>(new Map())

/**
 * Collisions are compared less often than a tab re-reads its own status.
 *
 * A count in the status bar wants to be current; "another tab is editing this
 * too" changes on the scale of an agent finishing an edit. Multiplying the
 * user's interval keeps that setting meaningful without tripling the git
 * subprocesses an open window runs.
 */
const POLL_MULTIPLE = 3

export interface CollisionProviderProps {
  /** Every tab with a live session. Tabs without one cannot collide. */
  tabs: FleetTab[]
  pollSeconds: number
  children: ReactNode
}

/**
 * Watches every tab's working tree at once, which is the one thing no tab can
 * do for itself.
 *
 * Mounted once, above the panes: a hook called inside `Pane` would run in
 * every mounted tab — they all stay mounted — and each copy would then poll
 * every other tab's directory.
 */
export function CollisionProvider({
  tabs,
  pollSeconds,
  children,
}: CollisionProviderProps) {
  const [index, setIndex] = useState<Map<string, Collision[]>>(new Map())
  // Serialised rather than passed as an array: a fresh array every render
  // would restart the interval whenever anything else in the app changes.
  const watching = JSON.stringify(tabs)

  useEffect(() => {
    const watched = JSON.parse(watching) as FleetTab[]
    // One tab cannot collide with itself, and asking git anyway would cost a
    // subprocess every few seconds for an answer that is always empty.
    if (watched.length < 2) {
      setIndex(new Map())
      return
    }

    let cancelled = false
    // Polls overlap: each one runs a git call per tab, and on a large repo or
    // a network mount that outlasts the interval. Without a sequence number an
    // older answer can resolve last and overwrite a newer one, so the chip
    // names a file that is no longer shared. `useWorkspace` guards the same
    // way for the same reason.
    let issued = 0
    let landed = 0
    const poll = async () => {
      const mine = ++issued
      const read = await Promise.all(
        watched.map(async ({ id, title, cwd }) => {
          // No counts: this asks only which files differ, and a count is what
          // costs a file read — see `git_changes`.
          const changes = await gitChanges(cwd, undefined, false).catch(
            () => null,
          )
          return {
            tabId: id,
            title,
            commonDir: changes?.repo ? changes.commonDir : '',
            root: changes?.root ?? '',
            paths: changes?.files.map((file) => file.path) ?? [],
          }
        }),
      )
      if (cancelled || mine < landed) return
      landed = mine
      setIndex(collisionsByTab(read))
    }

    void poll()
    const timer = setInterval(
      () => void poll(),
      pollSeconds * POLL_MULTIPLE * 1000,
    )
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [watching, pollSeconds])

  return (
    <CollisionContext.Provider value={index}>
      {children}
    </CollisionContext.Provider>
  )
}

/** What this tab is changing that another tab is changing too. */
export function useCollisions(tabId: string): Collision[] {
  return useContext(CollisionContext).get(tabId) ?? []
}
