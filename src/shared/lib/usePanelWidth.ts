import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useState,
} from 'react'

/**
 * A side panel's width, dragged by its edge and remembered.
 *
 * Remembered outside React because the panels unmount when closed — a width
 * held in component state would be forgotten every time you shut the panel,
 * which is the one thing a resizable panel must not do. It is a per-machine
 * convenience rather than a setting, so it lives in `localStorage` and never
 * appears in the settings pane.
 */

/** Narrower than this, a diff line or a commit subject is unreadable. */
export const MIN_WIDTH = 260

/** The terminal keeps at least a fifth of the window, whatever is stored. */
const MAX_SHARE = 0.8

export const maxWidth = (windowWidth: number) =>
  Math.max(MIN_WIDTH, Math.round(windowWidth * MAX_SHARE))

export function clampWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return MIN_WIDTH
  return Math.min(maxWidth(windowWidth), Math.max(MIN_WIDTH, Math.round(width)))
}

/**
 * The remembered width, repaired.
 *
 * Total, like every other load in this app: a hand-edited or stale value has
 * to come back as something usable, because a panel three pixels wide leaves
 * no edge to drag it back with.
 */
export function storedWidth(
  key: string,
  fallback: number,
  windowWidth: number,
): number {
  try {
    const raw = localStorage.getItem(key)
    return clampWidth(raw === null ? fallback : Number(raw), windowWidth)
  } catch {
    // Private browsing, or no storage at all.
    return clampWidth(fallback, windowWidth)
  }
}

export interface PanelWidth {
  width: number
  /** The widest the window currently allows, for the handle's `aria-valuemax`. */
  max: number
  /** True while a drag is in progress, for the cursor overlay. */
  dragging: boolean
  startDrag(event: ReactPointerEvent): void
  /** Keyboard resizing, in pixels; negative narrows. */
  nudge(step: number): void
  reset(): void
}

export function usePanelWidth(key: string, fallback: number): PanelWidth {
  const [width, setWidth] = useState(() =>
    storedWidth(key, fallback, window.innerWidth),
  )
  const [max, setMax] = useState(() => maxWidth(window.innerWidth))
  const [dragging, setDragging] = useState(false)

  const remember = useCallback(
    (value: number) => {
      setWidth(value)
      try {
        localStorage.setItem(key, String(value))
      } catch {
        /* private browsing or a full quota: this run keeps the width anyway */
      }
    },
    [key],
  )

  // A window narrowed past the stored width would leave the terminal no room
  // at all, and the panel is what has to give.
  useEffect(() => {
    const onResize = () => {
      setMax(maxWidth(window.innerWidth))
      setWidth((current) => clampWidth(current, window.innerWidth))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const startDrag = useCallback(
    (event: ReactPointerEvent) => {
      // Or the pointer starts a text selection in whatever is underneath.
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      // The panels are on the right, so dragging left widens them.
      let next = startWidth

      const move = (moved: globalThis.PointerEvent) => {
        next = clampWidth(
          startWidth + (startX - moved.clientX),
          window.innerWidth,
        )
        setWidth(next)
      }
      /**
       * Ends the drag, keeping the new width or putting the old one back.
       *
       * The width is written once, here: a write per frame would be sixty a
       * second. Anything that is not a completed drag reverts — a drag has no
       * other undo, and a panel dragged somewhere by accident is otherwise
       * remembered there.
       */
      const finish = (keep: boolean) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', commit)
        window.removeEventListener('pointercancel', revert)
        document.removeEventListener('keydown', onKeyDown, true)
        setDragging(false)
        if (keep) remember(next)
        else setWidth(startWidth)
      }
      const commit = () => finish(true)
      const revert = () => finish(false)
      /**
       * Escape cancels the drag, and nothing else.
       *
       * Captured on the document and stopped there, because the file column
       * also closes on Escape: without this, cancelling a drag of its edge
       * also shut the panel being resized.
       */
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        event.preventDefault()
        revert()
      }

      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', commit)
      // A drag the OS takes over — a window switch mid-drag — never sends
      // `pointerup`, and without this the listeners would outlive it.
      window.addEventListener('pointercancel', revert)
      document.addEventListener('keydown', onKeyDown, true)
      setDragging(true)
    },
    [remember, width],
  )

  const nudge = useCallback(
    (step: number) => remember(clampWidth(width + step, window.innerWidth)),
    [remember, width],
  )
  const reset = useCallback(
    () => remember(clampWidth(fallback, window.innerWidth)),
    [fallback, remember],
  )

  return { width, max, dragging, startDrag, nudge, reset }
}
