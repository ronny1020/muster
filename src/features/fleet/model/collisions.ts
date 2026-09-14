/**
 * Which files more than one tab is changing at once.
 *
 * Only the process that owns every tab can answer this. A hook inside one agent
 * sees its own index and nothing else, and two linked worktrees of one
 * repository have separate indexes entirely — which is exactly the arrangement
 * parallel agents are run in. So the comparison is keyed on the directory the
 * worktrees share, never on their own roots.
 */

/** What one tab is changing, as the comparison needs it. */
export interface TabChanges {
  tabId: string
  /** What the tab is called, for naming the other side of a collision. */
  title: string
  /** The directory every worktree of this repository shares; empty if none. */
  commonDir: string
  /** This tab's own working tree, which is what tells two worktrees apart. */
  root: string
  /** Repo-relative paths this tab has changed. */
  paths: string[]
}

/** One file more than one tab is changing, and who else is changing it. */
export interface Collision {
  path: string
  /** The other tabs, by title, in the order their tabs are open. */
  others: string[]
}

/**
 * Collisions per tab, keyed by tab id.
 *
 * A tab with nothing shared is absent rather than present-and-empty, so a
 * caller can ask `has` instead of checking a length.
 */
export function collisionsByTab(
  changes: TabChanges[],
): Map<string, Collision[]> {
  const found = new Map<string, Collision[]>()
  // One repository at a time: two tabs on unrelated projects can both change
  // `README.md` without it meaning anything.
  for (const group of groupByRepo(changes)) {
    for (const [path, tabs] of sharedPaths(group)) {
      for (const tab of tabs) {
        const others = tabs
          .filter((other) => other.root !== tab.root)
          .map((other) => other.title)
        // Two tabs in one working tree share every file by definition — they
        // are one tree. Warning about that would light permanently, and a
        // warning that is always on is one nobody reads.
        if (others.length === 0) continue
        found.set(tab.tabId, [
          ...(found.get(tab.tabId) ?? []),
          { path, others },
        ])
      }
    }
  }
  return found
}

function groupByRepo(changes: TabChanges[]): TabChanges[][] {
  const repos = new Map<string, TabChanges[]>()
  for (const tab of changes) {
    // A tab outside a repository shares nothing by definition, and grouping
    // them all under one empty key would collide every one with every other.
    if (!tab.commonDir) continue
    repos.set(tab.commonDir, [...(repos.get(tab.commonDir) ?? []), tab])
  }
  return [...repos.values()].filter((group) => group.length > 1)
}

function sharedPaths(group: TabChanges[]): Map<string, TabChanges[]> {
  const owners = new Map<string, TabChanges[]>()
  for (const tab of group) {
    // A tab listing one path twice must not collide with itself.
    for (const path of new Set(tab.paths)) {
      owners.set(path, [...(owners.get(path) ?? []), tab])
    }
  }
  return new Map([...owners].filter(([, tabs]) => tabs.length > 1))
}

/**
 * What the status bar's chip says, or empty when there is nothing to say.
 *
 * Named after the file when there is only one, because the path is the
 * actionable half: `src/auth.ts` sends you somewhere, "1 file" does not.
 */
export function collisionSummary(collisions: Collision[]): string {
  if (collisions.length === 0) return ''
  const [first] = collisions
  const others = new Set(collisions.flatMap((collision) => collision.others))
  const where = others.size === 1 ? [...others][0] : `${others.size} other tabs`
  const rest = collisions.length - 1
  return rest > 0
    ? `${first.path} +${rest} also in ${where}`
    : `${first.path} also in ${where}`
}
