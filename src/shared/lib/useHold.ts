import {
  type FocusEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'

import { useKeyChange } from './useKeyChange'

const OUTSIDE = { pointer: false, focus: false }

/**
 * Whether the pointer or focus is inside an element, while `enabled`. Pointer
 * and focus count separately: the mouse passing over and out must not end
 * what a keyboard user is still in, nor the reverse.
 *
 * An element removed from under the pointer or the focus sends no leave
 * event, and neither does a pane being hidden — so a hidden pane starts over,
 * and while inside, the document is watched for the pointer or focus turning
 * up anywhere else.
 */
export function useInside(enabled: boolean) {
  const [by, setBy] = useState(OUTSIDE)
  const box = useRef<HTMLDivElement | null>(null)
  useKeyChange([enabled], () => setBy(OUTSIDE))

  const entered = by.pointer || by.focus
  // The document is the outside thing: it is where the pointer or focus goes
  // when what held it was removed.
  useEffect(() => {
    if (!entered) return
    const recheck = (event: Event) => {
      const element = box.current
      const holds = (node: unknown) =>
        Boolean(element && node instanceof Node && element.contains(node))
      const focus = holds(document.activeElement)
      setBy((was) => {
        const pointer =
          event.type === 'pointerover' ? holds(event.target) : was.pointer
        // The same answer keeps the same object, so a keystroke typed into
        // the terminal beside a held corner re-renders nothing.
        return pointer === was.pointer && focus === was.focus
          ? was
          : { pointer, focus }
      })
    }
    // A key is how a keyboard user goes on after focus fell to the page,
    // which sends no `focusin`.
    const events = ['pointerover', 'focusin', 'keydown']
    for (const name of events) document.addEventListener(name, recheck, true)
    return () => {
      for (const name of events) {
        document.removeEventListener(name, recheck, true)
      }
    }
  }, [entered])

  const enter = (key: 'pointer' | 'focus') => () =>
    setBy((was) => (was[key] ? was : { ...was, [key]: true }))
  const leave =
    (key: 'pointer' | 'focus') => (event: FocusEvent | PointerEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && event.currentTarget.contains(next)) return
      setBy((was) => (was[key] ? { ...was, [key]: false } : was))
    }
  return {
    inside: enabled && entered,
    props: {
      ref: box,
      onPointerOver: enter('pointer'),
      onPointerOut: leave('pointer'),
      onFocus: enter('focus'),
      onBlur: leave('focus'),
    },
  }
}

/**
 * A snapshot of a live list, taken while `holding` and dropped as it ends,
 * so the list cannot move under a click or a keyboard user.
 *
 * `take` is told when the snapshot is taken by mounting into a hold already
 * under way: whatever it draws then appears under a pointer that is already
 * there, so a stack that would push others aside answers with nothing.
 */
export function useFrozen<T>(holding: boolean, take: (mounting: boolean) => T) {
  const [frozen, setFrozen] = useState<T | null>(() =>
    holding ? take(true) : null,
  )
  useKeyChange([holding], () => setFrozen(holding ? take(false) : null))
  return {
    frozen: holding ? frozen : null,
    /** Changes the snapshot, for a change asked for from inside it. */
    refreeze: (change: (frozen: T) => T) =>
      setFrozen((was) => (was === null ? was : change(was))),
  }
}
