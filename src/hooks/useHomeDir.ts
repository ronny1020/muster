import { useEffect, useState } from 'react'

import { homeDir } from '../ipc'

/** The user's home directory, fetched once for the whole window. */
let cached: Promise<string> | null = null

export function useHomeDir(): string {
  const [home, setHome] = useState('')

  useEffect(() => {
    cached ??= homeDir().catch(() => '')
    let cancelled = false
    void cached.then((value) => !cancelled && setHome(value))
    return () => {
      cancelled = true
    }
  }, [])

  return home
}
