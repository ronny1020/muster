/**
 * Finding file paths in terminal output.
 *
 * Agents print paths constantly — `src/App.tsx:42`, `/tmp/shot.png`, a diff
 * header — and every one of them is somewhere the user wants to go. The
 * matching has to stay conservative: a false positive underlines prose and
 * makes the terminal feel broken, which is worse than missing a path.
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

function looksLikePath(path: string): boolean {
  if (path.length < 2) return false
  // A separator is what distinguishes a path from a word.
  const separated = path.includes('/') || /^[A-Za-z]:\\/.test(path)
  if (!separated) return false
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
