import { expect, test } from 'bun:test'

import {
  AGENTS,
  agentById,
  SHELL_AGENT,
  resumeArgs,
  pickableAgent,
} from './agents'

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
  // Usually with no arguments at all; Goose has no bare form, so "plain" is
  // spelled `goose session` there. What matters is that the first mode is the
  // one the launcher offers and the default-agent setting starts.
  const plain = Object.fromEntries(
    AGENTS.map((agent) => [agent.id, agent.modes[0].args]),
  )
  expect(plain.goose).toEqual(['session'])
  for (const agent of AGENTS.filter((agent) => agent.id !== 'goose')) {
    expect(agent.modes[0].args).toEqual([])
  }
})

test('the roster is these CLIs, in this order', () => {
  // Pinned deliberately: the order is what the picker shows, and each command
  // was read off that CLI's own documentation rather than assumed.
  expect(AGENTS.map((agent) => agent.command)).toEqual([
    'claude',
    'codex',
    'opencode',
    'gemini',
    'goose',
    'openclaw',
    'hermes',
    'aider',
    'agy',
  ])
})

test('every agent leads with its new-session mode', () => {
  for (const agent of AGENTS) expect(agent.modes[0].id).toBe('new')
})

test('each CLI continues its last session in its own dialect', () => {
  const continued = Object.fromEntries(
    AGENTS.map((agent) => [
      agent.id,
      agent.modes.find((mode) => mode.id === 'continue')?.args,
    ]),
  )
  // An agent with no documented flag for it offers no Continue at all, rather
  // than a guess: a flag a CLI does not have makes it refuse to start.
  expect(continued).toEqual({
    claude: ['--continue'],
    codex: ['resume', '--last'],
    opencode: ['--continue'],
    gemini: undefined,
    goose: ['session', '--resume'],
    openclaw: undefined,
    hermes: undefined,
    aider: undefined,
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

test("resuming a named conversation uses the agent's own resume spelling", () => {
  const claude = AGENTS.find((agent) => agent.id === 'claude')!
  expect(resumeArgs(claude, 'abc-123')).toEqual(['--resume', 'abc-123'])
})

test('an agent with no resume mode offers no way to reopen one', () => {
  // Better no button than a button that starts a fresh session while claiming
  // to reopen a conversation.
  const withoutResume = AGENTS.filter(
    (agent) => !agent.modes.some((mode) => mode.id === 'resume'),
  )
  for (const agent of withoutResume) {
    expect(resumeArgs(agent, 'abc-123')).toBeNull()
  }
})

test('no session id means nothing to resume', () => {
  const claude = AGENTS.find((agent) => agent.id === 'claude')!
  expect(resumeArgs(claude, '')).toBeNull()
})

test('the shell is never what a picker opens on', () => {
  // It has its own control, so a stored or restored `shell` must not leave the
  // agent picker showing a selection the list does not contain.
  expect(pickableAgent('shell').id).not.toBe('shell')
  expect(AGENTS.some((agent) => agent.id === pickableAgent('shell').id)).toBe(
    true,
  )
})

test('a real agent id still opens on itself', () => {
  expect(pickableAgent('codex').id).toBe('codex')
})

test('an unknown id falls back to a listed agent rather than nothing', () => {
  expect(AGENTS.some((agent) => agent.id === pickableAgent('gone').id)).toBe(
    true,
  )
})

test('only the CLI that answers the variable is offered the mode switch', () => {
  // `SCROLLBACK_ENV` in `pty.rs` is undocumented and read by Claude Code
  // alone. Anywhere else the control would reopen the session and change
  // nothing about it.
  const offered = [...AGENTS, SHELL_AGENT].filter(
    (agent) => agent.scrollbackMode,
  )
  expect(offered.map((agent) => agent.id)).toEqual(['claude'])
})

test('switching mode has a conversation to reopen', () => {
  // The variable is read at spawn, so the switch starts the CLI again — which
  // is only worth offering where its own `continue` can print the session back.
  for (const agent of AGENTS.filter((agent) => agent.scrollbackMode)) {
    expect(agent.modes.some((mode) => mode.id === 'continue')).toBe(true)
  }
})
