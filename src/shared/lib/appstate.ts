/**
 * The app's own state, cached in memory so every caller can stay synchronous.
 *
 * `loadAppState` fills it before the first render and only writes leave the
 * webview; see AGENTS.md's "Tabs and settings belong to the app" invariant for
 * why they are not in `localStorage`, and for what does stay there.
 */
import { readAppState, windowLabel, writeAppState } from '../ipc'

const entries = new Map<string, string>()

/** Keys that used to live in `localStorage`, migrated once on first load. */
const MIGRATED = ['muster.settings', 'muster.recent-dirs']

/**
 * Fills the cache. Must finish before anything reads state, so the app mounts
 * after it — a read that lands early would answer "nothing stored" and restore
 * a blank deck over a real one.
 */
export async function loadAppState() {
  try {
    for (const [key, value] of Object.entries(await readAppState()))
      entries.set(key, value)
  } catch {
    /* an unreadable store is an empty one; the run still works */
  }
  migrate()
}

/** Moves anything an older version left in `localStorage`, once. */
function migrate() {
  // The deck was one global key before windows owned their own tabs, so it
  // comes across under whichever window happens to run the migration.
  const deck = `muster.deck:${windowLabel()}`
  for (const key of [...MIGRATED, deck]) {
    const from = key === deck ? 'muster.deck' : key
    if (entries.has(key)) continue
    try {
      const value = localStorage.getItem(from)
      if (value === null) continue
      setAppState(key, value)
      localStorage.removeItem(from)
    } catch {
      /* no localStorage here, so there is nothing to bring across */
    }
  }
}

export const appState = (key: string) => entries.get(key) ?? null

export function forgetAppState(key: string) {
  entries.delete(key)
  void persist(key, null)
}

/**
 * Sends one entry to the store, keeping the cache authoritative if it fails.
 *
 * A failed write is not worth interrupting the session for — the run keeps the
 * value it just set, and the next write of the same key tries again — but it
 * is worth being able to see, which a bare `.catch(() => {})` is not.
 */
const persist = async (key: string, value: string | null) => {
  try {
    await writeAppState(key, value)
  } catch (error) {
    console.warn(`could not store ${key}`, error)
  }
}

export function setAppState(key: string, value: string) {
  if (entries.get(key) === value) return
  entries.set(key, value)
  void persist(key, value)
}

/**
 * Seeds the cache without going near the backend, for tests — the same seam
 * `localStorage` gave them before this moved.
 */
export function seedAppState(values: Record<string, string>) {
  entries.clear()
  for (const [key, value] of Object.entries(values)) entries.set(key, value)
}
