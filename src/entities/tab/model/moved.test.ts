import { expect, test } from 'bun:test'

import { newTab, type Tab } from './deck'
import { parseMovedTab } from './moved'

const sessionTab: Tab = {
  ...newTab('t1'),
  title: 'repo',
  handedBack: true,
  exitCode: null,
  content: {
    type: 'session',
    session: {
      agentId: 'claude',
      agentName: 'Claude Code',
      accent: '#d97757',
      program: 'claude',
      args: ['--continue'],
      cwd: '/work/repo',
      backend: 'native',
      distro: '',
      scrollback: true,
    },
  },
}

test('a tab survives the trip between windows unchanged', () => {
  expect(parseMovedTab(JSON.parse(JSON.stringify(sessionTab)))).toEqual(
    sessionTab,
  )
})

test('a session that does not check out is refused, never repaired', () => {
  const broken = JSON.parse(JSON.stringify(sessionTab))
  broken.content.session.args = [1, 2]
  expect(parseMovedTab(broken)).toBeNull()
})

test('anything without an id or content is not a tab', () => {
  expect(parseMovedTab(null)).toBeNull()
  expect(parseMovedTab({ id: '', content: { type: 'settings' } })).toBeNull()
  expect(parseMovedTab({ id: 'x', content: { type: 'nope' } })).toBeNull()
})

test('a damaged field falls back rather than refusing the tab', () => {
  const tab = parseMovedTab({
    id: 'x',
    content: { type: 'launcher' },
    status: 'exploding',
    reviewView: 7,
  })
  expect(tab?.status).toBe('unknown')
  expect(tab?.reviewView).toBe('changes')
})
