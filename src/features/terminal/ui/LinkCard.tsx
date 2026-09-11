import { useEffect } from 'react'

import { openUrl } from '@tauri-apps/plugin-opener'

import type { LinkMeta } from '../../../shared/ipc'
import { report } from '../../../shared/ipc'

export interface LinkCardProps {
  /** The URL being previewed, known before the fetch returns. */
  url: string | null
  meta: LinkMeta | null
  error: string | null
  onClose(): void
}

/**
 * Preview card for a URL clicked in terminal output: what the page says about
 * itself, and a way to actually open it.
 */
export function LinkCard({ url, meta, error, onClose }: LinkCardProps) {
  // Panes stay mounted for every tab, so an unconditional listener would put
  // one per tab on the window and fire them all on any Escape.
  const open = Boolean(url)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!url) return null

  return (
    <div
      onClick={onClose}
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex w-[min(460px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-chrome"
      >
        {meta?.imageDataUrl && (
          <img
            src={meta.imageDataUrl}
            alt=""
            className="max-h-[240px] w-full border-b border-line object-cover"
          />
        )}

        <div className="flex flex-col gap-1.5 p-3">
          <span className="truncate text-[11px] text-faint">
            {meta?.siteName ?? hostOf(url)}
          </span>

          {error ? (
            <p className="m-0 text-[11px] text-danger">{error}</p>
          ) : meta ? (
            <>
              <strong className="text-[13px] leading-snug text-ink">
                {meta.title ?? url}
              </strong>
              {meta.description && (
                <p className="m-0 line-clamp-4 text-[11px] leading-relaxed text-muted">
                  {meta.description}
                </p>
              )}
            </>
          ) : (
            <p className="m-0 text-[11px] text-faint">Reading the page…</p>
          )}

          <span className="truncate font-mono text-[10px] text-faint">
            {url}
          </span>

          <div className="mt-1 flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                void openUrl(url).catch(report)
                onClose()
              }}
              className="h-7 flex-1 rounded-lg border border-line bg-surface text-xs hover:bg-surface-hover"
            >
              Open in browser
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-7 rounded-lg border border-line bg-surface px-3 text-xs text-muted hover:bg-surface-hover hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** The host, for the line above the title before metadata arrives. */
function hostOf(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0]
}
