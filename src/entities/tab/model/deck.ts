import type { Backend } from '../../../shared/lib/platform'
import type { TFunction } from 'i18next'

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
  /**
   * Whether this session was started in scrollback mode — held out of the
   * alternate buffer, so the rail, the path strip and the find bar have
   * history to read, and the agent reports no mouse. Per session because the
   * environment that decides it is read once, at spawn: flipping it reopens
   * the conversation.
   */
  scrollback: boolean
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
export type ReviewView = 'changes' | 'files' | 'activity'

export interface Tab {
  id: string
  title: string
  /** The git branch; `tabDetail` reads the exit status in its place. */
  detail: string
  dirty: boolean
  /** Exit code once the process ended, `null` while it runs or before launch. */
  exitCode: number | null
  /** Whether this tab's git history drawer is open. */
  historyOpen: boolean
  /** Whether this tab's review panel is open. */
  reviewOpen: boolean
  /** Whether this tab's earlier-sessions drawer is open. */
  journalOpen: boolean
  reviewView: ReviewView
  /** Whether this tab's scrollback search bar is open. */
  findOpen: boolean
  /** The session signalled it is done while the user was looking elsewhere. */
  attention: boolean
  /** What the agent is doing, as it last announced it. */
  status: AgentStatus
  /**
   * The session's agent has exited and its terminal runs the user's shell —
   * `platform::hands_back`. The session is the agent's still, so this is what
   * tells the tab to stop offering the agent's controls.
   */
  handedBack: boolean
  /** Which column of the window the tab sits in, counted from the left. */
  column: number
  content: TabContent
}

export const tabSession = (tab: Tab): Session | null =>
  tab.content.type === 'session' ? tab.content.session : null

export interface Deck {
  tabs: Tab[]
  /** The tab with the keyboard, which is the one its column shows. */
  activeId: string
  /**
   * The tab each column shows, left to right — so its length is the number
   * of columns. Every column holds at least one tab: one left empty closes.
   */
  shown: string[]
  /**
   * Each column's share of the window, by the same index as `shown`, summing
   * to 1. Absent while the columns are equal: set once one is resized, and
   * cleared by a reset. Read it through `columnWidths`, which answers equal
   * shares when it is absent.
   */
  widths?: number[]
}

export type DeckAction =
  /** Into `column`, or else the focused one. */
  | { type: 'open'; id: string; start?: LauncherStart; column?: number }
  | { type: 'openSettings'; id: string }
  | { type: 'close'; id: string; replacementId: string }
  | { type: 'activate'; id: string }
  /** The window regained focus, so the user is looking at the active tab. */
  | { type: 'seen' }
  | { type: 'move'; id: string; index: number }
  /** `index` counts within `column`, which defaults to the focused one. */
  | { type: 'adopt'; tab: Tab; column?: number; index?: number }
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
  | { type: 'toggleJournal'; id: string }
  | { type: 'toggleReview'; id: string }
  | { type: 'setHistory'; id: string; open: boolean }
  | { type: 'setReview'; id: string; open: boolean }
  | { type: 'showReview'; id: string; view: ReviewView }
  | { type: 'setReviewView'; id: string; view: ReviewView }
  | { type: 'setFind'; id: string; open: boolean }
  | { type: 'attention'; id: string }
  | { type: 'status'; id: string; status: AgentStatus }
  | { type: 'relaunch'; id: string }
  | { type: 'exited'; id: string; code: number }
  | { type: 'handedBack'; id: string }
  /**
   * Puts a tab in another column, at `index` of it or at its end. With
   * `split`, a new column is opened at `column` for it and those from there
   * on move one to the right. Once the columns have been resized, it takes
   * half the width of column `of` — numbered as before the split, and the
   * column on its left when not given — so the others keep theirs.
   */
  | {
      type: 'moveToColumn'
      id: string
      column: number
      index?: number
      split?: boolean
      of?: number
    }
  /** New widths for the columns, in any unit, or `undefined` for equal ones. */
  | { type: 'resize'; widths?: number[] }
  /**
   * Splits `column`, or else the focused one: the tab it shows moves to a new
   * column on its right, or — when it is the column's only tab — a new start
   * screen, `id`, opens there in the same directory.
   */
  | { type: 'split'; id: string; column?: number }

/**
 * What the agent in a tab is doing, from the events it broadcasts.
 *
 * `unknown` is the honest default and the common one: only an agent that
 * announces itself moves off it, so a plain shell and any CLI that says
 * nothing stay there rather than claiming to be idle.
 */
export type AgentStatus = 'unknown' | 'working' | 'waiting'

/**
 * What a tab's dot says, most urgent first.
 *
 * `unread` is a session signal — a finished turn, a handback, an exit — that
 * arrived while the user was looking elsewhere and nobody has seen yet. A new
 * turn outranks it, since the dot then has something live to report.
 */
export type TabSignal = 'working' | 'unread' | 'waiting' | null

export function tabSignal(tab: Tab): TabSignal {
  if (tab.status === 'working') return 'working'
  if (tab.attention) return 'unread'
  if (tab.status === 'waiting') return 'waiting'
  return null
}

export const newTab = (
  id: string,
  content: TabContent = { type: 'launcher' },
  column = 0,
): Tab => ({
  id,
  title: tabTitle(content),
  detail: '',
  dirty: false,
  exitCode: null,
  historyOpen: false,
  reviewOpen: false,
  journalOpen: false,
  reviewView: 'changes',
  findOpen: false,
  attention: false,
  status: 'unknown',
  handedBack: false,
  column,
  content,
})

/**
 * What a tab would be pre-filled with: its session's launch details, or
 * whatever it was last pre-filled with, or nothing.
 *
 * Used both to persist a tab across a restart and to send one back to its own
 * start screen, which are the same question asked at two moments.
 */
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

/**
 * What the tab strip says before a session starts, or `''` where the label is
 * a word in the interface's language, which `tabLabel` supplies at render.
 *
 * A restored tab is named after its directory: several restored tabs all
 * reading "New session" is the state the tab strip is least able to help with.
 */
function tabTitle(content: TabContent): string {
  if (content.type === 'launcher' && content.start?.cwd) {
    return basename(content.start.cwd)
  }
  return ''
}

/**
 * A tab's name as the strip shows it. Stored titles are directory and session
 * names only, so a language switch relabels every untitled tab in place.
 */
export function tabLabel(tab: Tab, t: TFunction<'chrome'>): string {
  if (tab.title) return tab.title
  return tab.content.type === 'settings'
    ? t('tab.settings')
    : t('tab.newSession')
}

/** A tab's secondary line: its exit status once ended, else its branch. */
export const tabDetail = (tab: Tab, t: TFunction<'chrome'>) =>
  tab.exitCode === null
    ? tab.detail
    : t('tab.exited', {
        code: tab.exitCode,
        context: tab.exitCode === 0 ? undefined : 'failed',
      })

const basename = (path: string) =>
  path.split(/[/\\]/).filter(Boolean).pop() ?? path

export const initialDeck = (id: string): Deck => ({
  tabs: [newTab(id)],
  activeId: id,
  shown: [id],
})

/** The tabs of one column, in the order its strip shows them. */
export const columnTabs = (deck: Deck, column: number) =>
  deck.tabs.filter((tab) => tab.column === column)

/** The column the keyboard is in. */
export const focusedColumn = (deck: Deck) =>
  deck.tabs.find((tab) => tab.id === deck.activeId)?.column ?? 0

export function deckReducer(deck: Deck, action: DeckAction): Deck {
  switch (action.type) {
    case 'open':
      return show(
        {
          ...deck,
          tabs: [
            ...deck.tabs,
            newTab(
              action.id,
              { type: 'launcher', start: action.start },
              action.column ?? focusedColumn(deck),
            ),
          ],
        },
        action.id,
      )

    case 'openSettings':
      return openSettings(deck, action.id)

    case 'close':
      return closeTab(deck, action.id, action.replacementId)

    case 'activate':
      if (!deck.tabs.some((tab) => tab.id === action.id)) return deck
      // Looking at a tab is how its notice gets acknowledged.
      return show(clearAttention(deck, action.id), action.id)

    // Every column's shown tab is in view, so all of them are read. Reads the
    // deck's own `shown`: the dispatcher's view can lag a tab that is arriving.
    case 'seen':
      return deck.shown.reduce(clearAttention, deck)

    case 'move':
      return moveTab(deck, action.id, action.index)

    // A tab moved here from another window, which comes forward as it would
    // in the window it left.
    case 'adopt':
      return adoptTab(deck, action)

    case 'moveToColumn':
      return moveToColumn(deck, action)

    // Widths for another number of columns describe a layout that is gone,
    // so they change nothing rather than resetting the ones there are.
    case 'resize': {
      if (!action.widths)
        return deck.widths ? { ...deck, widths: undefined } : deck
      const widths =
        action.widths.length === deck.shown.length
          ? normalized(action.widths)
          : undefined
      return widths ? { ...deck, widths } : deck
    }

    case 'split':
      return split(deck, action.id, action.column ?? focusedColumn(deck))

    // The digits count within the focused column, as its strip numbers them.
    case 'activateIndex': {
      const tabs = columnTabs(deck, focusedColumn(deck))
      const tab = action.index === -1 ? tabs.at(-1) : tabs[action.index]
      return tab ? show(clearAttention(deck, tab.id), tab.id) : deck
    }

    // Walks the columns left to right, so stepping past a column's last tab
    // reaches the next column: every tab stays a keystroke away.
    case 'cycle': {
      const order = deck.shown.flatMap((_, column) => columnTabs(deck, column))
      const index = order.findIndex((tab) => tab.id === deck.activeId)
      if (index < 0) return deck
      const next = order[(index + action.step + order.length) % order.length]
      return show(clearAttention(deck, next.id), next.id)
    }

    case 'start':
      return patch(deck, action.id, () => ({
        content: { type: 'session', session: action.session },
        title: action.title,
        exitCode: null,
        handedBack: false,
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
      // that failed to start is recoverable without opening a new tab — and
      // pre-filled from the session that just ended, which is also what keeps
      // its own recording reachable: a launcher with no directory has nowhere
      // to look for one.
      return patch(deck, action.id, (tab) => ({
        content: {
          type: 'launcher',
          start: startOf(tab) ?? undefined,
        },
        title: '',
        detail: '',
        dirty: false,
        exitCode: null,
        attention: false,
        status: 'unknown',
        handedBack: false,
        historyOpen: false,
        reviewOpen: false,
        journalOpen: false,
      }))

    case 'attention':
      return patch(deck, action.id, () => ({ attention: true }))

    case 'status':
      return patch(deck, action.id, () => ({ status: action.status }))

    case 'toggleHistory':
      return patch(deck, action.id, (tab) => ({
        historyOpen: !tab.historyOpen,
      }))

    // Set rather than toggled, for a click on something that says "show me
    // these": a chip counting commits must not close the drawer listing them.
    case 'setHistory':
      return patch(deck, action.id, () => ({ historyOpen: action.open }))

    case 'toggleJournal':
      return patch(deck, action.id, (tab) => ({
        journalOpen: !tab.journalOpen,
      }))

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
      }))

    case 'handedBack':
      // A shell has no announced turns, so the agent's last status would
      // otherwise stay on the tab for the rest of its life.
      return patch(deck, action.id, () => ({
        handedBack: true,
        status: 'unknown',
      }))
  }
}

/** One settings tab is enough: a second request focuses the one already open. */
function openSettings(deck: Deck, id: string): Deck {
  const existing = deck.tabs.find((tab) => tab.content.type === 'settings')
  if (existing) return show(deck, existing.id)
  const tab = newTab(id, { type: 'settings' }, focusedColumn(deck))
  return show({ ...deck, tabs: [...deck.tabs, tab] }, id)
}

/** Makes `id` the tab its column shows, and gives it the keyboard. */
function show(deck: Deck, id: string): Deck {
  const tab = deck.tabs.find((entry) => entry.id === id)
  if (!tab) return deck
  const shown =
    deck.shown[tab.column] === id
      ? deck.shown
      : replaced(deck.shown, tab.column, id)
  return deck.activeId === id && shown === deck.shown
    ? deck
    : { ...deck, shown, activeId: id }
}

/**
 * Closing shows the tab that slid into its place in the same column, like
 * Chrome. A column left empty closes, and a last tab is replaced by a fresh
 * one, since a deck is never empty.
 */
function closeTab(deck: Deck, id: string, replacementId: string): Deck {
  const tab = deck.tabs.find((entry) => entry.id === id)
  if (!tab) return deck
  if (deck.tabs.length === 1) return initialDeck(replacementId)

  const shown = replaced(deck.shown, tab.column, neighbourOf(deck, tab))
  return settle(
    {
      tabs: deck.tabs.filter((entry) => entry !== tab),
      activeId: deck.activeId,
      shown,
      widths: deck.widths,
    },
    tab.column,
  )
}

/**
 * What a column should show once `tab` leaves it: the tab it was already
 * showing, or else the one that slides into the leaving tab's place.
 */
function neighbourOf(deck: Deck, tab: Tab): string {
  const shown = deck.shown[tab.column]
  if (shown !== tab.id) return shown
  const siblings = columnTabs(deck, tab.column)
  const rest = siblings.filter((entry) => entry !== tab)
  const at = Math.min(siblings.indexOf(tab), rest.length - 1)
  return rest[at]?.id ?? tab.id
}

/**
 * Takes in a tab from another window, into `column` at `index` or else into
 * the focused column's end. It comes forward, so it arrives read.
 */
function adoptTab(
  deck: Deck,
  { tab, column, index }: { tab: Tab; column?: number; index?: number },
): Deck {
  if (deck.tabs.some((held) => held.id === tab.id)) return deck
  const target = Math.min(column ?? focusedColumn(deck), deck.shown.length - 1)
  const arrived = { ...tab, attention: false, column: target }
  return place({ ...deck, tabs: [...deck.tabs, arrived] }, tab.id, index)
}

/**
 * Puts a tab at `index` of its column's strip, clamped to its ends. Only the
 * column's own slots in `tabs` are rewritten, so every other column keeps its
 * order.
 */
function moveTab(deck: Deck, id: string, index: number): Deck {
  const tab = deck.tabs.find((entry) => entry.id === id)
  if (!tab) return deck
  const siblings = columnTabs(deck, tab.column)
  const from = siblings.indexOf(tab)
  const to = Math.max(0, Math.min(index, siblings.length - 1))
  if (from === to) return deck

  siblings.splice(from, 1)
  siblings.splice(to, 0, tab)
  let next = 0
  const tabs = deck.tabs.map((entry) =>
    entry.column === tab.column ? siblings[next++] : entry,
  )
  return { ...deck, tabs }
}

/** Shows tab `id` at `index` of its column, or where it already is. */
function place(deck: Deck, id: string, index?: number): Deck {
  const shown = show(deck, id)
  return index === undefined ? shown : moveTab(shown, id, index)
}

function moveToColumn(
  deck: Deck,
  {
    id,
    column,
    index,
    split = false,
    of = column - 1,
  }: {
    id: string
    column: number
    index?: number
    split?: boolean
    of?: number
  },
): Deck {
  const tab = deck.tabs.find((entry) => entry.id === id)
  if (!tab) return deck
  const count = deck.shown.length
  const target = Math.max(0, Math.min(column, split ? count : count - 1))
  if (!split && target === tab.column) return place(deck, id, index)

  // The column it leaves shows a neighbour, worked out before any renumbering.
  const left = replaced(deck.shown, tab.column, neighbourOf(deck, tab))
  const shown = split
    ? [...left.slice(0, target), id, ...left.slice(target)]
    : replaced(left, target, id)
  const shifted = deck.tabs
    .filter((entry) => entry !== tab)
    .map((entry) =>
      split && entry.column >= target
        ? { ...entry, column: entry.column + 1 }
        : entry,
    )
  const tabs = [...shifted, { ...tab, column: target }]
  // Columns nobody has resized stay equal, as they were before the split.
  const widths =
    split && deck.widths
      ? splitWidths(columnWidths(deck), target, of)
      : deck.widths
  return place(settle({ tabs, activeId: id, shown, widths }, target), id, index)
}

/**
 * The shares once a column opens at `at`, taking half of column `of`, which
 * is clamped to the columns there are.
 */
function splitWidths(widths: number[], at: number, of: number): number[] {
  const halved = Math.max(0, Math.min(of, widths.length - 1))
  const half = widths[halved] / 2
  const rest = replaced(widths, halved, half)
  return [...rest.slice(0, at), half, ...rest.slice(at)]
}

function split(deck: Deck, id: string, column: number): Deck {
  const showing = deck.tabs.find((tab) => tab.id === deck.shown[column])
  if (!showing) return deck
  const target = showing.column + 1
  if (columnTabs(deck, showing.column).length > 1) {
    return moveToColumn(deck, { id: showing.id, column: target, split: true })
  }
  // A terminal cannot be in two places, so a lone tab is not duplicated: the
  // new column starts where it is working.
  const start = startOf(showing) ?? undefined
  const fresh = newTab(id, { type: 'launcher', start }, showing.column)
  return moveToColumn(
    { ...deck, tabs: [...deck.tabs, fresh] },
    { id, column: target, split: true },
  )
}

/**
 * A deck from tabs that already name their columns, as a restore reads them:
 * gaps in the numbering close, and each column shows the tab `shown` names
 * for it if it holds that tab, else its first — but the active one's column,
 * which shows the active tab.
 */
export function arrangeDeck(
  tabs: Tab[],
  {
    activeId,
    shown = [],
    widths,
  }: { activeId: string; shown?: string[]; widths?: number[] },
): Deck {
  const focus = tabs.find((tab) => tab.id === activeId)?.column ?? 0
  return show(settle({ tabs, activeId, shown, widths }, focus), activeId)
}

/** Each column's share of the window, equal until one is resized. */
export const columnWidths = (deck: Deck): number[] =>
  deck.widths?.length === deck.shown.length
    ? deck.widths
    : deck.shown.map(() => 1 / deck.shown.length)

/**
 * Repairs the columns after tabs left or joined them: empty columns close
 * and the rest renumber from 0, each shows a tab it holds, and the keyboard
 * stays where it was or falls to the column now at `focus`, the old number
 * of the column it was in — the last column, if that one was.
 */
function settle(deck: Deck, focus: number): Deck {
  const used = [...new Set(deck.tabs.map((tab) => tab.column))].sort(
    (a, b) => a - b,
  )
  const renumbered = new Map(used.map((column, index) => [column, index]))
  const tabs = deck.tabs.map((tab) => {
    const column = renumbered.get(tab.column) ?? 0
    return column === tab.column ? tab : { ...tab, column }
  })
  const shown = used.map((old, column) => {
    const kept = deck.shown[old]
    return tabs.some((tab) => tab.id === kept && tab.column === column)
      ? kept
      : tabs.find((tab) => tab.column === column)!.id
  })
  const nearest = Math.min(
    used.filter((column) => column < focus).length,
    shown.length - 1,
  )
  const activeId = shown.includes(deck.activeId)
    ? deck.activeId
    : shown[nearest]
  const widths = keptWidths(deck.widths, used)
  return widths ? { tabs, activeId, shown, widths } : { tabs, activeId, shown }
}

/**
 * The shares once only the columns numbered `used` remain. A closed column's
 * share goes to the column on its left — or its right, when it was the
 * first — so the columns nobody touched keep their size, as in VS Code.
 */
function keptWidths(
  widths: number[] | undefined,
  used: number[],
): number[] | undefined {
  if (!widths || !used.every((old) => widths[old] > 0)) return undefined
  const kept = used.map((old) => widths[old])
  widths.forEach((share, old) => {
    if (used.includes(old)) return
    const left = used.filter((column) => column < old).length - 1
    kept[Math.max(left, 0)] += share
  })
  return normalized(kept)
}

/** `shares` scaled to sum to 1, or `undefined` when they cannot be. */
function normalized(shares: number[]): number[] | undefined {
  if (!shares.every((share) => Number.isFinite(share) && share > 0))
    return undefined
  const total = shares.reduce((sum, share) => sum + share, 0)
  const scaled = shares.map((share) => share / total)
  // The grid divides by the narrowest, so a ratio that overflows, or a share
  // that underflowed to 0, would draw an `Infinityfr` column.
  const spread = Math.max(...scaled) / Math.min(...scaled)
  return Number.isFinite(spread) ? scaled : undefined
}

/** `list` with `value` at `index`. */
const replaced = <T>(list: T[], index: number, value: T) =>
  list.map((entry, at) => (at === index ? value : entry))

const clearAttention = (deck: Deck, id: string): Deck =>
  patch(deck, id, () => ({ attention: false }))

function patch(
  deck: Deck,
  id: string,
  change: (tab: Tab) => Partial<Tab>,
): Deck {
  const index = deck.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return deck

  const tab = deck.tabs[index]
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
