import { expect, test } from 'bun:test'

import {
  type Deck,
  deckReducer,
  initialDeck,
  type Session,
  tabSession,
} from './deck'

const session: Session = {
  agentId: 'claude',
  agentName: 'Claude Code',
  accent: '#d97757',
  program: 'claude',
  args: ['--continue'],
  cwd: '/work/repo',
  backend: 'native',
  distro: '',
}

/** A deck of n tabs, ids tab-1..tab-n, with the first active. */
function deckOf(count: number): Deck {
  let deck = initialDeck('tab-1')
  for (let index = 2; index <= count; index += 1) {
    deck = deckReducer(deck, { type: 'open', id: `tab-${index}` })
  }
  return deckReducer(deck, { type: 'activate', id: 'tab-1' })
}

test('starts with one launcher tab, active', () => {
  const deck = initialDeck('tab-1')
  expect(deck.tabs).toHaveLength(1)
  expect(deck.activeId).toBe('tab-1')
  expect(deck.tabs[0].content.type).toBe('launcher')
})

test('opening focuses the new tab', () => {
  const deck = deckReducer(initialDeck('tab-1'), { type: 'open', id: 'tab-2' })
  expect(deck.tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2'])
  expect(deck.activeId).toBe('tab-2')
})

test('closing the active tab focuses the one that takes its place', () => {
  const deck = deckReducer(deckOf(3), { type: 'activate', id: 'tab-2' })
  const closed = deckReducer(deck, {
    type: 'close',
    id: 'tab-2',
    replacementId: 'fresh',
  })
  expect(closed.tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-3'])
  expect(closed.activeId).toBe('tab-3')
})

test('closing the last tab in the strip falls back to its neighbour', () => {
  const deck = deckReducer(deckOf(2), { type: 'activate', id: 'tab-2' })
  expect(
    deckReducer(deck, { type: 'close', id: 'tab-2', replacementId: 'fresh' })
      .activeId,
  ).toBe('tab-1')
})

test('closing an inactive tab keeps the focus where it was', () => {
  const closed = deckReducer(deckOf(3), {
    type: 'close',
    id: 'tab-3',
    replacementId: 'fresh',
  })
  expect(closed.activeId).toBe('tab-1')
})

test('closing the only tab leaves a fresh launcher tab', () => {
  const closed = deckReducer(initialDeck('tab-1'), {
    type: 'close',
    id: 'tab-1',
    replacementId: 'fresh',
  })
  expect(closed.tabs.map((tab) => tab.id)).toEqual(['fresh'])
  expect(closed.activeId).toBe('fresh')
})

test('closing an unknown tab changes nothing', () => {
  const deck = deckOf(2)
  expect(
    deckReducer(deck, { type: 'close', id: 'ghost', replacementId: 'fresh' }),
  ).toBe(deck)
})

test('cycling wraps in both directions', () => {
  const deck = deckOf(3)
  expect(deckReducer(deck, { type: 'cycle', step: -1 }).activeId).toBe('tab-3')
  expect(deckReducer(deck, { type: 'cycle', step: 1 }).activeId).toBe('tab-2')
})

test('index 9 activates the last tab, Chrome-style', () => {
  expect(
    deckReducer(deckOf(4), { type: 'activateIndex', index: -1 }).activeId,
  ).toBe('tab-4')
})

test('an out-of-range index is ignored', () => {
  const deck = deckOf(2)
  expect(deckReducer(deck, { type: 'activateIndex', index: 7 })).toBe(deck)
})

test('starting a session titles the tab and records the launch', () => {
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  expect(deck.tabs[0].title).toBe('repo')
  expect(tabSession(deck.tabs[0])).toEqual(session)
})

test('workspace polls retitle the tab and flag uncommitted work', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  deck = deckReducer(deck, {
    type: 'workspace',
    id: 'tab-1',
    label: 'repo',
    branch: 'main',
    dirty: true,
  })
  expect(deck.tabs[0]).toMatchObject({
    title: 'repo',
    detail: 'main',
    dirty: true,
  })
})

test('a failed exit is reported with its code and survives later polls', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  deck = deckReducer(deck, { type: 'exited', id: 'tab-1', code: 130 })
  expect(deck.tabs[0].detail).toBe('exited 130')

  deck = deckReducer(deck, {
    type: 'workspace',
    id: 'tab-1',
    label: 'repo',
    branch: 'main',
    dirty: false,
  })
  expect(deck.tabs[0].detail).toBe('exited 130')
})

test("a clean exit reads as plain 'exited'", () => {
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'exited',
    id: 'tab-1',
    code: 0,
  })
  expect(deck.tabs[0].detail).toBe('exited')
})

test('history starts closed', () => {
  expect(initialDeck('tab-1').tabs[0].historyOpen).toBe(false)
})

test("toggling history flips only that tab's drawer", () => {
  let deck = deckOf(2)
  deck = deckReducer(deck, { type: 'toggleHistory', id: 'tab-1' })
  expect(deck.tabs.map((tab) => tab.historyOpen)).toEqual([true, false])

  deck = deckReducer(deck, { type: 'toggleHistory', id: 'tab-1' })
  expect(deck.tabs[0].historyOpen).toBe(false)
})

test('an open drawer survives switching tabs and workspace polls', () => {
  let deck = deckReducer(deckOf(2), { type: 'toggleHistory', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'activate', id: 'tab-2' })
  deck = deckReducer(deck, {
    type: 'workspace',
    id: 'tab-1',
    label: 'repo',
    branch: 'main',
    dirty: false,
  })
  expect(deck.tabs[0].historyOpen).toBe(true)
})

test('settings open in a tab of their own', () => {
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'openSettings',
    id: 'settings-tab',
  })
  expect(deck.tabs.map((tab) => tab.content.type)).toEqual([
    'launcher',
    'settings',
  ])
  expect(deck.tabs[1].title).toBe('Settings')
  expect(deck.activeId).toBe('settings-tab')
})

test('asking for settings twice focuses the tab already open', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'openSettings',
    id: 'settings-tab',
  })
  deck = deckReducer(deck, { type: 'activate', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'openSettings', id: 'another-settings-tab' })
  expect(deck.tabs).toHaveLength(2)
  expect(deck.activeId).toBe('settings-tab')
})

test('closing settings leaves the other tabs alone', () => {
  let deck = deckReducer(deckOf(2), {
    type: 'openSettings',
    id: 'settings-tab',
  })
  deck = deckReducer(deck, {
    type: 'close',
    id: 'settings-tab',
    replacementId: 'fresh',
  })
  expect(deck.tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2'])
})

test('starting a session turns a launcher tab into a session tab', () => {
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  expect(deck.tabs[0].content.type).toBe('session')
})

test('a tab starts with nothing demanding attention', () => {
  expect(initialDeck('tab-1').tabs[0].attention).toBe(false)
})

test('a background tab can be marked as waiting', () => {
  const deck = deckReducer(deckOf(2), { type: 'attention', id: 'tab-2' })
  expect(deck.tabs.map((tab) => tab.attention)).toEqual([false, true])
})

test('looking at a tab acknowledges its notice', () => {
  let deck = deckReducer(deckOf(2), { type: 'attention', id: 'tab-2' })
  deck = deckReducer(deck, { type: 'activate', id: 'tab-2' })
  expect(deck.tabs[1].attention).toBe(false)
})

test('cycling to a waiting tab acknowledges it too', () => {
  let deck = deckReducer(deckOf(3), { type: 'attention', id: 'tab-2' })
  deck = deckReducer(deck, { type: 'cycle', step: 1 })
  expect(deck.activeId).toBe('tab-2')
  expect(deck.tabs[1].attention).toBe(false)
})

test('jumping by index acknowledges the tab it lands on', () => {
  let deck = deckReducer(deckOf(3), { type: 'attention', id: 'tab-3' })
  deck = deckReducer(deck, { type: 'activateIndex', index: -1 })
  expect(deck.tabs[2].attention).toBe(false)
})

test('acknowledging one tab leaves other waiting tabs marked', () => {
  let deck = deckReducer(deckOf(3), { type: 'attention', id: 'tab-2' })
  deck = deckReducer(deck, { type: 'attention', id: 'tab-3' })
  deck = deckReducer(deck, { type: 'activate', id: 'tab-2' })
  expect(deck.tabs.map((tab) => tab.attention)).toEqual([false, false, true])
})

test('a tab can go back to the launcher after its session ends', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  deck = deckReducer(deck, { type: 'exited', id: 'tab-1', code: 1 })
  deck = deckReducer(deck, { type: 'relaunch', id: 'tab-1' })

  expect(deck.tabs[0].content.type).toBe('launcher')
  expect(deck.tabs[0].title).toBe('New session')
})

test('going back to the launcher clears everything the dead session left', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  deck = deckReducer(deck, {
    type: 'workspace',
    id: 'tab-1',
    label: 'repo',
    branch: 'main',
    dirty: true,
  })
  deck = deckReducer(deck, { type: 'toggleHistory', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'exited', id: 'tab-1', code: 130 })
  deck = deckReducer(deck, { type: 'attention', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'relaunch', id: 'tab-1' })

  expect(deck.tabs[0]).toMatchObject({
    detail: '',
    dirty: false,
    exitCode: null,
    attention: false,
    historyOpen: false,
    reviewOpen: false,
  })
})

test('going back keeps the tab in place rather than opening a new one', () => {
  let deck = deckOf(3)
  deck = deckReducer(deck, {
    type: 'start',
    id: 'tab-2',
    session,
    title: 'repo',
  })
  deck = deckReducer(deck, { type: 'relaunch', id: 'tab-2' })

  expect(deck.tabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2', 'tab-3'])
})

test('a new tab opens with the search bar closed', () => {
  expect(initialDeck('tab-1').tabs[0].findOpen).toBe(false)
})

test('opening search on an already-open bar leaves it open, so the shortcut refocuses', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'setFind', id: 'tab-1', open: true })
  deck = deckReducer(deck, { type: 'setFind', id: 'tab-1', open: true })
  expect(deck.tabs[0].findOpen).toBe(true)
})

test('closing search leaves the history drawer alone', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'toggleHistory', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'setFind', id: 'tab-1', open: true })
  deck = deckReducer(deck, { type: 'setFind', id: 'tab-1', open: false })
  expect(deck.tabs[0].findOpen).toBe(false)
  expect(deck.tabs[0].historyOpen).toBe(true)
})

test('a search opened on the launcher does not carry into the session it starts', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'setFind', id: 'tab-1', open: true })
  deck = deckReducer(deck, {
    type: 'start',
    id: 'tab-1',
    session: {
      agentId: 'claude',
      agentName: 'Claude Code',
      accent: '#d97757',
      program: 'claude',
      args: [],
      cwd: '/work',
      backend: 'native',
      distro: '',
    },
    title: 'work',
  })
  expect(deck.tabs[0].findOpen).toBe(false)
})

test('a change that changes nothing leaves the deck identical', () => {
  // The git poll dispatches `workspace` per tab per interval whether or not the
  // tree moved, and a new deck identity reads as "something happened" — which
  // is what made it write to localStorage every few seconds.
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'workspace',
    id: 'tab-1',
    label: 'muster',
    branch: 'main',
    dirty: false,
  })
  const again = deckReducer(deck, {
    type: 'workspace',
    id: 'tab-1',
    label: 'muster',
    branch: 'main',
    dirty: false,
  })
  expect(again).toBe(deck)
})

test('a real change still produces a new deck', () => {
  const deck = initialDeck('tab-1')
  const moved = deckReducer(deck, {
    type: 'workspace',
    id: 'tab-1',
    label: 'muster',
    branch: 'main',
    dirty: true,
  })
  expect(moved).not.toBe(deck)
  expect(moved.tabs[0]!.dirty).toBe(true)
})

test('an action for a tab that is gone leaves the deck alone', () => {
  const deck = initialDeck('tab-1')
  expect(deckReducer(deck, { type: 'attention', id: 'tab-404' })).toBe(deck)
})

test('the review panel starts closed', () => {
  expect(initialDeck('tab-1').tabs[0].reviewOpen).toBe(false)
})

test("toggling review flips only that tab's panel", () => {
  let deck = deckOf(2)
  deck = deckReducer(deck, { type: 'toggleReview', id: 'tab-1' })
  expect(deck.tabs.map((tab) => tab.reviewOpen)).toEqual([true, false])

  deck = deckReducer(deck, { type: 'toggleReview', id: 'tab-1' })
  expect(deck.tabs[0].reviewOpen).toBe(false)
})

test('a changed path clicked in the output opens the panel, open or not', () => {
  // The click is a request to see that diff, so it must not toggle the panel
  // shut when it happens to be open already.
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'setReview', id: 'tab-1', open: true })
  deck = deckReducer(deck, { type: 'setReview', id: 'tab-1', open: true })
  expect(deck.tabs[0].reviewOpen).toBe(true)
})

test('review and history are independent drawers', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'toggleReview', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'toggleHistory', id: 'tab-1' })
  expect(deck.tabs[0]).toMatchObject({ reviewOpen: true, historyOpen: true })
})

test('a review panel left open does not follow a relaunched tab', () => {
  // The panel reads the session's directory, and a relaunched tab has none
  // until it is started again.
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session,
    title: 'repo',
  })
  deck = deckReducer(deck, { type: 'toggleReview', id: 'tab-1' })
  deck = deckReducer(deck, { type: 'relaunch', id: 'tab-1' })
  expect(deck.tabs[0].reviewOpen).toBe(false)
})

test('a status chip opens its drawer whether or not it was open', () => {
  // The click means "show me these files", never "hide them".
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'setHistory', id: 'tab-1', open: true })
  deck = deckReducer(deck, { type: 'setHistory', id: 'tab-1', open: true })
  expect(deck.tabs[0].historyOpen).toBe(true)
})

test('a control that names a view opens the drawer on it', () => {
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'showReview',
    id: 'tab-1',
    view: 'files',
  })

  expect(deck.tabs[0]).toMatchObject({ reviewOpen: true, reviewView: 'files' })
})

test('naming the other view switches rather than closing', () => {
  // This is the difference between these controls and a toggle: the directory
  // and the change counts each say "show me this", not "flip the drawer".
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'showReview',
    id: 'tab-1',
    view: 'files',
  })
  deck = deckReducer(deck, { type: 'showReview', id: 'tab-1', view: 'changes' })

  expect(deck.tabs[0]).toMatchObject({
    reviewOpen: true,
    reviewView: 'changes',
  })
})

test('naming the view already on screen closes the drawer', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'showReview',
    id: 'tab-1',
    view: 'files',
  })
  deck = deckReducer(deck, { type: 'showReview', id: 'tab-1', view: 'files' })

  expect(deck.tabs[0].reviewOpen).toBe(false)
  // The view is remembered, so reopening lands where you left it.
  expect(deck.tabs[0].reviewView).toBe('files')
})

test("the drawer's own tabs switch without ever closing it", () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'showReview',
    id: 'tab-1',
    view: 'changes',
  })
  deck = deckReducer(deck, {
    type: 'setReviewView',
    id: 'tab-1',
    view: 'changes',
  })

  expect(deck.tabs[0]).toMatchObject({
    reviewOpen: true,
    reviewView: 'changes',
  })
})

test('a new tab starts on the changes view', () => {
  expect(initialDeck('tab-1').tabs[0].reviewView).toBe('changes')
})
