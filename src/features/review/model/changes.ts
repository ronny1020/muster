/**
 * The changed-file list: how it is ordered, what each status looks like, and
 * which entry a path clicked in the terminal belongs to.
 */
import type { ChangedFile, ChangeStatus } from '../../../shared/ipc'

/** One letter per status, as every git client has shown them for decades. */
const STATUS_MARKS: Record<ChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  conflicted: '!',
  typechange: 'T',
  untracked: '?',
}

/** Tailwind colour per status, matching the status bar's git chips. */
const STATUS_TONES: Record<ChangeStatus, string> = {
  added: 'text-[#7fb37a]',
  modified: 'text-[#d8b165]',
  deleted: 'text-danger',
  renamed: 'text-[#b58cd8]',
  copied: 'text-[#b58cd8]',
  conflicted: 'text-danger',
  typechange: 'text-[#d8b165]',
  untracked: 'text-[#6f9ede]',
}

export const statusMark = (status: ChangeStatus) => STATUS_MARKS[status] ?? 'M'
export const statusTone = (status: ChangeStatus) =>
  STATUS_TONES[status] ?? 'text-muted'

/**
 * Folder first, then filename, both case-insensitively — so a file's
 * neighbours in the list are its neighbours on disk, whatever order git
 * reported and whichever pass (tracked, then untracked) found it.
 */
export function sortChanges(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort((left, right) => {
    const byFolder = folderOf(left.path).localeCompare(
      folderOf(right.path),
      undefined,
      { sensitivity: 'base' },
    )
    return byFolder !== 0
      ? byFolder
      : basename(left.path).localeCompare(basename(right.path), undefined, {
          sensitivity: 'base',
        })
  })
}

export interface ChangeTotals {
  files: number
  insertions: number
  deletions: number
}

export const changeTotals = (files: ChangedFile[]): ChangeTotals => ({
  files: files.length,
  insertions: files.reduce((sum, file) => sum + file.insertions, 0),
  deletions: files.reduce((sum, file) => sum + file.deletions, 0),
})

/**
 * The changed file an absolute path names, or `null`.
 *
 * This is what makes a path in an agent's output openable in the review panel:
 * the terminal resolves what it printed to an absolute path, and the panel's
 * entries are relative to the repository root. Windows decides both separators
 * and case differently from the shell an agent prints in, so neither is
 * allowed to matter.
 */
export function matchChanged(
  files: ChangedFile[],
  absolutePath: string,
  root: string,
): ChangedFile | null {
  const relative = relativeTo(absolutePath, root)
  if (relative === null) return null
  const wanted = relative.toLowerCase()
  return (
    files.find((file) => slashes(file.path) === relative) ??
    files.find((file) => slashes(file.path).toLowerCase() === wanted) ??
    null
  )
}

/** `path` as the repository sees it, or `null` when it is outside the repo. */
export function relativeTo(path: string, root: string): string | null {
  const base = slashes(root).replace(/\/+$/, '')
  const full = slashes(path)
  if (!base) return null
  if (full === base) return ''
  const prefix = `${base}/`
  if (full.startsWith(prefix)) return full.slice(prefix.length)
  // Case-insensitively too: a Windows path can arrive spelled either way, and
  // an agent often prints the drive letter in the other case.
  return full.toLowerCase().startsWith(prefix.toLowerCase())
    ? full.slice(prefix.length)
    : null
}

/** An absolute path for a repo-relative one, for opening and revealing. */
export const absolutePath = (root: string, path: string) =>
  `${slashes(root).replace(/\/+$/, '')}/${slashes(path)}`

const slashes = (path: string) => path.replace(/\\/g, '/')

export const basename = (path: string) =>
  slashes(path).split('/').filter(Boolean).pop() ?? path

/** `''` for a file at the root, which sorts before every folder. */
export function folderOf(path: string): string {
  const parts = slashes(path).split('/')
  return parts.slice(0, -1).join('/')
}
