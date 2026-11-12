import { type RefObject, useCallback, useRef, useState } from 'react'

import type { Deck, DeckAction } from '../entities/tab/model/deck'
import type { Settings } from '../entities/preferences/model/settings'
import {
  type Collision,
  newCollisions,
} from '../features/fleet/model/collisions'
import {
  addNotice,
  dropSeen,
  firstReport,
  type Notice,
  type NoticeEvent,
  noticeCards,
  overlapKey,
  treeNews,
  type TreeReport,
  worthRaising,
} from '../features/notices/model/notices'
import { useKeyChange } from '../shared/lib/useKeyChange'

/**
 * The window's one list of notices, and the glue between it and the collision
 * detector — which lives here because neither feature may import the other.
 */
export function useNotices({
  deck,
  settings,
  current,
  dispatch,
}: {
  deck: Deck
  settings: Settings
  /** The same two, as of the last commit, for a raise arriving between renders. */
  current: RefObject<{ deck: Deck; settings: Settings }>
  dispatch: (action: DeckAction) => void
}) {
  const [notices, setNotices] = useState<Notice[]>([])
  const ids = useRef(0)
  /**
   * News about a tree already reported, by whom and when, so another tab in that tree
   * reporting it on its next poll raises nothing: not what the reader watched
   * happen, nor a card already raised and since seen or faded.
   */
  const treeReported = useRef(new Map<string, TreeReport>())

  /**
   * Raises news about a tab: dropped when the reader is already looking
   * (`worthRaising`), and news about a tree raised once for all its tabs.
   */
  const raise = useCallback(
    (tabId: string, event: NoticeEvent) => {
      const { deck: now, settings: prefs } = current.current
      // A closed tab's process ends after the tab has gone, and says so.
      if (!prefs.tabNotices || !now.tabs.some((tab) => tab.id === tabId)) return
      const watching = now.shown.includes(tabId) && document.hasFocus()
      const tree = treeNews(event)
      if (tree) {
        const fresh = firstReport(treeReported.current, {
          key: tree,
          tabId,
          at: Date.now(),
        })
        if (watching) {
          setNotices((list) => list.filter((entry) => treeNews(entry) !== tree))
          return
        }
        if (!fresh) return
      }
      if (worthRaising(event, watching)) {
        const id = (ids.current += 1)
        setNotices((list) => addNotice(list, { ...event, id, tabId }))
      }
    },
    [current],
  )

  const dismissNotice = (notice: Notice) =>
    setNotices((list) => list.filter((entry) => entry.id !== notice.id))
  // Switched off, the list goes too: news held back from a reader who asked
  // for none would arrive stale the moment the cards came back.
  useKeyChange([settings.tabNotices], () => {
    if (!settings.tabNotices) setNotices([])
  })
  // A tab coming on screen has been seen, and so has its news.
  useKeyChange([deck.shown.join('\n')], () =>
    setNotices((list) => dropSeen(list, deck.shown)),
  )
  const markNoticesSeen = useCallback(
    () => setNotices((list) => dropSeen(list, current.current.deck.shown)),
    [current],
  )

  /**
   * The overlaps under way, for dropping a card whose overlap has ended; and
   * the last comparison, which is what makes the next one's overlaps new.
   * The first comparison of a window, or after it had too few tabs to make
   * one, is not news: it is what was already there.
   */
  const [overlaps, setOverlaps] = useState<ReadonlySet<string>>(new Set())
  const lastCollisions = useRef<Map<string, Collision[]> | null>(null)
  const onCollisions = useCallback(
    (index: Map<string, Collision[]>, compared: boolean) => {
      const was = compared ? lastCollisions.current : null
      lastCollisions.current = compared ? index : null
      const next = new Set(
        [...index].flatMap(([tabId, found]) =>
          found.map((entry) => overlapKey(tabId, entry.path)),
        ),
      )
      setOverlaps((prev) =>
        prev.size === next.size && [...prev].every((key) => next.has(key))
          ? prev
          : next,
      )
      if (!was) return
      const active = current.current.deck.activeId
      for (const { path, tabIds } of newCollisions(was, index)) {
        const tabId = tabIds.find((id) => id !== active) ?? tabIds[0]
        raise(tabId, { kind: 'collision', path, tabIds })
      }
    },
    [raise, current],
  )

  /** A command a card asked its tab to scroll to. */
  const [reveal, setReveal] = useState<{
    tabId: string
    block: number
  } | null>(null)

  /** Goes to what a card is about, and opens the drawer that shows it. */
  const openNotice = (notice: Notice) => {
    dismissNotice(notice)
    const id = notice.tabId
    dispatch({ type: 'activate', id })
    switch (notice.kind) {
      case 'command':
        setReveal({ tabId: id, block: notice.block })
        return
      case 'committed':
      case 'gitFailed':
        dispatch({ type: 'setHistory', id, open: true })
        return
      case 'conflict':
      case 'collision':
        dispatch({ type: 'setReviewView', id, view: 'changes' })
        dispatch({ type: 'setReview', id, open: true })
        return
    }
  }

  const { cards, stale } = noticeCards(notices, { deck, overlaps })
  useKeyChange([stale.join()], () =>
    setNotices((list) => list.filter((entry) => !stale.includes(entry.id))),
  )
  // Done with once used: a terminal mounted later in that tab must not take
  // an old block key, which names another command in its own session.
  const clearReveal = useCallback(() => setReveal(null), [])
  return {
    cards,
    raise,
    openNotice,
    dismissNotice,
    markNoticesSeen,
    onCollisions,
    reveal,
    clearReveal,
  }
}
