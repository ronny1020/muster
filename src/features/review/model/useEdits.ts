import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { gitChanges, gitFileDiff } from '../../../shared/ipc'
import { useKeyChange } from '../../../shared/lib/useKeyChange'
import { type Edit, withEdits } from './edits'
import { type EditGit, type Memory, readEdits } from './editpass'

export interface EditsOptions {
  /** The session's live directory. */
  cwd: string
  /** Whether any surface that draws edits is on; off, nothing is read. */
  enabled: boolean
  /** The tab is producing output, which is when edits land. */
  working: boolean
  pollSeconds: number
  /** The workspace poll's tree revision, which moves on a file appearing. */
  revision: string
}

export interface EditFeed {
  /** Newest first. */
  edits: Edit[]
  /** Read now: the agent has just said it wrote a file. */
  nudge: () => void
}

/**
 * The edits landing in the tab's working tree, read as they happen. They are
 * the tree's, not the agent's: an edit from an editor or another tab in the
 * same tree shows too, because git cannot say who wrote a line.
 *
 * Each pass compares the changed-file list with the previous pass's, and
 * re-reads the patches of the files edited most recently, since an edit that
 * rewrites a line in place moves no count. The first pass waits for the tab
 * to work, and a timer runs only while it does, at the git poll's own
 * interval: every pane stays mounted, and an idle tab has nothing landing in
 * it. Going idle reads once more, so the last edit of a turn is never left
 * for the next one.
 */
export function useEdits({
  cwd,
  enabled,
  working,
  pollSeconds,
  revision,
}: EditsOptions): EditFeed {
  const [edits, setEdits] = useState<Edit[]>([])
  const memory = useRef<Memory>({
    seen: { current: null },
    patches: new Map(),
    nextId: { current: 1 },
  })
  const busy = useRef(false)
  const again = useRef(false)
  // Read by a pass at each turn of its loop, so a request queued behind it
  // reads the tree the session is in now rather than the one it started in.
  const live = useRef({ cwd, enabled })
  useLayoutEffect(() => {
    live.current = { cwd, enabled }
  }, [cwd, enabled])

  // Switched off, the feed is history nobody was keeping; a `cd` keeps it
  // unless the pass finds another repository, which clears it below.
  useKeyChange([enabled], () => setEdits([]))

  const read = useCallback(async () => {
    // One pass at a time, and a request made during one runs after it: two
    // overlapping passes would both report the same edit.
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    try {
      do {
        again.current = false
        const { cwd: dir, enabled: on } = live.current
        if (!on || !dir) break
        const pass = await readEdits({
          cwd: dir,
          memory: memory.current,
          git: GIT,
        })
        const now = live.current
        if (!now.enabled) {
          memory.current.seen.current = null
        } else if (pass.fresh) {
          // Another tree's edits are not this one's history.
          setEdits([])
        } else if (pass.edits.length > 0) {
          setEdits((feed) => withEdits(feed, pass.edits))
        }
      } while (again.current)
    } finally {
      busy.current = false
    }
  }, [])

  // Synchronises with git's working tree, which nothing announces.
  useEffect(() => {
    if (!enabled || !cwd) {
      // Whatever changes while nobody is reading is not an edit to report
      // when reading resumes.
      memory.current.seen.current = null
      return
    }
    // An idle tab with no baseline yet reads nothing: priming costs a diff
    // per changed file, and a launch restores every tab at once.
    if (!working && memory.current.seen.current === null) return
    void read()
    if (!working) return
    const timer = setInterval(() => void read(), pollSeconds * 1000)
    return () => clearInterval(timer)
  }, [read, enabled, cwd, working, pollSeconds, revision])

  const nudge = useCallback(() => void read(), [read])
  return { edits, nudge }
}

/** Context 0: only the changed lines are compared, and they are cheaper. */
const GIT: EditGit = {
  changes: (cwd) => gitChanges(cwd, undefined, true),
  patch: async ({ cwd, path, head, oldPath }) => {
    const diff = await gitFileDiff(cwd, path, {
      context: 0,
      rev: head,
      oldPath,
    })
    if (diff.truncated) throw new Error('patch cut short')
    return diff.patch
  },
}
