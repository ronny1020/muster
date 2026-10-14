import { useState } from 'react'

/**
 * Calls `adjust` while rendering whenever one of `keys` differs from the last
 * render's — React's way to reset state when an input changes.
 *
 * It lands in the same render, so nothing is ever drawn with state belonging
 * to the previous input; an effect doing the same would show it for a frame.
 * `adjust` may only set this component's own state.
 */
export function useKeyChange(keys: readonly unknown[], adjust: () => void) {
  const [seen, setSeen] = useState(keys)
  const changed =
    seen.length !== keys.length ||
    seen.some((key, index) => !Object.is(key, keys[index]))
  if (changed) {
    setSeen(keys)
    adjust()
  }
}
