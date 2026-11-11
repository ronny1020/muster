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
  const last = useRef<{ cwd: string; git: GitStatus; at: number } | null>(null)
  // Follows the git polls, whose answers arrive from outside React.
  useEffect(() => {
    if (!git?.repo) {
      last.current = null
      return
    }
    const was = last.current
    last.current = { cwd, git, at: Date.now() }
    if (was?.cwd !== cwd) return
    if (was.git.conflicted === 0 && git.conflicted > 0) {
      raise({ kind: 'conflict', head: git.head, count: git.conflicted })
    } else if (headMoved(was.git, git)) {
      void announceCommit({ cwd, was: was.git, now: git, since: was.at }, raise)
    }
  }, [git, cwd, raise])
}

async function announceCommit(
  {
    cwd,
    was,
    now,
    since,
  }: { cwd: string; was: GitStatus; now: GitStatus; since: number },
  raise: (event: NoticeEvent) => void,
) {
  const log = await gitLog(cwd, LOG_DEPTH).catch(() => [])
  const commit = landedCommit({ was, now, log, since: since / 1000 })
  if (commit) {
    raise({
      kind: 'committed',
      head: now.head,
      branch: now.branch,
      subject: commit.subject,
    })
  }
}
