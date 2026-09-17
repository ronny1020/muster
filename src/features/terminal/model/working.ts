/**
 * Whether a session is working, judged by whether it is still printing.
 *
 * Nothing is asked of the agent: every CLI writes to the pty while it thinks,
 * and stops when it wants you. That is the only signal every agent and every
 * shell has in common — what a CLI *announces* about itself is a different
 * channel, and on this machine only one agent has ever used it.
 */

/**
 * How long a session must be silent before it counts as no longer working.
 *
 * Long enough to bridge the pause between a spinner frame and the next chunk
 * of a reply, short enough that the tab stops claiming to be busy while you
 * are reading the answer.
 */
export const QUIET_MS = 600

/** Whether output has arrived recently enough to still count as working. */
export const isWorking = (lastOutputAt: number, now: number) =>
  now - lastOutputAt < QUIET_MS
