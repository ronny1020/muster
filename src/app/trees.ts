/**
 * Which columns share a working tree, and so a footer and a set of panels.
 *
 * Keyed on each column's shown tab's tree root, read from that tab's own git
 * poll. An empty root — a start screen, settings, a directory outside git —
 * never joins anything: there is no tree for the columns to share.
 */

/** Neighbouring columns showing one tree, which draw one footer. */
export interface TreeRun {
  root: string
  /** Column indexes, both inclusive. */
  first: number
  last: number
}

/** The columns, left to right, cut wherever the tree changes. */
export function treeRuns(roots: string[]): TreeRun[] {
  const runs: TreeRun[] = []
  roots.forEach((root, column) => {
    const previous = runs.at(-1)
    if (root && previous?.root === root) previous.last = column
    else runs.push({ root, first: column, last: column })
  })
  return runs
}

/** The roots more than one column shows, adjacent or not. */
export function sharedRoots(roots: string[]): Set<string> {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const root of roots) {
    if (!root) continue
    if (seen.has(root)) shared.add(root)
    seen.add(root)
  }
  return shared
}

/** Whether `column` is one of `run`'s. */
const holds = (run: TreeRun, column: number) =>
  run.first <= column && column <= run.last

/**
 * Of a tree's runs, the one that draws its panels: the one holding the
 * keyboard, else the one that drew them last, else the rightmost. One run,
 * so a tree split by a column between never shows the same file twice.
 */
export function panelRun(
  runs: TreeRun[],
  { focus, drewLast }: { focus: number; drewLast: (run: TreeRun) => boolean },
): TreeRun | undefined {
  return (
    runs.find((run) => holds(run, focus)) ?? runs.find(drewLast) ?? runs.at(-1)
  )
}

/** The window's columns as the grouping needs them. */
export interface Columns {
  /** The tab each column shows, left to right. */
  shown: string[]
  /** Each column's tree, by the same index. */
  roots: string[]
  /** The column with the keyboard. */
  focus: number
}

/**
 * The tab whose pane draws each shared tree's panels, by root — the rightmost
 * column of the run `panelRun` picks. `holders` names the tab that last had
 * the keyboard on each tree.
 */
export function panelLeads(
  { shown, roots, focus }: Columns,
  holders: Record<string, string>,
): Map<string, string> {
  const runs = treeRuns(roots)
  return new Map(
    [...sharedRoots(roots)].flatMap((root) => {
      const run = panelRun(
        runs.filter((entry) => entry.root === root),
        {
          focus,
          drewLast: (entry) =>
            shown.slice(entry.first, entry.last + 1).includes(holders[root]),
        },
      )
      return run ? [[root, shown[run.last]] as const] : []
    }),
  )
}

/** Each run with the tab that draws its footer: the keyboard's, else the rightmost. */
export const footerOwners = ({ shown, roots, focus }: Columns) =>
  treeRuns(roots).map((run) => ({
    run,
    owner: shown[holds(run, focus) ? focus : run.last],
  }))

/** Columns that must take a tree's view, and the column it comes from. */
export interface JoinSync {
  from: string
  to: string[]
}

/**
 * Which shown tabs have just come onto a tree another column shows, and whose
 * view they take: a column already there, else any on it — the keyboard's,
 * else the rightmost.
 *
 * `now` and `previous` map each shown tab, left to right, to its tree.
 */
export function joinSyncs({
  now,
  previous,
  activeId,
}: {
  now: Map<string, string>
  previous: Map<string, string>
  activeId: string
}): JoinSync[] {
  const byRoot = new Map<string, string[]>()
  for (const [id, root] of now) {
    if (root) byRoot.set(root, [...(byRoot.get(root) ?? []), id])
  }
  return [...byRoot].flatMap(([root, members]) => {
    if (members.length < 2) return []
    const stayed = members.filter((id) => previous.get(id) === root)
    const pool = stayed.length > 0 ? stayed : members
    const from = pool.includes(activeId) ? activeId : pool[pool.length - 1]
    const to = members.filter((id) => id !== from && !stayed.includes(id))
    return to.length > 0 ? [{ from, to }] : []
  })
}
