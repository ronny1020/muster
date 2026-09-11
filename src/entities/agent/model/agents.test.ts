import { expect, test } from 'bun:test'

import { AGENTS, agentById, SHELL_AGENT } from './agents'

test('every agent id resolves to itself', () => {
  for (const agent of AGENTS) expect(agentById(agent.id)).toBe(agent)
})

test('the shell is addressable by id', () => {
  expect(agentById('shell')).toBe(SHELL_AGENT)
})

test('an unknown id falls back to the first agent rather than throwing', () => {
  expect(agentById('gpt-9000')).toBe(AGENTS[0])
  expect(agentById('')).toBe(AGENTS[0])
})

test('the shell runs the login shell itself, with no program of its own', () => {
  expect(SHELL_AGENT.command).toBe('')
})

test('the shell takes no flags, since there is no program to pass them to', () => {
  expect(SHELL_AGENT.acceptsFlags).toBe(false)
})

test('a real agent CLI does take flags', () => {
  for (const agent of AGENTS) expect(agent.acceptsFlags).toBe(true)
})

test('every agent has at least one launch mode', () => {
  for (const agent of [...AGENTS, SHELL_AGENT])
    expect(agent.modes.length).toBeGreaterThan(0)
})

test('agent ids and commands are unique', () => {
  const all = [...AGENTS, SHELL_AGENT]
  expect(new Set(all.map((agent) => agent.id)).size).toBe(all.length)
  expect(new Set(AGENTS.map((agent) => agent.command)).size).toBe(AGENTS.length)
})

test('the first mode of every agent starts a plain session', () => {
  for (const agent of AGENTS) expect(agent.modes[0].args).toEqual([])
})

test('the agents on offer are Claude, Codex and Antigravity', () => {
  expect(AGENTS.map((agent) => agent.command)).toEqual([
    'claude',
    'codex',
    'agy',
  ])
})

test('every agent starts a fresh session with no arguments at all', () => {
  for (const agent of AGENTS) {
    const [first] = agent.modes
    expect(first.id).toBe('new')
    expect(first.args).toEqual([])
  }
})

test('each CLI continues its last session in its own dialect', () => {
  const continued = Object.fromEntries(
    AGENTS.map((agent) => [
      agent.id,
      agent.modes.find((mode) => mode.id === 'continue')?.args,
    ]),
  )
  expect(continued).toEqual({
    claude: ['--continue'],
    codex: ['resume', '--last'],
    antigravity: ['--continue'],
  })
})

test('a picker mode is offered only by the CLIs that have one', () => {
  const withPicker = AGENTS.filter((agent) =>
    agent.modes.some((mode) => mode.id === 'resume'),
  )
  // Antigravity reaches past conversations with `/resume` inside the TUI, not
  // from the command line, so it has no picker mode to offer.
  expect(withPicker.map((agent) => agent.id)).toEqual(['claude', 'codex'])
})

test('no two agents share an id or an accent', () => {
  const all = [...AGENTS, SHELL_AGENT]
  expect(new Set(all.map((agent) => agent.id)).size).toBe(all.length)
  expect(new Set(all.map((agent) => agent.accent)).size).toBe(all.length)
})
