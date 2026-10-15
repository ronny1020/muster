import type { TFunction } from 'i18next'

import type { GitStatus } from '../../../shared/ipc'

export interface GitChip {
  key: string
  text: string
  title: string
  tone: 'neutral' | 'staged' | 'modified' | 'untracked' | 'conflict' | 'clean'
  /**
   * Which surface a click on the chip should show — the files it counts, or
   * the commits. `null` means there is nothing to show, so the chip is drawn
   * as plain text rather than as a control; only `clean` is ever that.
   */
  opens: 'review' | 'history' | null
}

/** Compact chips summarising divergence and worktree state, Chrome-status style. */
export function gitChips(git: GitStatus, t: TFunction<'workspace'>): GitChip[] {
  const chips: GitChip[] = []
  const push = (
    key: string,
    text: string,
    title: string,
    tone: GitChip['tone'],
    opens: GitChip['opens'] = 'review',
  ) => chips.push({ key, text, title, tone, opens })

  // Commits live in the history drawer; files live in the review drawer. A
  // count nobody can act on is a count worth making clickable.
  if (git.ahead)
    push(
      'ahead',
      `↑${git.ahead}`,
      t('chips.toPush', { count: git.ahead }),
      'neutral',
      'history',
    )
  if (git.behind)
    push(
      'behind',
      `↓${git.behind}`,
      t('chips.toPull', { count: git.behind }),
      'neutral',
      'history',
    )
  if (git.staged)
    push(
      'staged',
      `+${git.staged}`,
      t('chips.staged', { count: git.staged }),
      'staged',
    )
  if (git.modified)
    push(
      'modified',
      `~${git.modified}`,
      t('chips.modified', { count: git.modified }),
      'modified',
    )
  if (git.untracked)
    push(
      'untracked',
      `?${git.untracked}`,
      t('chips.untracked', { count: git.untracked }),
      'untracked',
    )
  if (git.conflicted)
    push(
      'conflict',
      `!${git.conflicted}`,
      t('chips.conflicted', { count: git.conflicted }),
      'conflict',
    )
  if (!git.staged && !git.modified && !git.untracked && !git.conflicted) {
    // Nothing to review, so the chip is a label rather than a way in.
    push('clean', t('chips.clean'), t('chips.cleanTitle'), 'clean', null)
  }
  return chips
}

export interface ChipGroups {
  /** Commits: they belong to the history drawer. */
  history: GitChip[]
  /** Files: they belong to the review drawer's Changes view. */
  review: GitChip[]
  /** The one chip that leads nowhere, because there is nothing to look at. */
  clean: GitChip | null
}

/**
 * The chips, grouped by what a click on them should show.
 *
 * Grouped rather than listed because each group is a single control: four
 * adjacent counts that all open the same view are four targets for one
 * intention, and the space between them is a place to miss.
 */
export function chipGroups(
  git: GitStatus,
  t: TFunction<'workspace'>,
): ChipGroups {
  const chips = gitChips(git, t)
  return {
    history: chips.filter((chip) => chip.opens === 'history'),
    review: chips.filter((chip) => chip.opens === 'review'),
    clean: chips.find((chip) => chip.opens === null) ?? null,
  }
}

export const branchLabel = (git: GitStatus, t: TFunction<'workspace'>) =>
  git.detached ? t('chips.detached', { at: git.branch }) : git.branch

/**
 * A string that changes when the working tree does, for the surfaces that
 * re-read on it — the changed-file list, an open diff, the file tree.
 *
 * Derived from git's own counts rather than from a clock: a timestamp bumped
 * on every poll tore an open diff down every few seconds, in every tab at
 * once, and re-tokenised it on the thread that draws the window. The trade is
 * that a second edit to an already-modified file does not move any count, so
 * the panel's Re-read button is what catches that.
 */
export function treeRevision(cwd: string, git: GitStatus | null): string {
  if (!git?.repo) return cwd
  return [
    cwd,
    git.branch,
    git.ahead,
    git.behind,
    git.staged,
    git.modified,
    git.untracked,
    git.conflicted,
  ].join(':')
}
