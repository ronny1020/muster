/**
 * What the commit, pull and push controls say and whether each can be
 * pressed, read off the same git status the status bar shows.
 */
import type { TFunction } from 'i18next'

import type { GitStatus } from '../../../shared/ipc'

export interface SyncControl {
  label: string
  /** Why it cannot be pressed, or `null` when it can. */
  blocked: string | null
}

/** Names what will be committed, because staged work narrows it. */
export function commitControl(
  git: GitStatus,
  t: TFunction<'workspace'>,
): SyncControl {
  const pending = git.staged + git.modified + git.untracked + git.conflicted
  return {
    label:
      git.staged > 0
        ? t('sync.commitStaged', { count: git.staged })
        : t('sync.commitAll'),
    blocked: pending === 0 ? t('sync.nothingToCommit') : null,
  }
}

/**
 * Said beside the commit button on a detached head, where a commit belongs to
 * no branch and a later checkout leaves it behind without a word. A warning
 * rather than a block, because a rebase stopped for an edit is detached too
 * and committing there is the point.
 */
export const commitWarning = (git: GitStatus, t: TFunction<'workspace'>) =>
  git.detached ? t('sync.detachedWarning') : null

export function pullControl(
  git: GitStatus,
  t: TFunction<'workspace'>,
): SyncControl {
  return {
    label:
      git.behind > 0
        ? t('sync.pullBehind', { count: git.behind })
        : t('sync.pull'),
    blocked: git.detached
      ? t('sync.noBranch')
      : git.upstream
        ? null
        : t('sync.noUpstream'),
  }
}

/**
 * The backend decides whether a push publishes — `read_push_state` in
 * `workspace.rs` — and acts on that same field, so the label and the push
 * agree as of the last poll.
 */
export function pushControl(
  git: GitStatus,
  t: TFunction<'workspace'>,
): SyncControl {
  return {
    label: git.publishes
      ? t('sync.publish')
      : git.ahead > 0
        ? t('sync.pushAhead', { count: git.ahead })
        : t('sync.push'),
    blocked: git.detached ? t('sync.noBranch') : null,
  }
}
