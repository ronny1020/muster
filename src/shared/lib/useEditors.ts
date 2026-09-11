import { useEffect, useState } from 'react'

import { type Editor, editors } from '../ipc'

/**
 * Editors this machine can launch. Detection costs a login shell, so it runs
 * once for the whole window rather than once per tab.
 */
let detected: Promise<Editor[]> | null = null

export function useEditors(): Editor[] {
  const [available, setAvailable] = useState<Editor[]>([])

  useEffect(() => {
    detected ??= editors().catch(() => [])
    let cancelled = false
    void detected.then((found) => !cancelled && setAvailable(found))
    return () => {
      cancelled = true
    }
  }, [])

  return available
}

/** The editor a tab should offer: the user's choice, else the best available. */
export function preferredEditor(
  available: Editor[],
  chosen: string,
): Editor | null {
  return (
    available.find((editor) => editor.command === chosen) ??
    available[0] ??
    null
  )
}
