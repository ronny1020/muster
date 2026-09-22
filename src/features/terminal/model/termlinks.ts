/**
 * Finding file paths in terminal output.
 *
 * Agents print paths constantly — `src/App.tsx:42`, `/tmp/shot.png`, a diff
 * header — and every one of them is somewhere the user wants to go. The
 * matching has to stay conservative: a false positive underlines prose and
 * makes the terminal feel broken, which is worse than missing a path.
 *
 * A match needs **both** a separator and a file extension. The separator is
 * what tells a path from a word; the extension is what tells a file from a
 * directory, which is what a click can actually open.
 */

export interface PathMatch {
  /** The path as it appears, without any `:line:col` suffix or trailing punctuation. */
  path: string
  /** Line number from a `path:line` or `path:line:col` suffix. */
  line?: number
  column?: number
  /** Zero-based offsets of the whole match, suffix included, within the input. */
  start: number
  end: number
}

/**
 * A run of path-ish characters. Deliberately excludes whitespace, quotes and
 * brackets, so a path inside `"…"` or `(…)` matches without them.
 */
const CANDIDATE = /[^\s"'`()[\]{}<>|]+/g

/** `:12` or `:12:34` at the end, as editors and compilers print it. */
const POSITION = /:(\d+)(?::(\d+))?$/

/** Punctuation that ends a sentence rather than a path. */
const TRAILING_NOISE = /[.,;:!?]+$/

/**
 * Every path-looking run in one line of terminal output.
 *
 * A candidate qualifies only if it carries a path separator — `foo.txt` alone
 * is far more often a word in a sentence than a file worth linking.
 */
export function findPaths(text: string): PathMatch[] {
  const matches: PathMatch[] = []

  for (const candidate of text.matchAll(CANDIDATE)) {
    const raw = candidate[0]
    const start = candidate.index
    const trimmed = raw.replace(TRAILING_NOISE, '')
    if (!trimmed) continue

    const position = POSITION.exec(trimmed)
    const path = position ? trimmed.slice(0, position.index) : trimmed
    if (!looksLikePath(path)) continue

    matches.push({
      path,
      ...(position ? { line: Number(position[1]) } : {}),
      ...(position?.[2] ? { column: Number(position[2]) } : {}),
      start,
      end: start + trimmed.length,
    })
  }

  return matches
}

/** A final segment ending in `.` plus letters or digits — `a.ts`, `.env`. */
const EXTENSION = /\.[A-Za-z0-9]+$/

function looksLikePath(path: string): boolean {
  if (path.length < 2) return false
  // A separator is what distinguishes a path from a word.
  const separated = path.includes('/') || /^[A-Za-z]:\\/.test(path)
  if (!separated) return false
  // A dot in the last segment is what stands in for "this is a file".
  // Clicking one opens it for reading, which a directory has nothing to
  // answer with — and agents name directories constantly (`cd src/features`,
  // a tree drawn in output), so linking them underlines most of a session.
  // The test is a proxy, not the question: `Makefile` and `/etc/hosts` are
  // files it declines, and a version in a path — `node/v20.11.0` — is one it
  // takes.
  if (!EXTENSION.test(path.split(/[/\\]/).pop() ?? '')) return false
  // `http://…` is a URL; the web-links addon already owns those.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false
  // A bare `/` or `//` carries no filename.
  return /[^/\\]/.test(path)
}

/**
 * An absolute path for `match`, resolved the way the shell would: `~` against
 * the home directory, anything relative against the session's own directory.
 */
export function resolvePath(path: string, cwd: string, home: string): string {
  if (path.startsWith('~/')) return join(home, path.slice(2))
  if (path.startsWith('/') || /^[A-Za-z]:\\/.test(path)) return path
  return join(cwd, path.replace(/^\.\//, ''))
}

function join(base: string, rest: string): string {
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[/\\]+$/, '')}${separator}${rest}`
}

/**
 * Whether `path` names something inside `cwd`.
 *
 * A string comparison on both absolute paths, because whether the agent wrote
 * the path relative or absolute says nothing about where it points, and an
 * absolute path is the usual way an agent names a file it just edited.
 *
 * The separator check is what stops `/work/repo-old` reading as inside
 * `/work/repo`. Comparison is case-sensitive: both strings come from the same
 * filesystem in the same session, so a difference in case is a different path
 * on the one platform where that is true.
 *
 * **It is a prefix test, not a containment test.** Neither this nor
 * `resolvePath` collapses `..`, so `../other/file.ts` resolves to
 * `/work/repo/../other/file.ts` and satisfies the prefix while pointing
 * outside the repo. Treat the answer as "the agent named a path under this
 * directory", never as proof the file is in it.
 */
export function isUnder(path: string, cwd: string): boolean {
  if (!cwd) return false
  const base = normalizeSeparators(cwd).replace(/\/+$/, '')
  const target = normalizeSeparators(path)
  return base.length > 0 && target.startsWith(`${base}/`)
}

const normalizeSeparators = (path: string) => path.replace(/\\/g, '/')
