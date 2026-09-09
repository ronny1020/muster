import { useEffect, useState } from 'react'

import { type PlatformInfo, platformInfo } from '../platform'

/** Asked once and shared: the host does not change while the app is open. */
let pending: Promise<PlatformInfo> | null = null

/**
 * Host facts only the backend knows — whether WSL is installed and which
 * distros it has. `null` until the first answer arrives, which is why every
 * consumer treats the host as plain until then.
 */
export function usePlatform(): PlatformInfo | null {
  const [info, setInfo] = useState<PlatformInfo | null>(null)

  useEffect(() => {
    let live = true
    pending ??= platformInfo()
    void pending.then((next) => live && setInfo(next)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  return info
}
