import {
  Fragment,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'

import {
  type Tab,
  tabDetail,
  tabLabel,
  tabSession,
  tabSignal,
} from '../../../entities/tab/model/deck'
import { useTranslation } from 'react-i18next'
import { runningAgent } from '../../../entities/agent/model/agents'
import { IS_MAC, IS_WINDOWS } from '../../../shared/lib/platform'
import { WindowControls } from '../../../shared/ui/WindowControls'
import { Icon } from '../../../shared/ui/Icon'
import { SHORTCUTS } from '../../../entities/preferences/model/shortcuts'
import { type Grab, useTabDrag } from '../model/useTabDrag'
import {
  ghostBeat,
  hideGhost,
  onDropHover,
  type Point,
  reportStrip,
  showGhost,
} from '../../../shared/ipc'
import { insertionIndex } from '../model/drag'
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu'

export interface TabStripProps {
  /** The column this strip heads, counted from the left. */
  column: number
  /** The rightmost column's strip, which reaches the window's corner. */
  last: boolean
  /** Whether the keyboard is in this column. */
  focused: boolean
  /** The window's only tab is in it, so dragging it carries the window. */
  lone: boolean
  /** Whether the window has room for another column. */
  canSplit: boolean
  /** This column's tabs, and the one it shows. */
  tabs: Tab[]
  activeId: string
  /** Where a tab dragged from another column would join this strip. */
  joinAt: number | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  /** A tab dragged, or moved by keyboard, to `index` of the strip. */
  onMove: (id: string, index: number) => void
  /** Takes a tab out into a window of its own, its session still running. */
  onMoveToNewWindow: (id: string) => void
  /**
   * A tab dragged off the strip and released; `grab` places its window. The
   * tab stays out of the strip until the returned promise settles.
   */
  onTearOff: (id: string, grab: Grab) => Promise<void>
  onOpen: () => void
  /** Opens a new column to the right: see the `split` deck action. */
  onSplit: () => void
  /** Moves a tab of this column into a new column to its right. */
  onMoveToNewColumn: (id: string) => void
  /** A torn-off tab is over `point`, or `null` once it is not. */
  onHover: (id: string, point: Point | null) => void
  /** A torn-off tab released inside the window; `true` if it was placed. */
  onDrop: (id: string, point: Point) => boolean
}

/** Chrome-style strip: tabs sit in the titlebar, active tab merges with the pane. */
export function TabStrip({
  column,
  last,
  focused,
  lone,
  canSplit,
  tabs,
  activeId,
  joinAt,
  onSelect,
  onClose,
  onMove,
  onMoveToNewWindow,
  onTearOff,
  onOpen,
  onSplit,
  onMoveToNewColumn,
  onHover,
  onDrop,
}: TabStripProps) {
  const { t } = useTranslation('chrome')
  const strip = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLElement>(null)
  /** Names this window's latest tear-off, so a hide can say which it ends. */
  const tearing = useRef(0)
  /** The heartbeat that keeps the drag label up — see `ghost.rs`. */
  const beating = useRef<ReturnType<typeof setInterval>>(undefined)
  // A strip that goes away mid-drag stops its heartbeat; the label follows.
  useEffect(() => () => clearInterval(beating.current), [])
  const drag = useTabDrag(strip, {
    bounds: header,
    lone,
    onMove,
    onTearOff,
    onHover,
    onDrop,
    onTornChange: (id, torn, grab) => {
      clearInterval(beating.current)
      const tab = tabs.find((entry) => entry.id === id)
      if (!torn || !tab) {
        return void hideGhost(tearing.current).catch(() => {})
      }
      // The time, not a count: the label is shared by every window, so the
      // numbers have to rise across all of them, and survive a reload.
      tearing.current = Math.max(tearing.current + 1, Date.now())
      void showGhost({
        title: tabLabel(tab, t),
        accent: accentOf(tab),
        lone,
        grab: lone ? grab.inThisWindow : null,
        drag: tearing.current,
      }).catch(() => {})
      beating.current = setInterval(
        () => void ghostBeat().catch(() => {}),
        BEAT_MS,
      )
    },
  })
  const fromWindow = useDropHover(column)
  const landing =
    joinAt === null
      ? fromWindow
      : { index: joinAt, accent: 'var(--color-primary)' }
  const dragStyles = drag.stylesFor(tabs.map((tab) => tab.id))
  const [menu, setMenu] = useState<{
    id: string
    at: { x: number; y: number }
  } | null>(null)

  // A column's only tab would leave an empty column behind it, and the
  // window's only tab an empty window.
  const menuItems = (id: string): MenuItem[] => [
    ...(tabs.length > 1 && canSplit
      ? [
          {
            label: t('tab.moveToNewColumn'),
            onSelect: () => onMoveToNewColumn(id),
          },
        ]
      : []),
    ...(lone
      ? []
      : [
          {
            label: t('tab.moveToNewWindow'),
            onSelect: () => onMoveToNewWindow(id),
          },
        ]),
    { label: t('tab.close'), onSelect: () => onClose(id) },
  ]

  // A tab reached by shortcut or by cycling can be scrolled out of sight, and
  // the strip scrolls rather than shrinking past 100px per tab.
  useEffect(() => {
    const list = strip.current
    const tab = list?.querySelector('[aria-selected="true"]')
    if (list && tab) revealIn(list, tab.getBoundingClientRect())
  }, [activeId, tabs.length])

  return (
    <header
      ref={header}
      data-tauri-drag-region
      data-column={column}
      onPointerDown={(event) => {
        if (!focused && event.button === 0 && isBare(event.target)) {
          onSelect(activeId)
        }
      }}
      style={{ gridColumn: column + 1, gridRow: 1, height: STRIP_PX }}
      className={`flex min-w-0 items-end gap-0.5 border-b border-line bg-chrome px-2 ${
        column > 0 ? 'border-l' : ''
      }`}
    >
      {/* Clears the macOS traffic lights, which sit inside the titlebar.
          Windows has no frame at all — this strip is its titlebar, so the
          caption buttons are drawn at the other end. Linux keeps its own
          decorations above the strip. */}
      {IS_MAC && column === 0 && (
        <div data-tauri-drag-region className="h-full w-[72px] flex-none" />
      )}

      <div
        ref={strip}
        role="tablist"
        className="flex min-w-0 [scrollbar-width:none] items-end gap-0.5 overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => (
          <Fragment key={tab.id}>
            {landing?.index === index && (
              <LandingMark accent={landing.accent} />
            )}
            <TabButton
              tab={tab}
              active={tab.id === activeId}
              focused={focused}
              dragging={drag.draggingId === tab.id}
              dragStyle={dragStyles[index]}
              onSelect={() => onSelect(tab.id)}
              onClose={() => onClose(tab.id)}
              onDragStart={(event) => drag.begin(event, tab.id, index)}
              onMenu={(event) => {
                event.preventDefault()
                setMenu({ id: tab.id, at: menuPoint(event) })
              }}
            />
          </Fragment>
        ))}
        {landing?.index === tabs.length && (
          <LandingMark accent={landing.accent} />
        )}
      </div>

      <button
        type="button"
        title={t('tab.newTabHint', { shortcut: SHORTCUTS.open })}
        aria-label={t('tab.newTab')}
        onClick={onOpen}
        className="mb-1 size-[26px] flex-none rounded-[7px] text-[17px] leading-none text-muted hover:bg-surface-hover hover:text-ink"
      >
        +
      </button>
      <button
        type="button"
        title={t('tab.splitRightHint', { shortcut: SHORTCUTS.splitRight })}
        aria-label={t('tab.splitRight')}
        disabled={!canSplit}
        onClick={onSplit}
        className="mb-1 flex size-[26px] flex-none items-center justify-center rounded-[7px] text-muted hover:bg-surface-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted"
      >
        <Icon name="splitscreen_right" className="size-4" />
      </button>

      <div data-tauri-drag-region className="h-full min-w-3 flex-1" />

      {/* Negative margin because a caption button reaches the window's corner:
          a gap there is dead space where Windows users throw the pointer to
          close. Settings lives in the status bar for the same reason — see
          `StatusBar`. */}
      {menu && (
        <ContextMenu
          at={menu.at}
          items={menuItems(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}

      {IS_WINDOWS && last && (
        <div className="-mr-2 h-full self-stretch">
          <WindowControls />
        </div>
      )}
    </header>
  )
}

interface TabButtonProps {
  tab: Tab
  active: boolean
  /** Whether its column has the keyboard; only there is the accent drawn. */
  focused: boolean
  dragging: boolean
  dragStyle: CSSProperties | undefined
  onSelect: () => void
  onClose: () => void
  onDragStart: (event: PointerEvent<HTMLElement>) => void
  onMenu: (event: MouseEvent<HTMLElement>) => void
}

/**
 * Scrolls `list` sideways just far enough to show all of `box`, and nothing
 * else: every column's strip shares one grid, which must never scroll.
 */
function revealIn(list: HTMLElement, box: DOMRect) {
  const view = list.getBoundingClientRect()
  if (box.left < view.left) list.scrollLeft -= view.left - box.left
  else if (box.right > view.right) list.scrollLeft += box.right - view.right
}

/**
 * Whether a press landed on the strip's bare chrome rather than a control in
 * it: there, selecting what the column already shows gives it the keyboard,
 * as a click on its pane does. Tabs and buttons do their own selecting.
 */
const isBare = (target: EventTarget) =>
  target instanceof Element &&
  target.matches('header, [data-tauri-drag-region], [role="tablist"]')

/** Well inside `ghost.rs`'s `SILENCE`, so a slow frame never drops the label. */
const BEAT_MS = 250

/**
 * Where a tab dragged from another window would join this strip, in the
 * colour of the agent that tab is running.
 */
function LandingMark({ accent }: { accent: string }) {
  return (
    <span
      aria-hidden="true"
      className="mb-1 h-[22px] w-0.5 flex-none rounded-full"
      style={{ background: accent }}
    />
  )
}

/**
 * The index a tab dragged from another window would join this strip at, or
 * `null` while none is over it.
 *
 * Cleared on the backend's word, and also when its updates stop: they arrive
 * every frame while a drag hovers, so a pause means the dragging window has
 * gone without saying so.
 */
function useDropHover(column: number) {
  const [landing, setLanding] = useState<{
    index: number
    accent: string
  } | null>(null)
  useEffect(() => {
    let stale: ReturnType<typeof setTimeout> | undefined
    const unlisten = onDropHover(({ x, accent }) => {
      clearTimeout(stale)
      const place = x === null ? null : stripPlaceAt(x)
      setLanding(
        place?.column === column ? { index: place.index, accent } : null,
      )
      if (x !== null) stale = setTimeout(() => setLanding(null), 500)
    })
    return () => {
      clearTimeout(stale)
      void unlisten.then((stop) => stop())
    }
  }, [column])
  return landing
}

/** A tab's colour: what it is running, or faint before it runs anything. */
const accentOf = (tab: Tab) => {
  const session = tabSession(tab)
  if (!session) return 'var(--color-faint)'
  return runningAgent(session.agentId, tab.handedBack)?.accent ?? session.accent
}

function TabButton({
  tab,
  active,
  focused,
  dragging,
  dragStyle,
  onSelect,
  onClose,
  onDragStart,
  onMenu,
}: TabButtonProps) {
  const { t } = useTranslation('chrome')
  const accent = accentOf(tab)
  const title = tabLabel(tab, t)
  const detail = tabDetail(tab, t)

  return (
    <div
      role="tab"
      aria-selected={active}
      title={detail ? `${title} · ${detail}` : title}
      onPointerDown={onDragStart}
      onContextMenu={onMenu}
      // The active tab takes keyboard focus, so the Menu key and `Shift+F10`
      // reach its menu.
      tabIndex={active ? 0 : -1}
      onMouseDown={(event) => {
        // A click must not take that focus, or it would leave the terminal
        // for the strip on every tab switch.
        event.preventDefault()
        if (event.button === 1) onClose()
        else if (event.button === 0) onSelect()
      }}
      className={`group flex h-[30px] max-w-[220px] min-w-[100px] items-center gap-1.5 rounded-t-[9px] pr-2 pl-2.5 select-none ${
        active
          ? 'bg-canvas text-ink'
          : `text-muted hover:text-ink ${dragging ? 'bg-surface-hover' : 'hover:bg-surface-hover'}`
      }`}
      style={{
        ...dragStyle,
        boxShadow: active && focused ? `inset 0 2px 0 ${accent}` : undefined,
      }}
    >
      <StatusDot tab={tab} accent={accent} />
      <span className="flex-1 truncate font-medium">{title}</span>
      {detail && (
        <span className="max-w-[88px] flex-initial truncate text-[11px] text-faint">
          {detail}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-label={t('tab.close')}
        // The tab selects on `mousedown`, which has already fired by the time
        // a click arrives — so stopping the click alone still left the tab
        // selected, and closing a background tab moved you off the one you
        // were working in. A press here must not begin a drag either.
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        className={`size-[18px] flex-none rounded-[5px] text-sm leading-none hover:bg-[#48484f] hover:opacity-100 ${
          active ? 'opacity-65' : 'opacity-0 group-hover:opacity-65'
        }`}
      >
        ×
      </button>
    </div>
  )
}

/**
 * A solid ring a pixel clear of the dot, drawn outside it with a negative
 * margin so the label does not shift. The ring is the only cue that tells
 * unread from waiting, so it is the accent at full strength, for 3:1 against
 * the strip (WCAG 1.4.11). It is a border so that it follows the dot's radius.
 */
const UNREAD_RING =
  '-m-0.5 box-content border border-solid p-px bg-clip-content'

/**
 * What the tab's agent is doing, in one dot.
 *
 * Working pulses, unread is ringed in the agent's accent, waiting is solid,
 * and anything else is grey unless the tree has uncommitted changes — an
 * agent that announces nothing stays grey rather than being called idle.
 * `title` alone would leave the state unreadable to a screen reader, so the
 * same words go in an `sr-only` span.
 */
function StatusDot({ tab, accent }: { tab: Tab; accent: string }) {
  const { t } = useTranslation('chrome')
  const signal = tabSignal(tab)
  const said = signal && t(`tab.${signal}`)

  return (
    <>
      <span
        aria-hidden="true"
        className={`size-1.5 flex-none rounded-full ${
          signal === 'working' ? 'animate-pulse' : ''
        } ${signal === 'unread' ? UNREAD_RING : ''}`}
        style={{
          // The longhand, so the ring's `bg-clip-content` survives.
          backgroundColor: signal || tab.dirty ? accent : '#48484f',
          borderColor: accent,
        }}
        title={said ?? undefined}
      />
      {said && <span className="sr-only">{said}</span>}
    </>
  )
}

/**
 * Where a tab's menu opens: at the pointer for a right click, under the tab
 * for the Menu key or `Shift+F10`, whose event carries no useful position.
 */
function menuPoint(event: MouseEvent<HTMLElement>) {
  if (event.button === 2) return { x: event.clientX, y: event.clientY }
  const box = event.currentTarget.getBoundingClientRect()
  return { x: box.left, y: box.bottom }
}

/** The height of every column's strip, which is the row they share. */
const STRIP_PX = 38

/**
 * Tells the backend where this window's strips are, so a tab dragged out of
 * another window can be dropped onto one — only this window's layout knows.
 * The box changes with the window's width and with zoom, and the backend
 * works out where it sits on screen at the drop itself. It is the row the
 * column headers share, along the top of `container`.
 */
export function useStripReport(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = container.current
    if (!element) return
    const report = () => {
      const box = element.getBoundingClientRect()
      void reportStrip({
        left: box.left,
        top: box.top,
        width: box.width,
        height: STRIP_PX,
      }).catch(() => {})
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => observer.disconnect()
  }, [container])
}

/** Where a tab would join the strip of the column `header` heads, at `x`. */
const indexIn = (header: Element, x: number) =>
  insertionIndex(
    Array.from(header.querySelectorAll('[role="tab"]'), (tab) => {
      const box = tab.getBoundingClientRect()
      return { left: box.left, width: box.width }
    }),
    x,
  )

/**
 * Which column's strip a tab dropped `x` CSS pixels along the window's top
 * joins, and where in it, read from the strips themselves.
 */
export function stripPlaceAt(x: number) {
  const headers = Array.from(
    document.querySelectorAll<HTMLElement>('header[data-column]'),
  )
  // The backend counts a margin around the strips as theirs, so `x` can lie
  // before the first header or past the last.
  const header =
    headers.find((entry) => x < entry.getBoundingClientRect().right) ??
    headers.at(-1)
  if (!header) return { column: 0, index: 0 }
  return { column: Number(header.dataset.column), index: indexIn(header, x) }
}

/**
 * Where a tab dragged within this window would land: a column's strip names
 * a slot in it, and a column's body one of three zones — its left or right
 * edge opens a new column on that side, its middle joins it. `null` off any
 * column.
 */
export type ColumnPlace =
  | { column: number; index: number }
  | { column: number; zone: 'left' | 'middle' | 'right' }

export function columnPlaceAt({ x, y }: Point): ColumnPlace | null {
  // The column under the point, looking through anything drawn over the
  // columns, such as the edges between them.
  const host = document
    .elementsFromPoint(x, y)
    .map((element) => element.closest<HTMLElement>('[data-column]'))
    .find(Boolean)
  if (!host) return null
  const column = Number(host.dataset.column)
  if (host.tagName === 'HEADER') return { column, index: indexIn(host, x) }
  const box = host.getBoundingClientRect()
  const along = (x - box.left) / box.width
  const zone = along < EDGE ? 'left' : along > 1 - EDGE ? 'right' : 'middle'
  return { column, zone }
}

/** How much of a column's width, at either side, splits rather than joins. */
const EDGE = 0.25
