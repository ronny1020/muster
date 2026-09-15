/**
 * Supported agent CLIs. Entries here are all the UI needs to gain another one.
 */
export interface LaunchMode {
  id: string
  label: string
  hint: string
  /**
   * What the CLI is started with. The first mode's arguments are whatever
   * starts a plain session in that CLI's own spelling — usually nothing, but
   * Goose has no bare form and wants `session`.
   */
  args: string[]
}

export interface Agent {
  id: string
  name: string
  /** Binary resolved through the user's shell, so `.cmd` shims work too. */
  command: string
  accent: string
  /** Whether extra CLI flags mean anything to this agent. */
  acceptsFlags: boolean
  modes: LaunchMode[]
}

export const AGENTS: Agent[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    accent: '#d97757',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
      {
        id: 'continue',
        label: 'Continue',
        hint: 'Reopen the most recent session',
        args: ['--continue'],
      },
      {
        id: 'resume',
        label: 'Resume…',
        hint: 'Pick from past sessions',
        args: ['--resume'],
      },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    accent: '#10a37f',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
      {
        id: 'continue',
        label: 'Continue',
        hint: 'Reopen the most recent session',
        args: ['resume', '--last'],
      },
      {
        id: 'resume',
        label: 'Resume…',
        hint: 'Pick from past sessions',
        args: ['resume'],
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    accent: '#c2703a',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
      {
        id: 'continue',
        label: 'Continue',
        hint: 'Reopen the most recent session',
        args: ['--continue'],
      },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    accent: '#4285f4',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
    ],
  },
  {
    id: 'goose',
    name: 'Goose',
    command: 'goose',
    accent: '#8fbf6a',
    acceptsFlags: true,
    modes: [
      {
        // `goose` alone configures and prints help; `goose session` is the
        // plain start, which is why the first mode is not argument-free.
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: ['session'],
      },
      {
        id: 'continue',
        label: 'Continue',
        hint: 'Reopen the most recent session',
        args: ['session', '--resume'],
      },
    ],
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    command: 'openclaw',
    accent: '#e0603c',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
    ],
  },
  {
    id: 'hermes',
    name: 'Hermes',
    command: 'hermes',
    accent: '#9b7fd4',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
    ],
  },
  {
    id: 'aider',
    name: 'Aider',
    command: 'aider',
    accent: '#59b3a9',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    accent: '#4e8df5',
    acceptsFlags: true,
    modes: [
      {
        id: 'new',
        label: 'New session',
        hint: 'Start fresh in this directory',
        args: [],
      },
      {
        id: 'continue',
        label: 'Continue',
        hint: 'Reopen the most recent conversation',
        args: ['--continue'],
      },
      // No picker flag: past conversations are reached with `/resume` in the TUI.
    ],
  },
]

/**
 * The user's own shell. It has no program of its own — the backend runs the
 * shell interactively — so there is nothing for flags to apply to.
 */
export const SHELL_AGENT: Agent = {
  id: 'shell',
  name: 'Shell',
  command: '',
  accent: '#7f8794',
  acceptsFlags: false,
  modes: [
    { id: 'new', label: 'Open shell', hint: 'Your default shell', args: [] },
  ],
}

/** Falls back to the first agent, so a stale saved id can never strand a tab. */
export function agentById(id: string): Agent {
  if (id === SHELL_AGENT.id) return SHELL_AGENT
  return AGENTS.find((agent) => agent.id === id) ?? AGENTS[0]
}

/**
 * The agent a picker may show as selected.
 *
 * The shell is deliberately absent from every picker: it has no program, takes
 * no flags and has a single mode, so listing it beside the agents makes the
 * list say untrue things about it — it gets its own control instead. But a
 * stored `defaultAgentId`, a restored tab and a resumed session can all still
 * carry `shell`, so `agentById` keeps resolving it while anything that has to
 * *display* a selection comes through here and never shows what it does not
 * offer.
 */
export function pickableAgent(id: string): Agent {
  const agent = agentById(id)
  return agent.id === SHELL_AGENT.id ? AGENTS[0] : agent
}

/**
 * What reopens one named conversation in this agent's own spelling, or `null`
 * when it has no resume mode.
 *
 * Built from the `resume` mode rather than a second table: that mode's
 * arguments are already the CLI's way of saying "reopen something", and every
 * agent that has one takes the id positionally after it.
 */
export function resumeArgs(agent: Agent, sessionId: string): string[] | null {
  if (!sessionId) return null
  const mode = agent.modes.find((candidate) => candidate.id === 'resume')
  return mode ? [...mode.args, sessionId] : null
}
