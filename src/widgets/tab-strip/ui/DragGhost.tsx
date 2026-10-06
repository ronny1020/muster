import { useEffect, useState } from 'react'

import { ghostState, type GhostState, onGhost } from '../../../shared/ipc'

/** What a release would do, in the words the label shows under the title. */
const OUTCOME: Record<GhostState['over'], string> = {
  strip: 'Add to this window',
  window: 'Move this window',
  new: 'Open in a new window',
}

/** A drop shadow heavier than Tailwind's `shadow-lg`, since the label floats
 *  over other apps' windows; spelled out because the agent stripe is a
 *  box-shadow too, and a style replaces the class's shadow. */
const DROP_SHADOW =
  '0 10px 15px -3px rgb(0 0 0 / 0.4), 0 4px 6px -4px rgb(0 0 0 / 0.4)'

const readCurrent = async (show: (state: GhostState) => void) => {
  const state = await ghostState().catch(() => null)
  if (state) show(state)
}

/**
 * The whole page of the label window that follows a torn-off tab: the tab's
 * name, and what letting go here would do. The backend moves the window and
 * says what is under it; this only draws.
 */
export function DragGhost() {
  const [state, setState] = useState<GhostState | null>(null)

  // The backend's word, sent to this window alone — and asked for once, in
  // case it was said while this page was still loading.
  useEffect(() => {
    const unlisten = onGhost(setState)
    void readCurrent(setState)
    return () => void unlisten.then((stop) => stop())
  }, [])

  if (!state) return null
  const joining = state.over === 'strip'
  return (
    <div className="p-1.5">
      <div
        className={`flex max-w-[280px] items-center gap-2 rounded-[9px] border bg-chrome px-2.5 py-1.5 ${
          joining ? 'border-primary' : 'border-line'
        }`}
        style={{ boxShadow: `inset 0 2px 0 ${state.accent}, ${DROP_SHADOW}` }}
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 flex-none rounded-full"
          style={{ background: state.accent }}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">
            {state.title}
          </span>
          <span
            className={`block truncate text-[11px] ${
              joining ? 'text-primary' : 'text-muted'
            }`}
          >
            {OUTCOME[state.over]}
          </span>
        </span>
      </div>
    </div>
  )
}
