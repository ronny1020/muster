/** Where a tab sits in the strip, in the strip's scrolled content coordinates. */
export interface Slot {
  left: number
  width: number
}

/**
 * The index a dragged tab would land at: past every neighbour whose centre its
 * leading edge has crossed, which is when Chrome slides one aside. The edge
 * rather than the tab's own centre, so a tab wider than the one at either end
 * can still reach it once clamped there.
 */
export function dropIndex(slots: Slot[], from: number, left: number): number {
  const right = left + slots[from]!.width
  let index = from
  slots.forEach((slot, other) => {
    const centre = slot.left + slot.width / 2
    if (other > from && right >= centre) index += 1
    if (other < from && left <= centre) index -= 1
  })
  return index
}

/**
 * How far each tab sits from its own slot when the tab at `from` is dropped at
 * `to`. Laid out afresh rather than shifted by the dragged width, because tabs
 * differ in width and the gap between them has to survive the move.
 */
export function offsets(slots: Slot[], from: number, to: number): number[] {
  const first = slots[0]
  if (!first) return []
  const gap = slots[1] ? slots[1].left - first.left - first.width : 0

  const order = slots.map((_, index) => index)
  order.splice(from, 1)
  order.splice(to, 0, from)

  const result = slots.map(() => 0)
  let x = first.left
  for (const index of order) {
    const slot = slots[index]!
    result[index] = x - slot.left
    x += slot.width + gap
  }
  return result
}

/** Keeps a dragged tab inside the strip, as Chrome does until it tears off. */
export function clampLeft(slots: Slot[], from: number, left: number): number {
  const first = slots[0]!
  const last = slots.at(-1)!
  const max = last.left + last.width - slots[from]!.width
  return Math.min(Math.max(left, first.left), max)
}

/**
 * Pixels per frame to scroll a strip whose pointer is held near either edge —
 * faster the deeper it goes, so a long strip can be crossed without waiting.
 */
export function edgeSpeed(edges: { left: number; right: number }, x: number) {
  const depth =
    x < edges.left + EDGE_PX
      ? x - edges.left - EDGE_PX
      : x > edges.right - EDGE_PX
        ? x - edges.right + EDGE_PX
        : 0
  return Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Math.trunc(depth / 3)))
}

/**
 * Whether a dragged tab is off the strip: pulled past `TEAR_PX` above or below
 * it, or out of the window altogether. Coming back takes `RETURN_PX` — closer
 * than leaving — so a hand that wavers at the threshold does not tear the tab
 * off and put it back on every move.
 */
export function isTornOff(
  strip: { top: number; bottom: number },
  viewport: { width: number; height: number },
  point: { x: number; y: number },
  wasTorn: boolean,
) {
  const outside =
    point.x < 0 ||
    point.y < 0 ||
    point.x > viewport.width ||
    point.y > viewport.height
  const reach = wasTorn ? RETURN_PX : TEAR_PX
  return (
    outside || point.y < strip.top - reach || point.y > strip.bottom + reach
  )
}

/**
 * The index at which a tab dropped `x` CSS pixels along a strip joins it:
 * before the first tab whose middle is past the drop, as Windows Terminal
 * places a tab dropped onto it.
 */
export function insertionIndex(slots: Slot[], x: number) {
  const index = slots.findIndex((slot) => x < slot.left + slot.width / 2)
  return index < 0 ? slots.length : index
}

/** Where a tab dropped `x` CSS pixels along this window's strip joins it. */
export function stripIndexAt(x: number) {
  const tabs = document.querySelectorAll<HTMLElement>(
    '[role="tablist"] [role="tab"]',
  )
  const slots = Array.from(tabs, (tab) => {
    const box = tab.getBoundingClientRect()
    return { left: box.left, width: box.width }
  })
  return insertionIndex(slots, x)
}

const TEAR_PX = 30
const RETURN_PX = 18
const EDGE_PX = 32
const MAX_SPEED = 16
