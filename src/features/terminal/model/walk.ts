/**
 * Stepping a rail whose places have no rows.
 *
 * The scan's marks are walked by comparing the viewport to the row each one
 * sits on. A transcript's places have none — the agent owns its own scrolling
 * inside the alternate buffer and reports nothing about where its view sits —
 * so the position is remembered instead, and `count` itself is a position:
 * the live bottom, below every message, which is where an agent prints while
 * it is working.
 */

/** The key the rail draws a place under, and the one it fills. */
export const placeKey = (index: number) => `said-${index}`

/**
 * Where a press of ↑ (`-1`) or ↓ (`1`) takes a walk sitting at `at`.
 *
 * Clamped to the bottom rather than to the newest message: ↓ past the end of
 * the conversation is what returns the view to the live output, and a walk
 * that rested on the newest message left no way back to it.
 */
export const walkTo = ({
  at,
  count,
  direction,
}: {
  at: number
  count: number
  direction: -1 | 1
}) => Math.max(0, Math.min(count, at + direction))

/** Which key the rail fills, or null at the live bottom, below every place. */
export const walkedKey = (at: number, count: number) =>
  at < count ? placeKey(at) : null
