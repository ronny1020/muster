import {
  type Deck,
  type LauncherStart,
  newTab,
  type Tab,
  tabSession,
} from './deck'
import type { Backend } from './platform'

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

const STORAGE_KEY = 'muster.deck'

/** How many tabs are worth remembering; past this it is clutter, not state. */
const MAX_TABS = 24

interface StoredDeck {
  /** One entry per tab, `null` for a tab that had nothing chosen yet. */
  tabs: (LauncherStart | null)[]
  activeIndex: number
}

/** What to write for a tab: its session's launch details, or nothing. */
export function startOf(tab: Tab): LauncherStart | null {
  const session = tabSession(tab)
  if (session) {
    return {
      agentId: session.agentId,
      cwd: session.cwd,
      backend: session.backend,
      distro: session.distro,
      // The args a session was launched with include its mode (`--continue`),
      // which is a choice to make again rather than one to replay.
      flags: '',
    }
  }
  if (tab.content.type === 'launcher' && tab.content.start) {
    return tab.content.start
  }
  return null
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
  try {
    // Compared against what is stored, not a remembered string: `patch`
    // rebuilds the tab array on every dispatch and the git poll dispatches per
    // tab per interval, so this ran constantly with nothing to say. A read is
    // far cheaper than the synchronous write it skips, and unlike a memo it
    // stays correct when something else clears the store.
    if (localStorage.getItem(STORAGE_KEY) === record) return
    localStorage.setItem(STORAGE_KEY, record)
  } catch {
    /* private browsing or a full quota: this run keeps its tabs anyway */
  }
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
    return normalizeDeck(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'))
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
