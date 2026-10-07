import {
  type CSSProperties,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'

import {
  clampLeft,
  dropIndex,
  edgeSpeed,
  isTornOff,
  offsets,
  type Slot,
} from './drag'

/** A drag past the threshold, as the strip renders it. */
interface Drag {
  id: string
  from: number
  to: number
  /** The dragged tab's left edge, in the strip's content coordinates. */
  left: number
  slots: Slot[]
  /** Released, and gliding into the slot it was dropped at. */
  settling: boolean
  /** Pulled far enough off the strip that releasing would take it out. */
  torn: boolean
}

/** Where a torn-off tab was held, for placing the window it lands in. */
export interface Grab {
  /** The point under the pointer once the tab leads a window of its own. */
  inNewWindow: { x: number; y: number }
  /** The point under the pointer in this window, for a lone tab carrying it. */
  inThisWindow: { x: number; y: number }
}

export interface TabDragHandlers {
  onMove(id: string, index: number): void
  /**
   * Released off the strip: the tab wants another window, or a new one. The
   * drag holds — the tab out of the strip — until this settles, so it does
   * not flash back into its place while it is being handed over.
   */
  onTearOff(id: string, grab: Grab): Promise<void>
  /**
   * The tab left the strip, or came back to it, or the drag ended off it.
   * `grab` places what follows the pointer.
   */
  onTornChange(id: string, torn: boolean, grab: Grab): void
}

/**
 * Chrome's tab drag: the tab follows the pointer, its neighbours slide aside
 * as it crosses them, and on release it glides into place before the deck is
 * reordered — so the strip never jumps. Pulled well off the strip, the tab is
 * torn off: its neighbours close up, and releasing it there hands it to
 * whatever window is under the pointer, or a new one.
 *
 * Nothing moves until the pointer has travelled a few pixels, so a click
 * selects as it always did, and pointer capture is taken only then, because
 * capturing on press would steal the click from the close button. Pointer
 * events rather than HTML drag and drop, because the native file drop this
 * app relies on keeps WebView2 from ever seeing `dragover`.
 */
export function useTabDrag(
  strip: RefObject<HTMLElement | null>,
  { onMove, onTearOff, onTornChange }: TabDragHandlers,
) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const abandon = useRef<(() => void) | null>(null)

  // The window listeners, frame and timer a drag holds outlive any render.
  useEffect(() => () => abandon.current?.(), [])

  const begin = (
    event: PointerEvent<HTMLElement>,
    id: string,
    from: number,
  ) => {
    const list = strip.current
    if (event.button !== 0 || !list || abandon.current) return

    const {
      pointerId,
      clientX: startX,
      clientY: startY,
      currentTarget: target,
    } = event
    let x = startX
    let y = startY
    let torn = false
    let slots: Slot[] | null = null
    let startScroll = 0
    let to = from
    let frame = 0
    let timer = 0

    const place = (measured: Slot[]) => {
      const was = torn
      // A window's only tab has no strip to stay in: any drag carries the
      // window, as in Chrome.
      torn =
        measured.length === 1 ||
        isTornOff(list.getBoundingClientRect(), viewport(), { x, y }, was)
      if (torn !== was) onTornChange(id, torn, grab(measured))
      const travelled = x - startX + list.scrollLeft - startScroll
      const left = clampLeft(measured, from, measured[from]!.left + travelled)
      // A torn-off tab is leaving, so the strip closes up behind it: the
      // others take the places they would have with it at the end.
      to = torn ? measured.length - 1 : dropIndex(measured, from, left)
      setDrag({ id, from, to, left, slots: measured, settling: false, torn })
    }
    const grab = (measured: Slot[]) =>
      grabOf({
        list,
        slots: measured,
        from,
        startScroll,
        press: { x: startX, y: startY },
      })

    const scrollAtEdge = (measured: Slot[]) => {
      if (torn) {
        frame = requestAnimationFrame(() => scrollAtEdge(measured))
        return
      }
      const before = list.scrollLeft
      list.scrollLeft += edgeSpeed(list.getBoundingClientRect(), x)
      if (list.scrollLeft !== before) place(measured)
      frame = requestAnimationFrame(() => scrollAtEdge(measured))
    }

    const onPointerMove = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== pointerId) return
      x = move.clientX
      y = move.clientY
      if (!slots) {
        // Either way: a tab pulled straight down is leaving the strip.
        if (Math.hypot(x - startX, y - startY) < THRESHOLD_PX) return
        slots = measure(list)
        startScroll = list.scrollLeft
        target.setPointerCapture(pointerId)
        const measured = slots
        frame = requestAnimationFrame(() => scrollAtEdge(measured))
      }
      place(slots)
    }

    const detach = () => {
      if (torn && slots) onTornChange(id, false, grab(slots))
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onCancel)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onBlur)
    }

    const finish = () => {
      abandon.current = null
      setDrag(null)
    }

    const settle = (index: number) => {
      detach()
      if (!slots) return finish()
      const left = slots[from]!.left + offsets(slots, from, index)[from]!
      setDrag({ id, from, to: index, left, slots, settling: true, torn: false })
      timer = window.setTimeout(() => {
        if (index !== from) onMove(id, index)
        finish()
      }, SETTLE_MS)
    }

    function onPointerUp(up: globalThis.PointerEvent) {
      if (up.pointerId !== pointerId) return
      if (!torn || !slots) return settle(to)
      detach()
      void onTearOff(id, grab(slots)).finally(finish)
    }

    function onCancel(cancel: globalThis.PointerEvent) {
      if (cancel.pointerId === pointerId) settle(from)
    }

    // A window that loses focus mid-drag — a system shortcut, a dialog — may
    // never see the release, and the tab would stay lifted.
    function onBlur() {
      settle(from)
    }

    // Claimed in the capture phase so the panel under the strip, which also
    // closes on Escape, does not close as well.
    function onKeyDown(key: KeyboardEvent) {
      if (key.key !== 'Escape' || !slots) return
      key.preventDefault()
      key.stopPropagation()
      settle(from)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onCancel)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onBlur)
    abandon.current = () => {
      detach()
      clearTimeout(timer)
    }
  }

  return {
    begin,
    draggingId: drag?.id ?? null,
    /**
     * Each tab's style, by position. Answers none while the strip no longer
     * matches what was measured — a tab closed mid-drag shifts every index,
     * and an index-keyed transform would then land on whichever tab slid in.
     */
    stylesFor: (ids: string[]) =>
      ids.map((_, index) =>
        drag && matches(drag, ids) ? dragStyle(drag, index) : undefined,
      ),
  }
}

const matches = (drag: Drag, ids: string[]) =>
  ids.length === drag.slots.length && ids[drag.from] === drag.id

/**
 * Neighbours always glide; the dragged tab tracks the pointer exactly and
 * glides only once released. When the drag ends every transform and
 * transition goes in the same render that reorders the deck, so nothing
 * animates from a stale offset.
 */
function dragStyle(drag: Drag, index: number): CSSProperties {
  const glide = `transform ${SETTLE_MS}ms ease-out`
  if (index === drag.from) {
    return {
      transform: `translateX(${drag.left - drag.slots[drag.from]!.left}px)`,
      transition: drag.settling ? glide : 'none',
      position: 'relative',
      zIndex: 1,
      // Gone from the strip once torn off — the label beside the pointer is
      // the tab now. A lone tab stays: its window is what moves.
      opacity: drag.torn && drag.slots.length > 1 ? 0 : undefined,
    }
  }
  const shift = offsets(drag.slots, drag.from, drag.to)[index] ?? 0
  return { transform: `translateX(${shift}px)`, transition: glide }
}

/**
 * Each tab's slot in the strip's scrolled content coordinates, at subpixel
 * precision — rounded widths would nudge tabs the drag never crossed.
 */
function measure(list: HTMLElement): Slot[] {
  const origin = list.getBoundingClientRect().left - list.scrollLeft
  return Array.from(
    list.querySelectorAll<HTMLElement>('[role="tab"]'),
    (tab) => {
      const rect = tab.getBoundingClientRect()
      return { left: rect.left - origin, width: rect.width }
    },
  )
}

const viewport = () => ({
  width: window.innerWidth,
  height: window.innerHeight,
})

/**
 * Where the pointer holds the tab: in the new window the tab leads the strip,
 * so the point is the same spot on the tab, moved to the first slot. Taken
 * from the slots measured before the drag, since the tab itself is still
 * wherever the drag carried it.
 */
function grabOf({
  list,
  slots,
  from,
  startScroll,
  press,
}: {
  list: HTMLElement
  slots: Slot[]
  from: number
  startScroll: number
  press: { x: number; y: number }
}): Grab {
  const origin = list.getBoundingClientRect().left
  const tabLeft = origin - startScroll + slots[from]!.left
  return {
    inNewWindow: { x: origin + slots[0]!.left + press.x - tabLeft, y: press.y },
    inThisWindow: press,
  }
}

/** How far a press may wander and still be a click. */
const THRESHOLD_PX = 5
/** One duration for the CSS glide and the timer that waits it out. */
const SETTLE_MS = 150
