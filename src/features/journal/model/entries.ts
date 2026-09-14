import type { JournalEntry } from '../../../shared/ipc'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago a recorded session last printed, at the coarseness a list wants.
 *
 * The record has no heartbeat — the file's mtime is the last byte written — so
 * this deliberately says "last printed", never "ran for".
 */
export function agoLabel(endedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000) - endedAt)
  if (seconds < MINUTE) return 'just now'
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`
  return `${Math.floor(seconds / DAY)}d ago`
}

/**
 * The entries a tab should offer, newest first and excluding the run it is
 * currently recording — reopening the session you are looking at is not a
 * recovery.
 *
 * A record is named `<tab id>-<started at>`, so one tab accumulates one per run
 * and **only the newest of them is live**. Excluding every record carrying the
 * tab's prefix would hide that tab's earlier runs too — including the one just
 * watched, which is the one most worth reopening. Entries arrive newest first,
 * so the live record is the first match.
 */
export function earlierThan(
  entries: JournalEntry[],
  liveTabId: string | null,
): JournalEntry[] {
  const mine = (entry: JournalEntry) =>
    Boolean(liveTabId) && entry.id.startsWith(`${liveTabId}-`)
  const live = entries.find(mine)
  return entries.filter((entry) => entry.bytes > 0 && entry !== live)
}
