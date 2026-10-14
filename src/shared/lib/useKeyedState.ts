import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * State that belongs to one input: it reads as `empty` until a value is set
 * for the current input.
 *
 * An async read passes the input it was asked about along with what it
 * writes, and a write for any input but the current one is dropped — so a
 * reply that lands after the input moved is never shown and never displaces
 * the current value, whenever it lands. `input` is compared by value, so its
 * parts must be plain data. Call the setter from a passive effect, a handler
 * or an async continuation: a child's layout effect runs before this hook
 * records the new input, so a write from there is dropped.
 */
export function useKeyedState<T>(
  input: readonly unknown[],
  empty: T,
): [T, (forInput: readonly unknown[], value: T) => void] {
  const key = JSON.stringify(input)
  const [held, setHeld] = useState<{ key: string; value: T } | null>(null)
  // Recorded in the commit that changes the input, before any later task can
  // deliver a reply for the old one.
  const current = useRef(key)
  useLayoutEffect(() => {
    current.current = key
  }, [key])
  const set = useCallback((forInput: readonly unknown[], value: T) => {
    const forKey = JSON.stringify(forInput)
    if (forKey === current.current) setHeld({ key: forKey, value })
  }, [])
  return [held?.key === key ? held.value : empty, set]
}
