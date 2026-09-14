import { useEffect, useRef, useState } from 'react'

import { isWindowMaximized, onWindowResized, report } from '../ipc'

/**
 * Whether the window fills the screen, which decides one caption glyph.
 *
 * Read from the window, never remembered from the click: a double-click on the
 * drag region, the shortcut and the snap gestures all maximize without passing
 * through the button. A live resize reads once per frame, so only the newest
 * reply may write, or the glyph describes a state the window has left.
 */
export function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  const latest = useRef(0)

  useEffect(() => {
    let live = true
    const sync = () => {
      const mine = (latest.current += 1)
      void isWindowMaximized()
        .then((is) => {
          if (live && latest.current === mine) setMaximized(is)
        })
        .catch(report)
    }

    sync()
    const stopping = onWindowResized(sync).catch(report)
    return () => {
      live = false
      void stopping.then((stop) => stop?.())
    }
  }, [])

  return maximized
}
