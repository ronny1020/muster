import { expect, test } from 'bun:test'

import { newTab, type Tab } from '../entities/tab/model/deck'
import { readHandoff, writeHandoff } from './handoff'

const terminal = {
  snapshot: '$ ls\r\n',
  offset: 42,
  cols: 80,
  rows: 24,
  epoch: 3,
  integrated: true,
  integratedAfterHandback: false,
  handbackToken: null,
  handedBack: false,
  modes: '\x1b[?1006h\x1b[?25l',
  historyFile: '/home/me/.zsh_history',
}

const sessionTab: Tab = {
  ...newTab('t1'),
  content: {
    type: 'session',
    session: {
      agentId: 'shell',
      agentName: 'Shell',
      accent: '#888888',
      program: '',
      args: [],
      cwd: '/work',
      backend: 'native',
      distro: '',
      scrollback: true,
    },
  },
}

test('a session tab and its terminal read back as written', () => {
  const read = readHandoff(
    writeHandoff({ tab: sessionTab, terminal, dropX: null }),
  )
  expect(read).toEqual({ tab: sessionTab, terminal, dropX: null })
})

test('a session tab without its terminal is refused, so nothing respawns', () => {
  expect(
    readHandoff(writeHandoff({ tab: sessionTab, terminal: null, dropX: null })),
  ).toBeNull()
})

test('a launcher tab moves with no terminal at all', () => {
  const tab = newTab('t2')
  expect(
    readHandoff(writeHandoff({ tab, terminal: null, dropX: null }))?.tab,
  ).toEqual(tab)
})

test('text that is not a handoff reads as nothing', () => {
  expect(readHandoff('not json')).toBeNull()
  expect(readHandoff('42')).toBeNull()
})

test('a mode sequence that is not one the move carries is dropped', () => {
  const read = readHandoff(
    writeHandoff({
      tab: sessionTab,
      terminal: { ...terminal, modes: '\x1b]52;c;cGF5bG9hZA==\x07' },
      dropX: null,
    }),
  )
  expect(read?.terminal?.modes).toBe('')
})

test('where a tab was dropped on the strip travels with it', () => {
  const tab = newTab('t3')
  expect(
    readHandoff(writeHandoff({ tab, terminal: null, dropX: 140 }))?.dropX,
  ).toBe(140)
})
