import { useEffect } from 'react'

import { revealItemInDir } from '@tauri-apps/plugin-opener'

import type { ImagePreview as Preview } from '../../../shared/ipc'
import { report } from '../../../shared/ipc'
import { formatBytes } from '../../../shared/lib/bytes'

export interface ImagePreviewProps {
  preview: Preview | null
  /** Set when the read failed, so the click is never silently ignored. */
  error: string | null
  onClose(): void
}

/**
 * Overlay for an image a terminal tab linked to. Sits above the pane rather
 * than in a separate window, so it closes as easily as it opened.
 */
export function ImagePreview({ preview, error, onClose }: ImagePreviewProps) {
  // Panes stay mounted for every tab, so an unconditional listener would put
  // one per tab on the window and fire them all on any Escape.
  const open = Boolean(preview) || Boolean(error)
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // Captured and stopped: this sits on top of the review column, which
      // also closes on Escape, and dismissing the overlay must not close what
      // it was covering.
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!preview && !error) return null

  return (
    <div
      // Clicking the backdrop closes; clicking the card must not.
      onClick={onClose}
      className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/70 p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full min-h-0 max-w-full flex-col overflow-hidden rounded-xl border border-line bg-chrome"
      >
        <header className="flex flex-none items-center gap-3 border-b border-line px-3 py-2">
          <span className="flex-1 truncate font-mono text-[11px] text-muted">
            {preview?.path ?? 'Could not open image'}
          </span>
          {preview && (
            <>
              <span className="flex-none text-[11px] text-faint">
                {formatBytes(preview.bytes)}
              </span>
              <button
                type="button"
                onClick={() => void revealItemInDir(preview.path).catch(report)}
                className="flex-none rounded px-1 text-[11px] text-muted hover:bg-surface-hover hover:text-ink"
              >
                Reveal
              </button>
            </>
          )}
          <button
            type="button"
            aria-label="Close preview"
            onClick={onClose}
            className="h-5 w-5 flex-none rounded text-muted hover:bg-surface-hover hover:text-ink"
          >
            ×
          </button>
        </header>

        {error ? (
          <p className="m-0 px-3 py-4 text-[11px] text-danger">{error}</p>
        ) : (
          // The checkerboard is what makes a transparent PNG readable.
          <div className="min-h-0 overflow-auto bg-[repeating-conic-gradient(#26262b_0%_25%,#1b1b1f_0%_50%)] bg-[length:16px_16px] p-4">
            <img
              src={preview!.dataUrl}
              alt={preview!.path}
              className="mx-auto block max-w-full object-contain"
            />
          </div>
        )}
      </div>
      <p className="m-0 text-[11px] text-faint">
        Esc or click outside to close
      </p>
    </div>
  )
}
