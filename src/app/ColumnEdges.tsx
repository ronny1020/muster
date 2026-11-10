import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { followDrag } from '../shared/lib/followDrag'
import { movedEdge } from './edges'

export interface ColumnEdgesProps {
  /** The grid the columns are drawn in. */
  grid: RefObject<HTMLElement | null>
  /** Each column's width, in any unit: only the proportions are read. */
  widths: number[]
  /** The narrowest a drag may leave a column, in pixels. */
  min: number
  /** The widths to draw while a drag is under way, `null` once it ends. */
  onPreview: (widths: number[] | null) => void
  /** New widths, or `undefined` for equal ones. */
  onResize: (widths?: number[]) => void
}

/**
 * The edges between columns, as drag handles, as VS Code draws between
 * editor groups. A drag is drawn through `onPreview` and committed once, on
 * release: the deck is persisted on every change, and a write per frame would
 * be sixty a second.
 */
export function ColumnEdges({
  grid,
  widths,
  min,
  onPreview,
  onResize,
}: ColumnEdgesProps) {
  const { t } = useTranslation('chrome')
  /** The edge being dragged, once the pointer has moved. */
  const [dragging, setDragging] = useState<number | null>(null)
  const total = widths.reduce((sum, width) => sum + width, 0)

  const startDrag = (edge: number, event: PointerEvent) => {
    if (event.button !== 0 || !grid.current) return
    // Or the pointer starts a text selection in whatever is underneath.
    event.preventDefault()
    const start = trackWidths(grid.current)
    let next: number[] | null = null
    followDrag(event.clientX, {
      move: (delta) => {
        setDragging(edge)
        next = movedEdge(start, { edge, delta, min })
        onPreview(next)
      },
      end: (keep) => {
        setDragging(null)
        onPreview(null)
        if (keep && next) onResize(next)
      },
    })
  }

  // A handle you can focus but not move is worse than one you cannot focus.
  const nudge = (edge: number, event: KeyboardEvent) => {
    const step = KEY_STEPS[event.key]
    // A modified arrow is the app's own — `⌘⌥←` moves to another column.
    const modified = event.metaKey || event.ctrlKey || event.altKey
    if (!step || modified || !grid.current) return
    event.preventDefault()
    const delta = step * (event.shiftKey ? 4 : 1)
    onResize(movedEdge(trackWidths(grid.current), { edge, delta, min }))
  }

  return (
    <>
      {widths.slice(1).map((_, edge) => (
        <div
          key={edge}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('columnEdge', { left: edge + 1, right: edge + 2 })}
          aria-valuenow={Math.round((widths[edge] / total) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          title={t('dragEdge')}
          onPointerDown={(event) => startDrag(edge, event)}
          onDoubleClick={() => onResize()}
          onKeyDown={(event) => nudge(edge, event)}
          // Straddles the line between the columns, so the grab area is the
          // line you would aim at.
          style={{ gridColumn: edge + 1, gridRow: '1 / -1' }}
          className={`relative z-20 -mr-1 w-2 cursor-col-resize justify-self-end ${
            dragging === edge ? 'bg-primary/60' : 'hover:bg-primary/40'
          } focus-visible:bg-primary/60 focus-visible:outline-none`}
        />
      ))}
      {/* Keeps the resize cursor over the terminals, which would show xterm's
          text cursor, and stops the drag selecting their text. */}
      {dragging !== null && (
        <div
          aria-hidden="true"
          className="fixed inset-0 z-50 cursor-col-resize"
        />
      )}
    </>
  )
}

/** Each column's width as the grid laid it out, in pixels. */
const trackWidths = (grid: HTMLElement) =>
  getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat)

/** Arrow keys move the edge, in pixels. */
const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -16,
  ArrowRight: 16,
}
