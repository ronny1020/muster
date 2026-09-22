import type { JournalEntry } from '../../../shared/ipc'

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
