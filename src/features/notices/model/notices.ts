/**
 * Notices: one card's worth of news about a tab, for the stack in the corner
 * of the tab with the keyboard. Pure, so which notice survives which — the
 * part a live stack gets wrong silently — is testable without a pane.
 */
import {
  type Deck,
  type Tab,
  tabSession,
} from '../../../entities/tab/model/deck'
import { runningAgent } from '../../../entities/agent/model/agents'
import type { Commit, GitStatus } from '../../../shared/ipc'

export type NoticeEvent =
  | { kind: 'asking' }
  /** `code` is the exit status, or `null` for a turn that failed. */
  | { kind: 'stopped'; code: number | null; said?: string }
  | { kind: 'finished'; said?: string }
  /** `block` names the command among the terminal's own, to scroll to. */
  | {
      kind: 'command'
      command: string
      code: number | null
      ms: number
      block: number
    }
  /**
   * `tree` is the working tree's root, which every tab in it reports alike;
   * `head` is the commit.
   */
  | {
      kind: 'committed'
      tree: string
      head: string
      branch: string
      subject: string
    }
  /** `head` is the commit the conflict stopped at. */
  | { kind: 'conflict'; tree: string; head: string; count: number }
  | { kind: 'gitFailed'; text: string }
  /** `tabIds` holds every tab changing `path`, `tabId` among them. */
  | { kind: 'collision'; path: string; tabIds: string[] }

type NoticeKind = NoticeEvent['kind']

export type Notice = NoticeEvent & {
  /** Increasing, so newer sorts first. */
  id: number
  /** The tab the news is about, and the one a click goes to. */
  tabId: string
}

/** A notice with what its card names the tab by. */
export interface NoticeCard {
  notice: Notice
  title: string
  agent: string
  accent: string
  /** For an overlap, the other tabs changing its file, by title. */
  others: string[]
}

/** The commands worth a card: anything quicker was likely watched to its end. */
export const LONG_COMMAND_MS = 10_000

/**
 * Notices that fade, kept at most; more would be a backlog nobody reads. A
 * sticky one is never dropped for room, since what it reports is still true.
 */
const MAX_FADING = 20

/**
 * Notices that wait for you rather than fading: an agent blocked on you, one
 * that stopped, a write that failed, an overlap still under way.
 */
const STICKY: ReadonlySet<NoticeKind> = new Set([
  'asking',
  'stopped',
  'gitFailed',
  'collision',
])

/**
 * Notices shown even while their tab is on screen. A git write failing is
 * read in a drawer that may have closed since, and an overlap is news about
 * the *other* tab, which the one on screen cannot show.
 */
const FOLLOWS_YOU: ReadonlySet<NoticeKind> = new Set(['gitFailed', 'collision'])

export const isSticky = (notice: Notice) => STICKY.has(notice.kind)

/**
 * Whether news earns a card: news about a tab on screen, in a focused
 * window, is already in front of the reader, unless it follows you.
 */
export const worthRaising = (event: NoticeEvent, watching: boolean) =>
  !watching || FOLLOWS_YOU.has(event.kind)

/**
 * What names news about a working tree, which every tab in that tree reports
 * alike — the kind, the tree and the commit — or `null` for news about one tab.
 */
export function treeNews(event: NoticeEvent) {
  return event.kind === 'committed' || event.kind === 'conflict'
    ? `${event.kind}:${event.tree}:${event.head}`
    : null
}

/**
 * The slot a notice fills: a tab has one card of each kind, the latest
 * replacing the last. An overlap is one card per file and set of tabs, a
 * commit one card per commit and a conflict one per tree, however many tabs
 * report it.
 */
function slotOf(notice: Notice) {
  switch (notice.kind) {
    case 'collision':
      return `collision:${notice.path}:${notice.tabIds.join(',')}`
    case 'committed':
      return `committed:${notice.tree}:${notice.head}`
    case 'conflict':
      return `conflict:${notice.tree}`
    default:
      return `${notice.tabId}:${notice.kind}`
  }
}

/**
 * `notice` added, in place of whatever it supersedes: what filled its slot;
 * for a failed turn, its tab's "finished", since an agent that both rings and
 * broadcasts announces one turn twice and the failure is the one that is true;
 * for a finished turn, its tab's failed one, which the agent has recovered
 * from; for an overlap, any on the same file sharing a tab, which is the same
 * overlap reaching further. An exit keeps the words of the failed turn it
 * replaces, which are usually why it exited.
 */
export function addNotice(notices: Notice[], notice: Notice): Notice[] {
  const key = slotOf(notice)
  const supersedes = (entry: Notice) =>
    slotOf(entry) === key ||
    (notice.kind === 'stopped' &&
      notice.code === null &&
      entry.kind === 'finished' &&
      entry.tabId === notice.tabId) ||
    (notice.kind === 'finished' &&
      entry.kind === 'stopped' &&
      entry.code === null &&
      entry.tabId === notice.tabId) ||
    (notice.kind === 'collision' &&
      entry.kind === 'collision' &&
      entry.path === notice.path &&
      entry.tabIds.some((id) => notice.tabIds.includes(id)))
  const failedTurn = notices.find(
    (entry) => entry.kind === 'stopped' && slotOf(entry) === key,
  )
  const added =
    notice.kind === 'stopped' &&
    notice.code !== null &&
    failedTurn?.kind === 'stopped' &&
    failedTurn.code === null
      ? { ...notice, said: notice.said ?? failedTurn.said }
      : notice
  let fading = 0
  return [added, ...notices.filter((entry) => !supersedes(entry))].filter(
    (entry) => isSticky(entry) || (fading += 1) <= MAX_FADING,
  )
}

/** Drops what is now on screen, since the reader has seen it, except what follows you. */
export const dropSeen = (notices: Notice[], shown: readonly string[]) =>
  notices.filter(
    (notice) => FOLLOWS_YOU.has(notice.kind) || !shown.includes(notice.tabId),
  )

type Branch = Pick<
  GitStatus,
  'head' | 'branch' | 'detached' | 'ahead' | 'upstream'
>

/** `HEAD` moved on the branch it was on: a commit, or a pull or a reset. */
export const headMoved = (was: Branch, now: Branch) =>
  was.head !== '' &&
  now.head !== was.head &&
  !now.detached &&
  now.branch === was.branch

/**
 * Room for clock skew between this machine and whoever wrote the commit; it
 * also admits a commit pulled within that window.
 */
const CLOCK_SLACK_SECONDS = 60

/**
 * The commit `HEAD` moved to, when it looks made here: the old `HEAD` is
 * behind it, which after a reset it is not; and its author date is no older
 * than the poll that saw the old `HEAD`, or the branch is further ahead of
 * its upstream. Measured from that poll rather than from now, so a window left
 * asleep still announces what was committed meanwhile. A pulled commit is
 * usually neither; an amend or a cherry-pick keeps its author date and is
 * missed. `log` is newest first, and a merge lists its other side by date, so
 * the old `HEAD` need not be second.
 */
export function landedCommit({
  was,
  now,
  log,
  since,
}: {
  was: Branch
  now: Branch
  log: Commit[]
  /** When the old `HEAD` was read, in seconds since the epoch, as git writes commit times. */
  since: number
}): Commit | null {
  // `HEAD` may have moved again while the log was read, so find it by sha.
  const at = log.findIndex((entry) => entry.sha === now.head)
  const commit = log[at]
  const behind = log.slice(at + 1)
  if (!commit || !behind.some((entry) => entry.sha === was.head)) return null
  const fresh = commit.at !== null && commit.at >= since - CLOCK_SLACK_SECONDS
  const ahead = now.upstream !== null && now.ahead > was.ahead
  return fresh || ahead ? commit : null
}

/**
 * Whether a notice reports something that went wrong: a turn that failed, an
 * agent or command that exited non-zero, a conflict, a refused git write.
 */
export function isFailure(notice: Notice) {
  switch (notice.kind) {
    case 'stopped':
      return notice.code !== 0
    case 'command':
      return notice.code !== null && notice.code !== 0
    case 'conflict':
    case 'gitFailed':
      return true
    default:
      return false
  }
}

/** How an overlap under way is named: by tab and file, since a path is per repo. */
export const overlapKey = (tabId: string, path: string) => `${tabId}\n${path}`

/**
 * The cards to draw, needs-you first and newest first within each, and the
 * notices whose state has gone — a question answered, an overlap down to one
 * tab, a tab closed — for the caller to drop, so none comes back when its
 * state looks the same again.
 */
export function noticeCards(
  notices: Notice[],
  { deck, overlaps }: { deck: Deck; overlaps: ReadonlySet<string> },
): { cards: NoticeCard[]; stale: number[] } {
  const byId = new Map(deck.tabs.map((tab) => [tab.id, tab]))
  const cards: NoticeCard[] = []
  const stale: number[] = []
  for (const notice of notices) {
    const card =
      notice.kind === 'collision'
        ? overlapCard(notice, { byId, overlaps, active: deck.activeId })
        : plainCard(notice, byId)
    if (card) cards.push(card)
    else stale.push(notice.id)
  }
  cards.sort(
    (a, b) =>
      urgency(b.notice) - urgency(a.notice) || b.notice.id - a.notice.id,
  )
  return { cards, stale }
}

/** A question first, since an agent waits on it; then what waits for you (`isSticky`). */
const urgency = (notice: Notice) =>
  notice.kind === 'asking' ? 2 : Number(isSticky(notice))

/**
 * A card for any notice but an overlap, while its tab is open and — for a
 * question — still asking. Every other kind stands until superseded
 * (`addNotice`), seen or dismissed.
 */
function plainCard(notice: Notice, byId: Map<string, Tab>): NoticeCard | null {
  const tab = byId.get(notice.tabId)
  if (!tab || (notice.kind === 'asking' && tab.status !== 'asking')) return null
  return { notice, ...nameOf(tab), others: [] }
}

/**
 * An overlap's card, named after the tabs still in it when it is drawn: the
 * tab it was raised on may have closed or moved on while two others carry on,
 * and a click must go to a tab that is still changing the file.
 */
function overlapCard(
  notice: Notice & { kind: 'collision' },
  {
    byId,
    overlaps,
    active,
  }: { byId: Map<string, Tab>; overlaps: ReadonlySet<string>; active: string },
): NoticeCard | null {
  const still = notice.tabIds.flatMap((id) => {
    const tab = byId.get(id)
    return tab && overlaps.has(overlapKey(id, notice.path)) ? [tab] : []
  })
  if (still.length < 2) return null
  // The news is about the other tab, so never the one you are on.
  const elsewhere = still.filter((tab) => tab.id !== active)
  const named =
    elsewhere.find((tab) => tab.id === notice.tabId) ?? elsewhere[0] ?? still[0]
  return {
    notice: { ...notice, tabId: named.id },
    ...nameOf(named),
    others: still.filter((tab) => tab !== named).map((tab) => tab.title),
  }
}

function nameOf(tab: Tab) {
  const session = tabSession(tab)
  const running = session && runningAgent(session.agentId, tab.handedBack)
  return {
    title: tab.title,
    agent: running?.name ?? session?.agentName ?? '',
    accent: running?.accent ?? session?.accent ?? '',
  }
}
