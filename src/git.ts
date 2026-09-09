import type { GitStatus } from './ipc'

export interface GitChip {
  key: string
  text: string
  title: string
  tone: 'neutral' | 'staged' | 'modified' | 'untracked' | 'conflict' | 'clean'
}

/** Compact chips summarising divergence and worktree state, Chrome-status style. */
export function gitChips(git: GitStatus): GitChip[] {
  const chips: GitChip[] = []
  const push = (
    key: string,
    text: string,
    title: string,
    tone: GitChip['tone'],
  ) => chips.push({ key, text, title, tone })

  if (git.ahead)
    push('ahead', `↑${git.ahead}`, `${git.ahead} commit(s) to push`, 'neutral')
  if (git.behind)
    push(
      'behind',
      `↓${git.behind}`,
      `${git.behind} commit(s) to pull`,
      'neutral',
    )
  if (git.staged)
    push('staged', `+${git.staged}`, `${git.staged} staged`, 'staged')
  if (git.modified)
    push('modified', `~${git.modified}`, `${git.modified} modified`, 'modified')
  if (git.untracked)
    push(
      'untracked',
      `?${git.untracked}`,
      `${git.untracked} untracked`,
      'untracked',
    )
  if (git.conflicted)
    push(
      'conflict',
      `!${git.conflicted}`,
      `${git.conflicted} conflicted`,
      'conflict',
    )
  if (!git.staged && !git.modified && !git.untracked && !git.conflicted) {
    push('clean', 'clean', 'working tree clean', 'clean')
  }
  return chips
}

export const branchLabel = (git: GitStatus) =>
  git.detached ? `detached @ ${git.branch}` : git.branch
