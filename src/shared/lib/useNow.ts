import { useEffect, useState } from 'react'

/**
 * The current time, advanced every `intervalMs`, for labels such as "3 minutes
 * ago" that have to keep counting while nothing else re-renders them.
 *
 * Read from state rather than from the clock while rendering, so a render is
 * a function of its inputs. Every pane stays mounted, so this ticks in hidden
 * tabs too: keep `intervalMs` at the label's own granularity, never finer.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  // The clock is the outside thing: the interval keeps `now` in step with it.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
