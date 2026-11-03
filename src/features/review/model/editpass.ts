/**
 * One pass of the live-edit reader: what moved in the tree since the last
 * pass, and the lines each move wrote. Git is a parameter, so the attribution
 * is testable without a repository.
 */
import type { ChangedFile, Changes } from '../../../shared/ipc'
import { type Edit, freshLines, MAX_LINES, movedFiles, tally } from './edits'

/**
 * `git diff`s at most per pass, across the files whose entry moved and the
 * recently edited ones re-checked. A formatter run moves hundreds of files;
 * those past the budget are still reported, by their counts alone.
 */
export const MAX_READ = 8

/**
 * Patches remembered on the first pass, so the first edit to a file that was
 * already modified shows only its own lines rather than the file's whole diff.
 */
const MAX_PRIMED = 20

/** Patches kept between passes, one whole patch each. */
const MAX_REMEMBERED = 200

export interface EditGit {
  /** The changed-file list, with line counts. */
  changes: (cwd: string) => Promise<Changes>
  /**
   * One file's patch against the exact commit `head` names, with no context
   * lines — never the live `HEAD`, or a commit landing after the list was read
   * would measure the patch from a base the list never saw. Rejects when the
   * patch was cut short, since a cut patch compared as whole reads its lost
   * tail as lines taken back.
   */
  patch: (request: PatchRequest) => Promise<string>
}

interface Seen {
  /** The repository, not the directory: a `cd` inside it is the same tree. */
  root: string
  head: string
  files: ChangedFile[]
}

export interface Memory {
  seen: { current: Seen | null }
  /** Each remembered file's patch, least recently read first. */
  patches: Map<string, string>
  nextId: { current: number }
}

export interface PatchRequest {
  cwd: string
  path: string
  /** Where a staged rename came from, so git pairs the two halves. */
  oldPath?: string
  head: string
}

export interface PassOptions {
  cwd: string
  memory: Memory
  git: EditGit
}

export interface Pass {
  edits: Edit[]
  /** A new baseline was taken, so edits from before it belong to another tree. */
  fresh: boolean
}

/** One pass: the edits since the last one, and the memory moved forward. */
export async function readEdits({
  cwd,
  memory,
  git,
}: PassOptions): Promise<Pass> {
  // `null` for a read that failed: an empty patch would read as every line
  // the file had being taken back.
  const changes = await git.changes(cwd).catch(() => null)
  // A failed read keeps the baseline: dropping it would fold every edit made
  // around the failure into the next one, unreported — and git's own failure
  // arrives as an empty list beside an error, which would read as every file
  // taken back.
  if (!changes || changes.error) return { edits: [], fresh: false }
  if (!changes.repo) {
    memory.seen.current = null
    return { edits: [], fresh: false }
  }
  const head = changes.head
  const patchOf = (path: string, oldPath?: string) =>
    git.patch({ cwd, path, head, oldPath }).catch((): null => null)
  const before = memory.seen.current
  memory.seen.current = {
    root: changes.root,
    head: changes.head,
    files: changes.files,
  }
  const fresh = !before || before.root !== changes.root
  // A moved `HEAD` — a commit, a pull, a checkout — measures every patch from
  // a new base, and a file that left the list was committed, not taken back.
  // Nothing in such a pass is an edit; it takes a new baseline. The sha comes
  // from the same read as the list, so a commit landing mid-pass cannot pair
  // the list from before it with the `HEAD` from after.
  if (fresh || before.head !== changes.head) {
    memory.patches.clear()
    for (const file of changes.files.slice(0, MAX_PRIMED)) {
      const patch = await patchOf(file.path, file.oldPath ?? undefined)
      if (patch !== null) memory.patches.set(file.path, patch)
    }
    return { edits: [], fresh }
  }

  const earlier = new Map(before.files.map((file) => [file.path, file]))
  const now = new Map(changes.files.map((file) => [file.path, file]))
  // Every read of a renamed file names its old path too: alone, the new
  // name reads as the whole file added.
  const oldOf = (path: string) => now.get(path)?.oldPath ?? undefined
  const all = movedFiles(before.files, changes.files)
  const renaming = renamesIn({ earlier, now })
  const edits: Edit[] = []
  // Counted before the lines are capped, so a 500-line file reads +500.
  const record = (
    edit: Pick<Edit, 'path' | 'status' | 'lines' | 'added' | 'removed'>,
  ) =>
    edits.push({
      ...edit,
      oldPath: oldOf(edit.path),
      id: memory.nextId.current++,
      root: changes.root,
      lines: edit.lines.slice(0, MAX_LINES),
      at: Date.now(),
    })

  // A rename appearing or going — `git mv`, a second rename, `mv` then
  // `git add` — is not an edit, and pairing its halves line by line is where
  // false cards came from. Its files take a fresh baseline and show nothing;
  // the next edit to them shows as any other.
  // Re-read up to the priming budget; past it a file is only forgotten, and
  // its next edit is told by its counts, as an unprimed file's is.
  let reread = 0
  for (const path of renaming) {
    memory.patches.delete(path)
    if (!now.has(path) || reread >= MAX_PRIMED) continue
    reread += 1
    const patch = await patchOf(path, oldOf(path))
    if (patch !== null) remember(memory.patches, { path, patch })
  }
  const moved = all.filter(({ path }) => !renaming.has(path))
  const read = moved.slice(0, MAX_READ)

  for (const { path, status } of read) {
    const after = status === null ? '' : await patchOf(path, oldOf(path))
    const was = earlier.get(path)
    if (after === null) {
      memory.patches.delete(path)
      const counts = countDelta(was, now.get(path))
      if (!isZero(counts)) record({ path, status, lines: [], ...counts })
      continue
    }
    const known = memory.patches.get(path)
    // No earlier patch — never primed, or forgotten after a failed or
    // over-budget read — so only the counts can say what moved.
    const lines =
      known !== undefined || !was ? freshLines(known ?? '', after) : []
    remember(memory.patches, { path, patch: after })
    const counts =
      lines.length > 0 ? tally(lines) : countDelta(was, now.get(path))
    // Staged, or a status that moved with nothing in it — `git add` turns
    // `untracked` into `added` and changes no line.
    if (lines.length === 0 && (known !== undefined || isZero(counts))) continue
    record({ path, status, lines, ...counts })
  }
  // Past the budget: reported by counts, and forgotten, so a later edit to
  // one of them cannot claim this one's lines. Counts alone cannot show a
  // change that moves none, so such a file shows nothing here.
  for (const { path, status } of moved.slice(MAX_READ)) {
    memory.patches.delete(path)
    const counts = countDelta(earlier.get(path), now.get(path))
    if (!isZero(counts)) record({ path, status, lines: [], ...counts })
  }

  // Rewritten in place: same counts, different lines. Only the patch says.
  // Just read, as a move or a rename's fresh baseline: nothing to re-check.
  const movedPaths = new Set([...all.map((entry) => entry.path), ...renaming])
  const budget = MAX_READ - read.length
  // `slice(-0)` is the whole list, so an empty budget is said outright.
  const recent =
    budget > 0
      ? [...memory.patches.keys()]
          .filter((path) => !movedPaths.has(path) && now.has(path))
          .slice(-budget)
      : []
  for (const path of recent) {
    const known = memory.patches.get(path) ?? ''
    const after = await patchOf(path, oldOf(path))
    if (after === null || after === known) continue
    const lines = freshLines(known, after)
    remember(memory.patches, { path, patch: after })
    if (lines.length === 0) continue
    record({
      path,
      status: now.get(path)?.status ?? null,
      lines,
      ...tally(lines),
    })
  }
  return { edits, fresh: false }
}

/** Stores `patch` as the newest, which is what keeps it among the re-checked. */
function remember(
  patches: Map<string, string>,
  { path, patch }: { path: string; patch: string },
) {
  patches.delete(path)
  if (patch) patches.set(path, patch)
  // The least recently read go first: a long session touches far more files
  // than a pass will ever re-check.
  for (const stale of patches.keys()) {
    if (patches.size <= MAX_REMEMBERED) break
    patches.delete(stale)
  }
}

const isZero = ({ added, removed }: { added: number; removed: number }) =>
  added === 0 && removed === 0

/**
 * What moved, from counts alone. A fall in insertions is lines taken back,
 * so it counts as removed — and a fall in deletions as added — the way
 * `freshLines` flips an undone line, rather than vanishing into a `+0 −0`.
 */
function countDelta(was?: ChangedFile, now?: ChangedFile) {
  // An uncounted entry's zeros are placeholders, not a count to subtract.
  if (was?.counted === false || now?.counted === false) {
    return { added: 0, removed: 0 }
  }
  const inserted = (now?.insertions ?? 0) - (was?.insertions ?? 0)
  const deleted = (now?.deletions ?? 0) - (was?.deletions ?? 0)
  return {
    added: Math.max(0, inserted) + Math.max(0, -deleted),
    removed: Math.max(0, deleted) + Math.max(0, -inserted),
  }
}

/**
 * The files whose rename appeared, went or changed source this pass: each
 * path whose rename source differs between the two reads, with both sources.
 * Every path is compared, not just those whose counts moved: git can re-pair
 * a rename with another source and leave the counts as they were.
 */
function renamesIn({
  earlier,
  now,
}: {
  earlier: ReadonlyMap<string, ChangedFile>
  now: ReadonlyMap<string, ChangedFile>
}): Set<string> {
  const renaming = new Set<string>()
  for (const path of new Set([...earlier.keys(), ...now.keys()])) {
    const before = earlier.get(path)?.oldPath ?? null
    const after = now.get(path)?.oldPath ?? null
    if (before === after) continue
    for (const name of [path, before, after]) if (name) renaming.add(name)
  }
  return renaming
}
