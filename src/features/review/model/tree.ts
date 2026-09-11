/**
 * What the file tree shows, and in what order.
 *
 * The backend lists a directory exactly as the filesystem reports it; every
 * decision about which entries are worth drawing is here, where a test can
 * reach it.
 */
import type { DirEntry } from '../../../shared/ipc'

/**
 * Never shown, at any setting. `.git` is the repository's own bookkeeping —
 * thousands of files, none of them yours — and `.DS_Store` is noise Finder
 * leaves behind.
 */
const ALWAYS_HIDDEN = new Set(['.git', '.DS_Store'])

/**
 * Directories first, then names, case-insensitively — the order every file
 * tree uses, and the only one in which a folder's contents read as a group.
 */
export function visibleEntries(
  entries: DirEntry[],
  showHidden: boolean,
): DirEntry[] {
  return entries
    .filter((entry) => !ALWAYS_HIDDEN.has(entry.name))
    .filter((entry) => showHidden || !entry.name.startsWith('.'))
    .sort((left, right) => {
      if (left.directory !== right.directory) return left.directory ? -1 : 1
      return left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base',
      })
    })
}
