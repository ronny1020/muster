import { useEffect, useRef } from 'react'

import { gitLog, type GitStatus } from '../../../shared/ipc'
import { headMoved, landedCommit, type NoticeEvent } from './notices'

/** Deep enough to reach the old `HEAD` past a merge's other side. */
const LOG_DEPTH = 20

/**
 * Raises a commit or a conflict a tab's git polls show, by comparing each
 * poll with the one before, kept in a ref: that is the only record of what
 * the tree was. A move to another directory, or out of a repository, starts
 * the record again rather than comparing two trees.
 */
export function useGitNotices(
  { cwd, git }: { cwd: string; git: GitStatus | undefined },
  raise: (event: NoticeEvent) => void,
) {
  const last = useRef<Poll | null>(null)
  // Follows the git polls, whose answers arrive from outside React.
  useEffect(() => {
    if (!git?.repo) {
      last.current = null
      return
    }
    const was = last.current
    const poll = { cwd, git, at: Date.now() }
    last.current = poll
    if (was?.cwd !== cwd) return
    // Git could fail to name the root while still reporting a status.
    const tree = git.root || cwd
    if (was.git.conflicted === 0 && git.conflicted > 0) {
      raise({ kind: 'conflict', tree, head: git.head, count: git.conflicted })
    } else if (headMoved(was.git, git)) {
      void announceCommit({
        was,
        now: poll,
        tree,
        isCurrent: () => last.current?.cwd === cwd,
        raise,
      })
    }
  }, [git, cwd, raise])
}

interface Poll {
  cwd: string
  git: GitStatus
  /** When it was read, in milliseconds since the epoch. */
  at: number
}

/**
 * Raises the commit `HEAD` moved to, if it looks made here (`landedCommit`).
 * The log arrives later, so a tab that has since moved to another directory
 * raises nothing: its card would name a commit the tab no longer shows.
 */
async function announceCommit({
  was,
  now,
  tree,
  isCurrent,
  raise,
}: {
  was: Poll
  now: Poll
  tree: string
  isCurrent: () => boolean
  raise: (event: NoticeEvent) => void
}) {
  const log = await gitLog(now.cwd, LOG_DEPTH).catch(() => [])
  const commit = landedCommit({
    was: was.git,
    now: now.git,
    log,
    since: was.at / 1000,
  })
  if (commit && isCurrent()) {
    raise({
      kind: 'committed',
      tree,
      head: now.git.head,
      branch: now.git.branch,
      subject: commit.subject,
    })
  }
}
