import { MIN_WIDTH, type PanelWidth } from '../lib/usePanelWidth'

export interface DragEdgeProps {
  size: PanelWidth
  /** Names the panel this resizes, for screen readers and the tooltip. */
  label: string
}

/**
 * A right-hand panel's left edge, as a drag handle.
 *
 * Half of it sits outside the panel, over the border, so the grab area is the
 * line you would aim at. The overlay exists only during a drag: it keeps the
 * resize cursor while the pointer is over the terminal, which would otherwise
 * show xterm's text cursor, and it stops the drag selecting the terminal's text
 * on the way past.
 *
 * The panel must be `relative` for this to sit on its edge.
 */
export function DragEdge({ size, label }: DragEdgeProps) {
  return (
    <>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={size.width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={size.max}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={size.startDrag}
        onDoubleClick={size.reset}
        onKeyDown={(event) => {
          // A handle you can focus but not move is worse than one you cannot
          // focus at all.
          const step = KEY_STEPS[event.key]
          if (!step) return
          event.preventDefault()
          size.nudge(step * (event.shiftKey ? 4 : 1))
        }}
        className={`absolute top-0 -left-1 z-10 h-full w-2 cursor-col-resize ${
          size.dragging ? 'bg-brand/60' : 'hover:bg-brand/40'
        } focus-visible:bg-brand/60 focus-visible:outline-none`}
      />
      {size.dragging && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-50 cursor-col-resize"
        />
      )}
    </>
  )
}

/** Arrow keys move the edge; the panel is on the right, so left widens it. */
const KEY_STEPS: Record<string, number> = {
  ArrowLeft: 16,
  ArrowRight: -16,
}
