import { describe, expect, test } from 'bun:test'

import type { Commit } from '../../../shared/ipc'
import {
  type Deck,
  type AgentStatus,
  newTab,
} from '../../../entities/tab/model/deck'
import {
  addNotice,
  dropSeen,
  headMoved,
  landedCommit,
  overlapKey,
  type Notice,
  type NoticeEvent,
  noticeCards,
  worthRaising,
} from './notices'

let ids = 0
const notice = (tabId: string, event: NoticeEvent): Notice => ({
  ...event,
  id: (ids += 1),
  tabId,
})

function deckWith(statuses: Record<string, AgentStatus>): Deck {
  const tabs = Object.entries(statuses).map(([id, status]) => ({
    ...newTab(id),
    status,
  }))
  return { tabs, activeId: tabs[0].id, shown: [tabs[0].id] }
}

const none = new Set<string>()
const cardsOf = (...args: Parameters<typeof noticeCards>) =>
  noticeCards(...args).cards

describe('addNotice', () => {
  test('a tab keeps one card of each kind, the latest', () => {
    const first = notice('a', { kind: 'finished', said: 'one' })
    const second = notice('a', { kind: 'finished', said: 'two' })
    expect(addNotice([first], second)).toEqual([second])
  })

  test('different kinds and different tabs stand side by side', () => {
    const list = [notice('a', { kind: 'finished' })]
    expect(addNotice(list, notice('a', { kind: 'asking' }))).toHaveLength(2)
    expect(addNotice(list, notice('b', { kind: 'finished' }))).toHaveLength(2)
  })

  test('an overlap is one card per file, whichever tab raised it', () => {
    const event: NoticeEvent = {
      kind: 'collision',
      path: 'x.ts',
      tabIds: ['a', 'b'],
    }
    const list = [notice('a', event)]
    expect(addNotice(list, notice('b', event))).toHaveLength(1)
  })

  test('a failed turn replaces the same turn announced as finished', () => {
    const finished = notice('a', { kind: 'finished' })
    const failed = notice('a', { kind: 'stopped', code: null })
    expect(addNotice([finished], failed)).toEqual([failed])
  })

  test('tabs sharing a tree make one card of one commit', () => {
    const event: NoticeEvent = {
      kind: 'committed',
      head: 'abc',
      branch: 'main',
      subject: 'fix',
    }
    const list = [notice('a', event)]
    expect(addNotice(list, notice('b', event))).toHaveLength(1)
  })

  test('a flood of news never drops a card that waits for you', () => {
    let list = [notice('a', { kind: 'asking' })]
    for (let index = 0; index < 40; index += 1) {
      list = addNotice(list, notice(`t${index}`, { kind: 'finished' }))
    }
    expect(list.some((entry) => entry.kind === 'asking')).toBe(true)
    expect(list.filter((entry) => entry.kind === 'finished')).toHaveLength(20)
  })
})

describe('landedCommit', () => {
  const NOW = 1_800_000_000
  const commit = (sha: string, at: number | null = null): Commit => ({
    sha,
    short: sha,
    subject: `subject ${sha}`,
    author: 'me',
    at,
    refs: [],
    unpushed: false,
  })
  const branch = (head: string, ahead: number, upstream: string | null) => ({
    head,
    ahead,
    upstream,
    branch: 'main',
    detached: false,
  })
  const onTop = [commit('new'), commit('old')]

  test('a commit made on top of the old head is news', () => {
    const was = branch('old', 0, 'origin/main')
    const now = branch('new', 1, 'origin/main')
    expect(
      landedCommit({ was, now, log: onTop, since: NOW - 4 })?.subject,
    ).toBe('subject new')
  })

  test('a pulled commit is not, though its parent is the old head', () => {
    const was = branch('old', 0, 'upstream/main')
    const now = branch('new', 0, 'upstream/main')
    // Written an hour ago, by someone else.
    const log = [commit('new', NOW - 3600), commit('old')]
    expect(landedCommit({ was, now, log, since: NOW - 4 })).toBeNull()
  })

  test('a reset is not, for the old head is no parent of the new', () => {
    const was = branch('old', 2, 'origin/main')
    const now = branch('older', 1, 'origin/main')
    const log = [commit('older'), commit('oldest')]
    expect(landedCommit({ was, now, log, since: NOW - 4 })).toBeNull()
  })

  test('the commit is found by its sha, though HEAD moved on meanwhile', () => {
    const was = branch('old', 0, 'origin/main')
    const now = branch('new', 1, 'origin/main')
    const log = [commit('newer'), commit('new'), commit('old')]
    expect(landedCommit({ was, now, log, since: NOW - 4 })?.subject).toBe(
      'subject new',
    )
  })

  test('a merge made here is news, its other side listed first', () => {
    const was = branch('old', 0, 'origin/main')
    const now = branch('merge', 2, 'origin/main')
    const log = [commit('merge'), commit('theirs'), commit('old')]
    expect(landedCommit({ was, now, log, since: NOW - 4 })?.subject).toBe(
      'subject merge',
    )
  })

  test('a commit written since the last poll counts though it was pushed', () => {
    const was = branch('old', 0, 'origin/main')
    const now = branch('new', 0, 'origin/main')
    const log = [commit('new', NOW - 5), commit('old')]
    expect(landedCommit({ was, now, log, since: NOW - 4 })?.subject).toBe(
      'subject new',
    )
  })

  test('a commit written while the window slept still counts', () => {
    // Polls stall in a hidden or sleeping window; the last one was long ago.
    const was = branch('old', 0, null)
    const now = branch('new', 0, null)
    const log = [commit('new', NOW - 600), commit('old')]
    expect(landedCommit({ was, now, log, since: NOW - 3600 })?.subject).toBe(
      'subject new',
    )
  })

  test('an old commit fast-forwarded onto a branch with no upstream does not', () => {
    const was = branch('old', 0, null)
    const now = branch('new', 0, null)
    const log = [commit('new', NOW - 86_400), commit('old')]
    expect(landedCommit({ was, now, log, since: NOW - 4 })).toBeNull()
  })
})

describe('headMoved', () => {
  const at = (head: string, branch = 'main', detached = false) => ({
    head,
    branch,
    detached,
    ahead: 0,
    upstream: null,
  })

  test('a new head on the same branch moved', () => {
    expect(headMoved(at('a'), at('b'))).toBe(true)
  })

  test('a checkout, a detached head or a first commit did not', () => {
    expect(headMoved(at('a'), at('b', 'other'))).toBe(false)
    expect(headMoved(at('a'), at('b', 'main', true))).toBe(false)
    expect(headMoved(at(''), at('b'))).toBe(false)
  })
})

test('an overlap that ended in one repo is not kept alive by the same path in another', () => {
  const overlap = notice('a', {
    kind: 'collision',
    path: 'src/index.ts',
    tabIds: ['a', 'b'],
  })
  const deck = deckWith({ a: 'working', b: 'working', c: 'working' })
  const elsewhere = new Set([overlapKey('c', 'src/index.ts')])
  expect(cardsOf([overlap], { deck, overlaps: elsewhere })).toEqual([])
})

describe('worthRaising', () => {
  test('news about the tab you are watching is not raised', () => {
    expect(worthRaising({ kind: 'finished' }, true)).toBe(false)
    expect(worthRaising({ kind: 'asking' }, true)).toBe(false)
    expect(worthRaising({ kind: 'finished' }, false)).toBe(true)
  })

  test('a failed git write and an overlap reach you anyway', () => {
    expect(worthRaising({ kind: 'gitFailed', text: 'rejected' }, true)).toBe(
      true,
    )
    expect(
      worthRaising({ kind: 'collision', path: 'x', tabIds: ['a', 'b'] }, true),
    ).toBe(true)
  })
})

test('visiting a tab clears its cards, but not the ones that follow you', () => {
  const finished = notice('a', { kind: 'finished' })
  const failed = notice('a', { kind: 'gitFailed', text: 'rejected' })
  const elsewhere = notice('b', { kind: 'finished' })
  expect(dropSeen([finished, failed, elsewhere], ['a'])).toEqual([
    failed,
    elsewhere,
  ])
})

describe('noticeCards', () => {
  test('a question that has been answered is no longer drawn', () => {
    const asking = notice('a', { kind: 'asking' })
    const deck = deckWith({ a: 'working' })
    expect(cardsOf([asking], { deck, overlaps: none })).toEqual([])
  })

  test('an exit stands while the shell it handed to works', () => {
    const exited = notice('a', { kind: 'stopped', code: 1 })
    expect(
      cardsOf([exited], {
        deck: deckWith({ a: 'working' }),
        overlaps: none,
      }),
    ).toHaveLength(1)
  })

  test('a failed turn stands while its agent is still printing', () => {
    // The failure arrives in the output that keeps the tab working.
    const stopped = notice('a', { kind: 'stopped', code: null })
    const deck = deckWith({ a: 'working' })
    const { cards, stale } = noticeCards([stopped], { deck, overlaps: none })
    expect(stale).toEqual([])
    expect(cards).toHaveLength(1)
  })

  test('the next finished turn replaces a failed one', () => {
    const failed = notice('a', { kind: 'stopped', code: null })
    const finished = notice('a', { kind: 'finished' })
    expect(addNotice([failed], finished)).toEqual([finished])
  })

  test('an overlap one side has finished with is no longer drawn', () => {
    const overlap = notice('a', {
      kind: 'collision',
      path: 'x.ts',
      tabIds: ['a', 'b'],
    })
    const deck = deckWith({ a: 'working', b: 'working' })
    expect(cardsOf([overlap], { deck, overlaps: none })).toEqual([])
    expect(
      cardsOf([overlap], {
        deck,
        overlaps: new Set([overlapKey('a', 'x.ts'), overlapKey('b', 'x.ts')]),
      }),
    ).toHaveLength(1)
  })

  test('an overlap outlives the tab its card names while two others go on', () => {
    const overlap = notice('a', {
      kind: 'collision',
      path: 'x.ts',
      tabIds: ['a', 'c', 'd'],
    })
    const deck = deckWith({ a: 'working', c: 'working', d: 'working' })
    const overlaps = new Set([overlapKey('c', 'x.ts'), overlapKey('d', 'x.ts')])
    expect(cardsOf([overlap], { deck, overlaps })).toHaveLength(1)
  })

  test('a closed tab takes its cards with it', () => {
    const gone = notice('closed', { kind: 'finished' })
    expect(
      cardsOf([gone], {
        deck: deckWith({ a: 'waiting' }),
        overlaps: none,
      }),
    ).toEqual([])
  })

  test('what needs you comes before what is news, newest first', () => {
    const older = notice('a', { kind: 'finished' })
    const asking = notice('b', { kind: 'asking' })
    const newer = notice('c', { kind: 'finished' })
    const deck = deckWith({ a: 'waiting', b: 'asking', c: 'waiting' })
    const order = cardsOf([older, asking, newer], { deck, overlaps: none })
    expect(order.map((card) => card.notice)).toEqual([asking, newer, older])
  })
})

test('a notice whose state has gone is handed back to be dropped', () => {
  const asking = notice('a', { kind: 'asking' })
  const deck = deckWith({ a: 'working' })
  expect(noticeCards([asking], { deck, overlaps: none }).stale).toEqual([
    asking.id,
  ])
})

test('an exit keeps the words of the failed turn it replaces', () => {
  const failed = notice('a', {
    kind: 'stopped',
    code: null,
    said: 'rate limited',
  })
  const exited = notice('a', { kind: 'stopped', code: 1 })
  const [kept] = addNotice([failed], exited)
  expect(kept.id).toBe(exited.id)
  expect(kept.kind === 'stopped' && kept.said).toBe('rate limited')
})

test('a tab joining an overlap replaces the card rather than adding one', () => {
  const pair = notice('a', {
    kind: 'collision',
    path: 'x.ts',
    tabIds: ['a', 'b'],
  })
  const three = notice('a', {
    kind: 'collision',
    path: 'x.ts',
    tabIds: ['a', 'b', 'c'],
  })
  const elsewhere = notice('c', {
    kind: 'collision',
    path: 'x.ts',
    tabIds: ['c', 'd'],
  })
  expect(addNotice([pair], three)).toEqual([three])
  expect(addNotice([pair], elsewhere)).toHaveLength(2)
})

describe('an overlap card follows the tabs still in it', () => {
  const overlap = (tabIds: string[]) =>
    notice('a', { kind: 'collision', path: 'p', tabIds })
  const live = (...ids: string[]) =>
    new Set(ids.map((id) => overlapKey(id, 'p')))

  test('closing the tab it names hands it to one still changing the file', () => {
    const deck = deckWith({ b: 'working', c: 'working' })
    const [card] = cardsOf([overlap(['a', 'b', 'c'])], {
      deck,
      overlaps: live('b', 'c'),
    })
    expect(card.notice.tabId).not.toBe('a')
    expect(card.others).toHaveLength(1)
  })

  test('a named tab that moved on is not where the click goes', () => {
    const deck = deckWith({ a: 'working', b: 'working', c: 'working' })
    const [card] = cardsOf([overlap(['a', 'b', 'c'])], {
      deck,
      overlaps: live('b', 'c'),
    })
    expect(['b', 'c']).toContain(card.notice.tabId)
  })

  test('a tab that left is no longer listed as changing it', () => {
    const deck = deckWith({ a: 'working', b: 'working', c: 'working' })
    const [card] = cardsOf([overlap(['a', 'b', 'c'])], {
      deck,
      overlaps: live('a', 'b'),
    })
    // `a` is the tab on screen, so the card names the other one.
    expect(card.notice.tabId).toBe('b')
    expect(card.others).toHaveLength(1)
  })
})

test('an overlap card never names the tab you are on', () => {
  // `a` is the active tab in `deckWith`.
  const overlap = notice('a', {
    kind: 'collision',
    path: 'p',
    tabIds: ['a', 'b'],
  })
  const deck = deckWith({ a: 'working', b: 'working' })
  const overlaps = new Set([overlapKey('a', 'p'), overlapKey('b', 'p')])
  const [card] = cardsOf([overlap], { deck, overlaps })
  expect(card.notice.tabId).toBe('b')
})
