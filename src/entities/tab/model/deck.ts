import type { Backend } from '../../../shared/lib/platform'

/**
 * Tab deck state. Kept pure and free of React so the tab behaviour that users
 * actually notice — which tab is focused after a close, what a tab is titled —
 * is directly testable.
 */
export interface Session {
  agentId: string
  agentName: string
  accent: string
  program: string
  args: string[]
  cwd: string
  /** Host or WSL. Only Windows offers anything but the host. */
  backend: Backend
  /** Which WSL distro, when the backend is `wsl`. Empty means the default one. */
  distro: string
}

/**
 * What a launcher tab should open with, when it is restoring a tab from the
 * last run rather than starting blank.
 */
export interface LauncherStart {
  agentId: string
  cwd: string
  backend: Backend
  distro: string
  flags: string
}

/** What a tab is showing. A tab starts as a launcher and becomes a session. */
export type TabContent =
  | { type: 'launcher'; start?: LauncherStart }
  | { type: 'settings' }
  | { type: 'session'; session: Session }

/** Which view the review drawer is on. */
export type ReviewView = 'changes' | 'files'

export interface Tab {
  id: string
  title: string
  /** Secondary line in the tab: git branch while running, exit status after. */
  detail: string
  dirty: boolean
  /** Exit code once the process ended, `null` while it runs or before launch. */
  exitCode: number | null
  /** Whether this tab's git history drawer is open. */
  historyOpen: boolean
  /** Whether this tab's review panel is open. */
  reviewOpen: boolean
  reviewView: ReviewView
  /** Whether this tab's scrollback search bar is open. */
  findOpen: boolean
  /** The session signalled it is done while the user was looking elsewhere. */
  attention: boolean
  content: TabContent
}

export const tabSession = (tab: Tab): Session | null =>
  tab.content.type === 'session' ? tab.content.session : null

export interface Deck {
  tabs: Tab[]
  activeId: string
}

export type DeckAction =
  | { type: 'open'; id: string }
  | { type: 'openSettings'; id: string }
  | { type: 'close'; id: string; replacementId: string }
  | { type: 'activate'; id: string }
  | { type: 'activateIndex'; index: number }
  | { type: 'cycle'; step: number }
  | { type: 'start'; id: string; session: Session; title: string }
  | {
      type: 'workspace'
      id: string
      label: string
      branch: string
      dirty: boolean
    }
  | { type: 'toggleHistory'; id: string }
  | { type: 'toggleReview'; id: string }
  | { type: 'setHistory'; id: string; open: boolean }
  | { type: 'setReview'; id: string; open: boolean }
  | { type: 'showReview'; id: string; view: ReviewView }
  | { type: 'setReviewView'; id: string; view: ReviewView }
  | { type: 'setFind'; id: string; open: boolean }
  | { type: 'attention'; id: string }
  | { type: 'relaunch'; id: string }
  | { type: 'exited'; id: string; code: number }

export const newTab = (
  id: string,
  content: TabContent = { type: 'launcher' },
): Tab => ({
  id,
  title: tabTitle(content),
  detail: '',
  dirty: false,
  exitCode: null,
  historyOpen: false,
  reviewOpen: false,
  reviewView: 'changes',
  findOpen: false,
  attention: false,
  content,
})

/**
 * What the tab strip says before a session starts.
 *
 * A restored tab is named after its directory: several restored tabs all
 * reading "New session" is the state the tab strip is least able to help with.
 */
function tabTitle(content: TabContent): string {
  if (content.type === 'settings') return 'Settings'
  if (content.type === 'launcher' && content.start?.cwd) {
    return basename(content.start.cwd)
  }
  return 'New session'
}

const basename = (path: string) =>
  path.split(/[/\\]/).filter(Boolean).pop() ?? path

export const initialDeck = (id: string): Deck => ({
  tabs: [newTab(id)],
  activeId: id,
})

export function deckReducer(deck: Deck, action: DeckAction): Deck {
  switch (action.type) {
    case 'open':
      return { tabs: [...deck.tabs, newTab(action.id)], activeId: action.id }

    case 'openSettings':
      return openSettings(deck, action.id)

    case 'close':
      return closeTab(deck, action.id, action.replacementId)

    case 'activate':
      if (!deck.tabs.some((tab) => tab.id === action.id)) return deck
      // Looking at a tab is how its notice gets acknowledged.
      return { ...clearAttention(deck, action.id), activeId: action.id }

    case 'activateIndex': {
      const tab =
        action.index === -1 ? deck.tabs.at(-1) : deck.tabs[action.index]
      return tab ? { ...clearAttention(deck, tab.id), activeId: tab.id } : deck
    }

    case 'cycle': {
      const index = deck.tabs.findIndex((tab) => tab.id === deck.activeId)
      if (index < 0) return deck
      const next =
        deck.tabs[(index + action.step + deck.tabs.length) % deck.tabs.length]
      return { ...clearAttention(deck, next.id), activeId: next.id }
    }

    case 'start':
      return patch(deck, action.id, () => ({
        content: { type: 'session', session: action.session },
        title: action.title,
        exitCode: null,
        detail: '',
        // The find bar only exists once a terminal does, so a search opened on
        // the launcher would otherwise appear unbidden over the new session.
        findOpen: false,
      }))

    case 'workspace':
      return patch(deck, action.id, (tab) => ({
        title: action.label,
        dirty: action.dirty,
        detail: tab.exitCode === null ? action.branch : tab.detail,
      }))

    case 'relaunch':
      // Back to the start screen with the tab's identity intact, so a session
      // that failed to start is recoverable without opening a new tab.
      return patch(deck, action.id, () => ({
        content: { type: 'launcher' },
        title: 'New session',
        detail: '',
        dirty: false,
        exitCode: null,
        attention: false,
        historyOpen: false,
        reviewOpen: false,
      }))

    case 'attention':
      return patch(deck, action.id, () => ({ attention: true }))

    case 'toggleHistory':
      return patch(deck, action.id, (tab) => ({
        historyOpen: !tab.historyOpen,
      }))

    // Set rather than toggled, for a click on something that says "show me
    // these": a chip counting commits must not close the drawer listing them.
    case 'setHistory':
      return patch(deck, action.id, () => ({ historyOpen: action.open }))

    case 'toggleReview':
      return patch(deck, action.id, (tab) => ({
        reviewOpen: !tab.reviewOpen,
      }))

    // Set rather than toggled, because a click on a changed path in the output
    // must open the panel whether or not it was already open.
    case 'setReview':
      return patch(deck, action.id, () => ({ reviewOpen: action.open }))

    /**
     * A control that names a view: the directory shows the tree, the change
     * counts show the changes.
     *
     * Naming the view already on screen closes the drawer, because the control
     * has nothing left to say the second time — but naming the other one
     * switches rather than closing, which is the difference between this and a
     * toggle.
     */
    case 'showReview':
      return patch(deck, action.id, (tab) => ({
        reviewOpen: !(tab.reviewOpen && tab.reviewView === action.view),
        reviewView: action.view,
      }))

    // The drawer's own tabs switch and nothing else: you are already looking
    // at the drawer, so clicking the view you are on cannot mean "close".
    case 'setReviewView':
      return patch(deck, action.id, () => ({ reviewView: action.view }))

    // Set rather than toggled: the shortcut always opens and Escape always
    // closes, so neither can leave the bar in the state the user did not ask
    // for. Opening an already-open bar is a no-op — it does not refocus the
    // input, because the bar is never remounted.
    case 'setFind':
      return patch(deck, action.id, () => ({ findOpen: action.open }))

    case 'exited':
      return patch(deck, action.id, () => ({
        exitCode: action.code,
        detail: action.code === 0 ? 'exited' : `exited ${action.code}`,
      }))
  }
}

/** One settings tab is enough: a second request focuses the one already open. */
function openSettings(deck: Deck, id: string): Deck {
  const existing = deck.tabs.find((tab) => tab.content.type === 'settings')
  if (existing) return { ...deck, activeId: existing.id }
  return {
    tabs: [...deck.tabs, newTab(id, { type: 'settings' })],
    activeId: id,
  }
}

/**
 * Closing focuses the tab that slid into its place, like Chrome. The last tab
 * is replaced by a fresh one rather than leaving an empty window.
 */
function closeTab(deck: Deck, id: string, replacementId: string): Deck {
  const index = deck.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return deck

  const tabs = deck.tabs.filter((tab) => tab.id !== id)
  if (tabs.length === 0) return initialDeck(replacementId)
  const activeId =
    deck.activeId === id
      ? tabs[Math.min(index, tabs.length - 1)].id
      : deck.activeId
  return { tabs, activeId }
}

const clearAttention = (deck: Deck, id: string): Deck =>
  patch(deck, id, () => ({ attention: false }))

function patch(
  deck: Deck,
  id: string,
  change: (tab: Tab) => Partial<Tab>,
): Deck {
  const index = deck.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return deck

  const tab = deck.tabs[index]!
  const fields = change(tab)
  // Identity is what tells React and the persistence layer that something
  // happened, so a change that changes nothing must not produce a new deck:
  // the git poll dispatches per tab per interval whether or not the tree moved.
  const moved = Object.entries(fields).some(
    ([key, value]) => tab[key as keyof Tab] !== value,
  )
  if (!moved) return deck

  const tabs = [...deck.tabs]
  tabs[index] = { ...tab, ...fields }
  return { ...deck, tabs }
}
