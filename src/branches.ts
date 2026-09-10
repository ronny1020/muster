import type { Branch, GitStatus } from './ipc'

/**
 * Branches matching `query`, with the ones that start with it first.
 *
 * Substring rather than fuzzy matching: branch names are already hierarchical
 * (`feature/thing`), so typing a path segment is the common case, and a fuzzy
 * match on short names returns almost everything.
 */
export function matchBranches(branches: Branch[], query: string): Branch[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return branches
  const hits = branches.filter((branch) =>
    branch.name.toLowerCase().includes(needle),
  )
  const starts = (branch: Branch) =>
    branch.name.toLowerCase().startsWith(needle)
  return [...hits.filter(starts), ...hits.filter((b) => !starts(b))]
}

/**
 * What to warn about before switching, or `null` when there is nothing to say.
 *
 * Whether git will actually refuse depends on which files differ between the
 * two branches, which is not knowable here — so this says what is at stake
 * rather than predicting the outcome, and the checkout error is what reports a
 * real refusal.
 */
export function switchWarning(git: GitStatus): string | null {
  if (git.conflicted > 0) return 'Resolve the conflicts first.'
  const pending = git.staged + git.modified
  if (pending > 0) {
    return `${pending} uncommitted change${pending === 1 ? '' : 's'} — git will refuse if the branches differ there.`
  }
  return null
}
