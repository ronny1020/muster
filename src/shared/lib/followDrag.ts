/**
 * Follows a pointer drag that began at `startX`, reporting how far it has
 * moved, until it ends. Releasing keeps the result; Escape, a cancelled
 * pointer and the window losing focus put it back, since a drag has no other
 * undo. A release outside the window may never arrive, so a move with no
 * button held ends the drag as a release would.
 *
 * Nothing is reported until the pointer has moved a few pixels, so a click —
 * one half of a double-click among them — is not a drag. A caller that draws
 * an overlay for the drag mounts it on the first `move`: mounted on the press,
 * it would take the release, and the double-click would never reach the edge.
 *
 * Escape is claimed in the capture phase and stopped there: the panels being
 * dragged also close on Escape, and cancelling the drag must not close them.
 */
export function followDrag(
  startX: number,
  { move, end }: { move: (dx: number) => void; end: (keep: boolean) => void },
) {
  let moved = false
  const onMove = (event: PointerEvent) => {
    if (event.buttons === 0) return finish(true)
    const dx = event.clientX - startX
    if (!moved && Math.abs(dx) < CLICK_SLOP_PX) return
    moved = true
    move(dx)
  }
  const commit = () => finish(true)
  const revert = () => finish(false)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    revert()
  }
  function finish(keep: boolean) {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', commit)
    window.removeEventListener('pointercancel', revert)
    window.removeEventListener('blur', revert)
    document.removeEventListener('keydown', onKeyDown, true)
    end(keep)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', commit)
  window.addEventListener('pointercancel', revert)
  window.addEventListener('blur', revert)
  document.addEventListener('keydown', onKeyDown, true)
}

/** How far a press may wander and still be a click, in pixels. */
const CLICK_SLOP_PX = 3
