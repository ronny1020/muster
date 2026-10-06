import { expect, test } from 'bun:test'

import { handbackNotice, parseHandback } from './handback'

const TOKEN = '0123456789abcdef'

test('the announcement carries the agent exit status', () => {
  expect(parseHandback(`muster-handback;${TOKEN};0`, TOKEN)).toBe(0)
  expect(parseHandback(`muster-handback;${TOKEN};127`, TOKEN)).toBe(127)
})

test('an announcement without the session token is not believed', () => {
  // What an agent, or a file it printed, could send while still running.
  expect(parseHandback('muster-handback;0', TOKEN)).toBeNull()
  expect(parseHandback('muster-handback;guess;0', TOKEN)).toBeNull()
})

test('anything that is not exactly the announcement is ignored', () => {
  for (const data of [
    'notify;warp://cli-agent;{"event":"stop"}',
    'muster-handback',
    `muster-handback;${TOKEN}`,
    `muster-handback;${TOKEN};`,
    `muster-handback;${TOKEN};3;extra`,
    `muster-handback;${TOKEN};-1`,
    `muster-handback;${TOKEN};256`,
    `muster-handback;${TOKEN};1e2`,
    `muster-handbackx;${TOKEN};3`,
  ]) {
    expect(parseHandback(data, TOKEN)).toBeNull()
  }
})

test('a failed agent says how it failed, and a clean one does not', () => {
  expect(handbackNotice(0)).not.toContain('code')
  expect(handbackNotice(2)).toContain('code 2')
})
