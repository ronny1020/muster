import type { Turn } from '../../../shared/ipc'

/**
 * What the rail and the step buttons show, from whichever source has it.
 *
 * The terminal's own scan produces rows; a transcript produces turns. Both
 * reduce to this, so the surfaces that draw them need to know which they got
 * only where the click is handled.
 */
export interface Place {
  /** One line, as the rail's tooltip and a screen reader read it. */
  label: string
  /** The whole message. Empty for a file. */
  text: string
  /** Absolute path, for a file. Empty for a message. */
  path: string
  /** The agent's own timestamp, as it wrote it. */
  at: string
}

/**
 * How many of each kind to keep, newest last.
 *
 * The rail's own height at the window's 420px floor, the same bound and the
 * same reason as `MAX_MARKS` for the scan's marks: past a dozen the oldest
 * dot is clipped while the step buttons still walk the list, so one press
 * per dot would quietly stop being true.
 */
export const MAX_PLACES = 12

const placeOf = (turn: Turn): Place => ({
  label: turn.label,
  text: turn.text,
  path: turn.path,
  at: turn.at,
})

/** The messages a transcript holds, oldest first, newest kept. */
export const messagesIn = (turns: Turn[]): Place[] =>
  turns
    .filter((turn) => turn.kind === 'message')
    .slice(-MAX_PLACES)
    .map(placeOf)
