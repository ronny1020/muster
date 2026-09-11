import { useEffect, useState } from 'react'

import { readImage } from '../ipc'

/**
 * The one decoded background, shared by every tab.
 *
 * Panes stay mounted while hidden, so without sharing, each tab would hold its
 * own multi-megabyte copy of the same image. Only one background is ever shown,
 * so this remembers exactly one: keyed by path so a change replaces it rather
 * than accumulating a `data:` URI per image ever picked.
 */
let decoded: { path: string; dataUrl: string } | null = null

/**
 * The read in flight, so concurrent callers share one.
 *
 * Panes stay mounted, so a new background starts this effect in every tab and
 * in the settings preview at once. Caching only the result let all of them read
 * and decode the same file — megabytes each — before the first finished.
 */
let loading: { path: string; image: Promise<string> } | null = null

/**
 * The background image as a `data:` URI, or empty when there is none.
 *
 * Read through Rust rather than pointed at with `file://`: the webview's CSP
 * allows `data:` images and little else, and the Rust side caps the size and
 * refuses anything that is not an image. A path that fails to load reads as no
 * background rather than as an error — there is nowhere in a wallpaper to
 * report one.
 */
export function useBackground(path: string): string {
  const [dataUrl, setDataUrl] = useState(() =>
    decoded?.path === path ? decoded.dataUrl : '',
  )

  useEffect(() => {
    if (!path) {
      setDataUrl('')
      return
    }
    if (decoded?.path === path) {
      setDataUrl(decoded.dataUrl)
      return
    }
    if (loading?.path !== path) {
      loading = {
        path,
        image: readImage(path).then(
          (preview) => {
            decoded = { path, dataUrl: preview.dataUrl }
            return preview.dataUrl
          },
          () => '',
        ),
      }
    }

    let cancelled = false
    void loading.image.then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [path])

  return dataUrl
}
