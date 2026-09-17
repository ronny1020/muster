import { type Deck, type LauncherStart, newTab, startOf } from './deck'
import type { Backend } from '../../../shared/lib/platform'
import { appState, setAppState } from '../../../shared/lib/appstate'
import { windowLabel } from '../../../shared/ipc'

/**
 * Remembering the window's tabs across a restart.
 *
 * Deliberately *not* the sessions themselves. Restoring one would mean
 * respawning a PTY: the scrollback is gone either way, and the agent would
 * restart mid-thought — several at once, all racing for the same repo. So a
 * restored tab comes back as a launcher with its directory and agent already
 * filled in, one click from going, and `--continue` is right there for the
 * conversation.
 *
 * Loading is total, like settings: a truncated or hand-edited record has to
 * repair to something usable, because a window that will not open leaves no way
 * to fix it.
 */

/**
 * One key per window: the deck is what a window is showing, so two windows
 * must not share it. The backend store is global, which is exactly why the
 * window's own name has to be in the key.
 */
const storageKey = () => `muster.deck:${windowLabel()}`

/** How many tabs are worth remembering; past this it is clutter, not state. */
const MAX_TABS = 24

interface StoredDeck {
  /** One entry per tab, `null` for a tab that had nothing chosen yet. */
  tabs: (LauncherStart | null)[]
  activeIndex: number
}

export function saveDeck(deck: Deck) {
  // Settings is not a workspace; it reopens from its own shortcut.
  const tabs = deck.tabs.filter((tab) => tab.content.type !== 'settings')
  const activeIndex = tabs.findIndex((tab) => tab.id === deck.activeId)
  const stored: StoredDeck = {
    tabs: tabs.slice(0, MAX_TABS).map(startOf),
    activeIndex: activeIndex < 0 ? 0 : Math.min(activeIndex, MAX_TABS - 1),
  }
  const record = JSON.stringify(stored)
  // Compared against what is stored, not a remembered string: `patch` rebuilds
  // the tab array on every dispatch and the git poll dispatches per tab per
  // interval, so this ran constantly with nothing to say. Unlike a memo, a read
  // stays correct when something else clears the store.
  if (appState(storageKey()) === record) return
  setAppState(storageKey(), record)
}

/**
 * The remembered deck, or a single blank tab when there is nothing to restore.
 *
 * `nextId` is called once per tab so the caller owns id generation — the ids
 * key the backend's PTY map, and a restored id colliding with a fresh one would
 * take over a live session.
 */
export function loadDeck(nextId: () => string): Deck {
  const starts = readStarts()
  if (starts.tabs.length === 0) {
    const id = nextId()
    return { tabs: [newTab(id)], activeId: id }
  }
  const tabs = starts.tabs.map((start) =>
    newTab(
      nextId(),
      start ? { type: 'launcher', start } : { type: 'launcher' },
    ),
  )
  return { tabs, activeId: tabs[starts.activeIndex]!.id }
}

function readStarts(): StoredDeck {
  try {
    return normalizeDeck(JSON.parse(appState(storageKey()) ?? '{}'))
  } catch {
    return { tabs: [], activeIndex: 0 }
  }
}

export function normalizeDeck(input: unknown): StoredDeck {
  const raw = (
    typeof input === 'object' && input !== null ? input : {}
  ) as Record<string, unknown>
  const tabs = Array.isArray(raw.tabs)
    ? raw.tabs.slice(0, MAX_TABS).map(normalizeStart)
    : []
  const index = Number(raw.activeIndex)
  const activeIndex =
    Number.isInteger(index) && index >= 0 && index < tabs.length ? index : 0
  return { tabs, activeIndex }
}

function normalizeStart(input: unknown): LauncherStart | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : ''
  // Trimmed only to decide whether anything was stored: a directory name may
  // legally end in a space, so the value itself is kept as written.
  if (!cwd.trim()) return null
  const backend: Backend = raw.backend === 'wsl' ? 'wsl' : 'native'
  return {
    agentId: typeof raw.agentId === 'string' ? raw.agentId : '',
    cwd,
    backend,
    distro: typeof raw.distro === 'string' ? raw.distro : '',
    flags: typeof raw.flags === 'string' ? raw.flags : '',
  }
}
