/**
 * Supported agent CLIs. Entries here are all the UI needs to gain another one.
 */
export interface LaunchMode {
  id: string
  label: string
  hint: string
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
