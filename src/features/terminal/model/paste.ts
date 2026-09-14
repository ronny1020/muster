/**
 * Whether a paste should reach the session as text or as a path.
 *
 * A paste arrives at a TUI as keystrokes, so a long log is delivered a line at
 * a time into an editor that reflows and re-tokenises as it goes. The agent
 * CLIs answer that by collapsing an oversized paste to a placeholder held in
 * memory — which is faster, but leaves nothing anyone can open afterwards.
 * Writing the text out and typing its path instead keeps the same gesture and
 * gives the agent something its file tools can read.
 */

/**
 * Past this many characters a paste becomes a file.
 *
 * Chosen to sit above anything typed or copied by hand — a long command, a
 * stack frame, a URL — and below the logs and diffs that are the reason this
 * exists.
 */
export const ATTACH_THRESHOLD = 5000

/** What to do with pasted text. */
export type PasteRoute =
  { kind: 'inline'; text: string } | { kind: 'attach'; text: string }

export function routePaste(
  text: string,
  threshold = ATTACH_THRESHOLD,
): PasteRoute {
  // Measured in characters rather than bytes: the threshold is about how much
  // a line editor is being asked to reflow, which is what the user sees.
  return text.length > threshold
    ? { kind: 'attach', text }
    : { kind: 'inline', text }
}
