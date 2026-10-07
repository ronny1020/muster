import type { LinkMeta } from '../../../shared/ipc'

/** How many pages' previews are kept, newest last. */
const KEPT = 64

/**
 * One fetch per address for the life of the window: hovering back and forth
 * over a link redraws the preview at once instead of loading it again. A
 * failed fetch is forgotten, so the next hover tries again.
 */
export function previewCache(fetch: (url: string) => Promise<LinkMeta>) {
  const kept = new Map<string, Promise<LinkMeta>>()
  return (url: string) => {
    const known = kept.get(url)
    if (known) {
      kept.delete(url)
      kept.set(url, known)
      return known
    }
    const pending = fetch(url)
    kept.set(url, pending)
    pending.catch(() => {
      if (kept.get(url) === pending) kept.delete(url)
    })
    if (kept.size > KEPT) kept.delete(kept.keys().next().value!)
    return pending
  }
}
