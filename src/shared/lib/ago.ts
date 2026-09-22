const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago something was written, at the coarseness a list wants.
 *
 * Both arguments are what their sources hand over: `at` in seconds, as every
 * record's mtime crosses IPC, and `now` in milliseconds, as `Date.now()` gives
 * it.
 */
export function agoLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000) - at)
  if (seconds < MINUTE) return 'just now'
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`
  return `${Math.floor(seconds / DAY)}d ago`
}
