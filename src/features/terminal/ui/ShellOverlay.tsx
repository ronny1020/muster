import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

import type { Terminal } from '@xterm/xterm'

import type { ResolvedBlock, ShellSurface } from './useShellBlocks'
import { completionFor } from '../model/suggest'
import type { Settings } from '../../../entities/preferences/model/settings'

/**
 * What is drawn over a shell session's grid: what the prompt could become, and
 * the control that copies a command's output.
 *
 * Both need the same measurement, which is why they are one component. The
 * WebGL renderer paints the grid onto a canvas, so there is no element for a
 * row or a cell — the size of one is the screen's own box divided by the grid,
 * the same way `resyncScrollbar` reads a row's height.
 */
export interface ShellOverlayProps {
  /** The element xterm was opened in; the grid is measured out of it. */
  host: RefObject<HTMLDivElement | null>
  /**
   * The pane the grid and this overlay both sit in.
   *
   * The pointer is followed here rather than on the host: the copy control is
   * this overlay's child, not the host's, so moving onto it leaves the host —
   * and a control that vanishes as the pointer reaches it cannot be clicked.
   */
  surface: RefObject<HTMLDivElement | null>
  shell: ShellSurface
  /** The buffer row at the top of the screen, so a mark can be placed. */
  viewportRow: number
  /**
   * The terminal itself, read for the grid's shape.
   *
   * Read from the object rather than taken as numbers: a resize changes
   * `cols` and `rows` on it without re-rendering anything here, so a measure
   * taken from props would use the shape the pane had at the last render and
   * map the pointer to the wrong row.
   */
  term: Terminal
  settings: Settings
  onCopy(block: ResolvedBlock): void
  /** Set while the last copy is still worth confirming. */
  copied: boolean
}

interface Cell {
  width: number
  height: number
}

export function ShellOverlay({
  host,
  surface,
  shell,
  viewportRow,
  term,
  settings,
  onCopy,
  copied,
}: ShellOverlayProps) {
  const cell = useCellSize(host, term)
  const hovered = useHoveredBlock(surface, host, shell, viewportRow, cell)
  const { suggestions } = shell
  const completion =
    suggestions && shell.selected === -1
      ? completionFor(suggestions.typed, suggestions.matches)
      : null
  const grid =
    cell &&
    ({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      letterSpacing: settings.letterSpacing,
      lineHeight: `${cell.height}px`,
    } satisfies CSSProperties)

  return (
    <div className="pointer-events-none absolute inset-2 overflow-hidden">
      {cell && grid && suggestions && completion && (
        <span
          // Not a label and not interactive: it is the rest of the line the
          // reader is already reading, so a screen reader announcing it would
          // read the line twice. The list below carries the announcement.
          aria-hidden="true"
          className="absolute whitespace-pre text-faint"
          style={{
            ...grid,
            left: suggestions.at.col * cell.width,
            top: (suggestions.at.row - viewportRow) * cell.height,
            height: cell.height,
          }}
        >
          {completion}
        </span>
      )}
      {cell && grid && suggestions && (
        <SuggestionList
          shell={shell}
          suggestions={suggestions}
          cell={cell}
          grid={grid}
          viewportRow={viewportRow}
          rows={term.rows}
        />
      )}
      {cell && hovered && (
        <button
          type="button"
          onClick={() => onCopy(hovered.block)}
          title={hovered.label}
          aria-label={hovered.label}
          className="pointer-events-auto absolute right-5 z-10 rounded border border-line bg-chrome/95 px-1.5 py-0.5 font-mono text-[10px] text-muted backdrop-blur hover:border-brand hover:text-ink"
          style={{
            top: Math.max(
              0,
              (hovered.block.input.row - viewportRow) * cell.height,
            ),
          }}
        >
          {copied ? 'Copied' : 'Copy output'}
        </button>
      )}
      <span className="sr-only" role="status">
        {copied ? 'Output copied to the clipboard' : ''}
      </span>
    </div>
  )
}

/**
 * The past commands the prompt could become, under the cursor.
 *
 * Anchored to the prompt's own column so the rows line up with what is being
 * typed, and flipped above the cursor when there is no room below — a list
 * that runs off the bottom of the pane shows its newest match and hides the
 * rest.
 */
function SuggestionList({
  shell,
  suggestions,
  cell,
  grid,
  viewportRow,
  rows,
}: {
  shell: ShellSurface
  suggestions: NonNullable<ShellSurface['suggestions']>
  cell: Cell
  grid: CSSProperties
  viewportRow: number
  rows: number
}) {
  const cursorRow = suggestions.at.row - viewportRow
  const below = rows - cursorRow - 1
  const flip = below < suggestions.matches.length
  const height = suggestions.matches.length * cell.height
  return (
    <>
      <div
        role="listbox"
        aria-label="Past commands that start this way"
        className="pointer-events-auto absolute z-10 max-w-[80%] overflow-hidden rounded border border-line bg-chrome/95 shadow-lg backdrop-blur"
        style={{
          ...grid,
          left: Math.max(0, suggestions.at.col * cell.width - cell.width),
          top: flip
            ? Math.max(0, cursorRow * cell.height - height)
            : (cursorRow + 1) * cell.height,
        }}
      >
        {suggestions.matches.map((match, index) => (
          <button
            key={match}
            type="button"
            role="option"
            aria-selected={index === shell.selected}
            onClick={() => shell.accept(index)}
            className={`block w-full truncate px-2 text-left whitespace-pre ${
              index === shell.selected
                ? 'bg-surface-hover text-ink'
                : 'text-muted hover:bg-surface-hover hover:text-ink'
            }`}
            style={{ height: cell.height }}
          >
            <span className="text-faint">{suggestions.typed}</span>
            {match.slice(suggestions.typed.length)}
          </button>
        ))}
      </div>
      <span className="sr-only" role="status">
        {`${suggestions.matches.length} past commands start with ${suggestions.typed}`}
      </span>
    </>
  )
}

/**
 * One cell's size, from the screen's own box.
 *
 * Re-measured whenever that box changes, which covers both ways it can: the
 * pane being resized, and the font or its spacing changing under a grid of the
 * same shape.
 */
function useCellSize(
  host: RefObject<HTMLDivElement | null>,
  term: Terminal,
): Cell | null {
  const [cell, setCell] = useState<Cell | null>(null)

  useLayoutEffect(() => {
    const screen = host.current?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen) return
    const measure = () => {
      const { cols, rows } = term
      const width = screen.offsetWidth
      const height = screen.offsetHeight
      if (width === 0 || height === 0 || cols === 0 || rows === 0) return
      setCell((previous) => {
        const next = { width: width / cols, height: height / rows }
        return previous &&
          previous.width === next.width &&
          previous.height === next.height
          ? previous
          : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(screen)
    return () => observer.disconnect()
  }, [host, term])

  return cell
}

interface Hovered {
  block: ResolvedBlock
  label: string
}

/**
 * The command block under the pointer, or `null`.
 *
 * Followed on the pane rather than on the grid, because the control this
 * offers is drawn over the grid rather than inside it: a listener on the grid
 * sees the pointer *leave* as it reaches the control, and the control it was
 * reaching for goes with it.
 *
 * State is set only when the block under the pointer changes, so moving
 * across one command's output costs nothing.
 */
function useHoveredBlock(
  surface: RefObject<HTMLDivElement | null>,
  host: RefObject<HTMLDivElement | null>,
  shell: ShellSurface,
  viewportRow: number,
  cell: Cell | null,
): Hovered | null {
  const [hovered, setHovered] = useState<Hovered | null>(null)
  // Read through a ref, not a dependency: both change on every write batch —
  // the suggestions as they are typed, the viewport as the session prints —
  // and re-registering a pointer listener that often is one churned per
  // keystroke.
  const latest = useRef({ shell, viewportRow })
  latest.current = { shell, viewportRow }

  useEffect(() => {
    const pane = surface.current
    const grid = host.current
    if (!pane || !grid || !cell) return
    const onMove = (event: PointerEvent) => {
      const { shell, viewportRow } = latest.current
      const box = grid.getBoundingClientRect()
      const row =
        viewportRow + Math.floor((event.clientY - box.top) / cell.height)
      const block = shell.blockAt(row)
      setHovered((previous) => {
        // Only a finished command has an output to copy; one still printing
        // would offer a control whose click copied half of it.
        if (!block?.end) return previous === null ? previous : null
        if (previous?.block.key === block.key) return previous
        const command = block.command
        return {
          block,
          label: command ? `Copy the output of ${command}` : 'Copy this output',
        }
      })
    }
    const onLeave = () => setHovered(null)
    pane.addEventListener('pointermove', onMove)
    pane.addEventListener('pointerleave', onLeave)
    return () => {
      pane.removeEventListener('pointermove', onMove)
      pane.removeEventListener('pointerleave', onLeave)
    }
  }, [surface, host, cell])

  return hovered
}
