/**
 * Whether a quiet session is asking you something — a permission prompt, a
 * question, a trust dialog — rather than finished and waiting for a new task.
 *
 * Read off the bottom of the screen, because that is the one place every
 * agent shows it: a CLI that announces nothing still draws its dialog. A rule
 * matches only on the dialog's own footer or heading, so an agent whose prompt
 * nobody has written a rule for reads as waiting, never as asking — a false
 * "it needs you" costs more than a missed one. The wording follows herdr's
 * detection manifests (github.com/herdrdev/herdr, `src/detect/manifests`,
 * Apache-2.0), checked against Claude Code sessions recorded here.
 */

interface Rule {
  /** How many non-empty rows, counted up from the bottom, the rule reads. */
  rows: number
  /** Every one of these must appear. */
  all: string[]
  /** And at least one of these, when given. */
  any?: string[]
}

/** Footers that mean a list is waiting for a choice. */
const HERMES_FOOTERS = ['enter confirm', 'enter to confirm', '↑/↓ to select']

/** Lower case, since the CLIs change the case of their footers between releases. */
const RULES: Record<string, Rule[]> = {
  claude: [
    {
      rows: 12,
      all: ['esc to cancel'],
      any: [
        'tab to amend',
        'do you want to',
        'enter to confirm',
        'enter to select',
      ],
    },
  ],
  codex: [
    { rows: 3, all: ['action required'] },
    {
      rows: 12,
      all: [],
      any: [
        'press enter to confirm or esc to cancel',
        'enter to submit answer',
        'allow command?',
        'do you trust the contents of this directory?',
      ],
    },
    { rows: 12, all: ['would you like to'], any: ['1. yes', 'yes, proceed'] },
    { rows: 12, all: ['do you want to'], any: ['1. yes', 'yes, proceed'] },
  ],
  gemini: [
    {
      rows: 12,
      all: [],
      any: [
        '│ apply this change',
        '│ allow execution',
        'waiting for user confirmation',
        'do you want to proceed?',
      ],
    },
  ],
  opencode: [
    { rows: 12, all: ['△ permission required'] },
    {
      rows: 4,
      all: ['esc dismiss'],
      any: ['enter confirm', 'enter submit'],
    },
  ],
  hermes: [
    { rows: 14, all: ['dangerous'], any: HERMES_FOOTERS },
    { rows: 14, all: ['allow once'], any: HERMES_FOOTERS },
    { rows: 14, all: ['hermes needs your'] },
    { rows: 14, all: ['sudo password'], any: HERMES_FOOTERS },
  ],
  antigravity: [
    { rows: 2, all: ['navigate'], any: ['tab amend', 'esc skip'] },
    {
      rows: 8,
      all: ['do you trust the contents of this project?', 'enter confirm'],
    },
    {
      rows: 12,
      all: ['requesting permission for:', 'do you want to proceed?'],
    },
  ],
  aider: [{ rows: 1, all: ['(y)es/(n)o'] }],
}

/** Whether `screen`, the rows the terminal shows top to bottom, is a question. */
export function isAsking(agentId: string, screen: readonly string[]) {
  const rules = RULES[agentId]
  if (!rules) return false
  const filled = screen.filter((row) => row.trim() !== '')
  return rules.some((rule) => matches(rule, filled))
}

const matches = (rule: Rule, filled: readonly string[]) => {
  const text = filled.slice(-rule.rows).join('\n').toLowerCase()
  return (
    rule.all.every((needle) => text.includes(needle)) &&
    (!rule.any || rule.any.some((needle) => text.includes(needle)))
  )
}
