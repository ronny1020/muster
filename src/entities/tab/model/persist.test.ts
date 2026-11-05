import { beforeEach, expect, test } from 'bun:test'

import { deckReducer, initialDeck, type Session } from './deck'
import { loadDeck, normalizeDeck, saveDeck } from './persist'
import { startOf } from './deck'
import { seedAppState } from '../../../shared/lib/appstate'
import { windowLabel } from '../../../shared/ipc'

const session = (over: Partial<Session> = {}): Session => ({
  agentId: 'claude',
  agentName: 'Claude Code',
  accent: '#d97757',
  program: 'claude',
  args: ['--continue'],
  cwd: '/work/api',
  backend: 'native',
  distro: '',
  scrollback: false,
  ...over,
})

let counter = 0
const nextId = () => `t-${++counter}`

beforeEach(() => {
  seedAppState({})
  counter = 0
})

test('nothing stored restores a single blank tab', () => {
  const deck = loadDeck(nextId)
  expect(deck.tabs).toHaveLength(1)
  expect(deck.tabs[0].content.type).toBe('launcher')
  expect(deck.activeId).toBe(deck.tabs[0].id)
})

test('a session tab comes back as a launcher holding its directory and agent', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, {
    type: 'start',
    id: 'tab-1',
    session: session(),
    title: 'api',
  })
  saveDeck(deck)

  const restored = loadDeck(nextId)
  expect(restored.tabs).toHaveLength(1)
  const content = restored.tabs[0].content
  expect(content.type).toBe('launcher')
  if (content.type !== 'launcher') throw new Error('expected a launcher')
  expect(content.start?.cwd).toBe('/work/api')
  expect(content.start?.agentId).toBe('claude')
})

test('a restored tab is named after its directory, not "New session"', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, {
    type: 'start',
    id: 'tab-1',
    session: session({ cwd: '/work/api' }),
    title: 'api',
  })
  saveDeck(deck)
  expect(loadDeck(nextId).tabs[0].title).toBe('api')
})

test('the launch mode is not replayed, since it is a choice to make again', () => {
  // `--continue` on a restart would reopen a conversation nobody asked for.
  const tab = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session: session({ args: ['--continue'] }),
    title: 'api',
  }).tabs[0]
  expect(startOf(tab)?.flags).toBe('')
})

test('ids come from the caller, so a restored tab cannot take over a live session', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, {
    type: 'start',
    id: 'tab-1',
    session: session(),
    title: 'api',
  })
  saveDeck(deck)
  const restored = loadDeck(nextId)
  expect(restored.tabs[0].id).toBe('t-1')
})

test('the settings tab is not remembered as a workspace', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'openSettings', id: 'tab-2' })
  saveDeck(deck)
  expect(loadDeck(nextId).tabs).toHaveLength(1)
})

test('the active tab is restored as the active one', () => {
  let deck = initialDeck('tab-1')
  deck = deckReducer(deck, { type: 'open', id: 'tab-2' })
  deck = deckReducer(deck, { type: 'activate', id: 'tab-1' })
  saveDeck(deck)
  const restored = loadDeck(nextId)
  expect(restored.activeId).toBe(restored.tabs[0].id)
})

test('a corrupt record repairs rather than throwing', () => {
  expect(normalizeDeck('nonsense')).toEqual({
    tabs: [],
    activeIndex: 0,
    columns: [],
    shown: [],
  })
  expect(normalizeDeck({ tabs: 'no' })).toEqual({
    tabs: [],
    activeIndex: 0,
    columns: [],
    shown: [],
  })
  expect(normalizeDeck({ tabs: [null, 7, 'x'] }).tabs).toEqual([
    null,
    null,
    null,
  ])
})

test('an active index outside the tabs falls back to the first', () => {
  expect(normalizeDeck({ tabs: [null], activeIndex: 9 }).activeIndex).toBe(0)
  expect(normalizeDeck({ tabs: [null], activeIndex: -2 }).activeIndex).toBe(0)
})

test('a stored start with no directory is nothing to restore', () => {
  expect(normalizeDeck({ tabs: [{ cwd: '   ' }] }).tabs).toEqual([null])
})

test('an unknown backend falls back to the host', () => {
  expect(
    normalizeDeck({ tabs: [{ cwd: '/work', backend: 'martian' }] }).tabs[0]
      ?.backend,
  ).toBe('native')
})

/** What `saveDeck` writes under, so a test can seed what `loadDeck` will read. */
const deckKey = () => `muster.deck:${windowLabel()}`

test('a stored record is read back from the key the deck is saved under', () => {
  // The control for the test below: an empty store also yields one tab, so
  // without a case that can only pass when the record is genuinely read, a
  // misspelled key would look exactly like a successful repair.
  seedAppState({ [deckKey()]: '{"tabs":[null,null],"activeIndex":1}' })
  expect(loadDeck(nextId).tabs).toHaveLength(2)
})

test('a truncated stored record does not stop the window opening', () => {
  seedAppState({ [deckKey()]: '{"tabs":[{"cwd":"/work"' })
  expect(loadDeck(nextId).tabs).toHaveLength(1)
})

test('an unchanged deck is not written again, since the git poll rebuilds it constantly', () => {
  const deck = deckReducer(initialDeck('tab-1'), {
    type: 'start',
    id: 'tab-1',
    session: session(),
    title: 'api',
  })
  saveDeck(deck)

  let writes = 0
  const real = localStorage.setItem.bind(localStorage)
  localStorage.setItem = (key: string, value: string) => {
    writes += 1
    real(key, value)
  }
  // `patch` allocates a new tabs array every dispatch, so an identical deck
  // arrives here with a different identity many times a minute.
  saveDeck(deck)
  saveDeck({ ...deck, tabs: [...deck.tabs] })
  localStorage.setItem = real
  expect(writes).toBe(0)
})

test('a real change is still written', () => {
  let deck = initialDeck('tab-1')
  saveDeck(deck)
  deck = deckReducer(deck, { type: 'open', id: 'tab-2' })
  saveDeck(deck)
  expect(loadDeck(nextId).tabs).toHaveLength(2)
})

test('a directory ending in a space is kept, not trimmed to another path', () => {
  // Legal on macOS, and the picker hands the path over verbatim.
  expect(normalizeDeck({ tabs: [{ cwd: '/work/odd ' }] }).tabs[0]?.cwd).toBe(
    '/work/odd ',
  )
})

test('columns survive a restart, with each tab in the column it was in', () => {
  let deck = deckReducer(initialDeck('tab-1'), { type: 'open', id: 'tab-2' })
  deck = deckReducer(deck, { type: 'split', id: 'unused' })
  saveDeck(deck)
  const restored = loadDeck(nextId)
  expect(restored.tabs.map((tab) => tab.column)).toEqual([0, 1])
  expect(restored.shown).toHaveLength(2)
  expect(restored.activeId).toBe(restored.tabs[1].id)
})

test('each column comes back showing the tab it showed', () => {
  const opened = ['tab-2', 'tab-3', 'tab-4'].reduce(
    (deck, id) => deckReducer(deck, { type: 'open', id }),
    initialDeck('tab-1'),
  )
  const deck = deckReducer(opened, { type: 'split', id: 'unused' })
  // The left column shows the tab that slid into the moved one's place.
  expect(deck.shown).toEqual(['tab-3', 'tab-4'])
  saveDeck(deck)
  const restored = loadDeck(nextId)
  expect(restored.shown).toEqual([restored.tabs[2].id, restored.tabs[3].id])
  expect(restored.activeId).toBe(restored.tabs[3].id)
})

test('a column held only by the settings tab is not restored empty', () => {
  let deck = deckReducer(initialDeck('tab-1'), {
    type: 'openSettings',
    id: 'settings',
  })
  deck = deckReducer(deck, { type: 'split', id: 'unused' })
  saveDeck(deck)
  const restored = loadDeck(nextId)
  expect(restored.shown).toHaveLength(1)
  expect(restored.tabs.map((tab) => tab.column)).toEqual([0])
})

test('a record from before columns, or a mangled one, puts every tab in one column', () => {
  expect(normalizeDeck({ tabs: [null, null] }).columns).toEqual([0, 0])
  expect(
    normalizeDeck({ tabs: [null, null], columns: [-1, 'x'] }).columns,
  ).toEqual([0, 0])
})
