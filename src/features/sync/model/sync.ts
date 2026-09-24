/**
 * What the commit, pull and push controls say and whether each can be
 * pressed, read off the same git status the status bar shows.
 */
import type { GitStatus } from '../../../shared/ipc'

export interface SyncControl {
  label: string
  /** Why it cannot be pressed, or `null` when it can. */
  blocked: string | null
}

/** Names what will be committed, because staged work narrows it. */
export function commitControl(git: GitStatus): SyncControl {
  const pending = git.staged + git.modified + git.untracked + git.conflicted
  return {
    label: git.staged > 0 ? `Commit ${git.staged} staged` : 'Commit all',
    blocked: pending === 0 ? 'Nothing to commit' : null,
  }
}

/**
 * Said beside the commit button on a detached head, where a commit belongs to
 * no branch and a later checkout leaves it behind without a word. A warning
 * rather than a block, because a rebase stopped for an edit is detached too
 * and committing there is the point.
 */
export const commitWarning = (git: GitStatus) =>
  git.detached
    ? 'Not on a branch: a commit here belongs to no branch until you make one.'
    : null

export function pullControl(git: GitStatus): SyncControl {
  return {
    label: git.behind > 0 ? `Pull ↓${git.behind}` : 'Pull',
    blocked: git.detached
      ? 'No branch is checked out'
      : git.upstream
        ? null
        : 'This branch has no upstream to pull from',
  }
}

/**
 * The backend decides whether a push publishes — `read_push_state` in
 * `workspace.rs` — and acts on that same field, so the label and the push
 * agree as of the last poll.
 */
export function pushControl(git: GitStatus): SyncControl {
  return {
    label: git.publishes
      ? 'Publish'
      : git.ahead > 0
        ? `Push ↑${git.ahead}`
        : 'Push',
    blocked: git.detached ? 'No branch is checked out' : null,
  }
}
