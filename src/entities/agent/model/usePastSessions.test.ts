import { expect, test } from 'bun:test'

import { canReopen } from './usePastSessions'

test('a conversation that exists is offered a control to reopen it', () => {
  expect(canReopen(3)).toBe(true)
})

test('a tab with nothing to continue is offered nothing that would end it', () => {
  // The control reopens with the agent's own `continue`, which answers
  // `No conversation found to continue` and exits — so a tab that was working
  // is left at `exited 1` by a button that promised to change its mode.
  expect(canReopen(0)).toBe(false)
})

test('an unknown count still offers, rather than hiding on a guess', () => {
  // `null` is the answer before the read lands and for any agent whose store
  // the backend does not count. Hiding a working control is the worse error:
  // the tab then has no way to change mode at all.
  expect(canReopen(null)).toBe(true)
})
