import {
  Fragment,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'

import { type Tab, tabSession } from '../../../entities/tab/model/deck'
import { SHELL_AGENT } from '../../../entities/agent/model/agents'
import { IS_MAC, IS_WINDOWS } from '../../../shared/lib/platform'
import { WindowControls } from '../../../shared/ui/WindowControls'
import { SHORTCUTS } from '../../../entities/preferences/model/shortcuts'
import { type Grab, useTabDrag } from '../model/useTabDrag'
import {
  ghostBeat,
  hideGhost,
  onDropHover,
  reportStrip,
  showGhost,
} from '../../../shared/ipc'
import { stripIndexAt } from '../model/drag'
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu'

export interface TabStripProps {
  tabs: Tab[]
  activeId: string
  onSelect(id: string): void
  onClose(id: string): void
  /** A tab dragged, or moved by keyboard, to `index` of the strip. */
  onMove(id: string, index: number): void
  /** Takes a tab out into a window of its own, its session still running. */
  onMoveToNewWindow(id: string): void
  /**
   * A tab dragged off the strip and released; `grab` places its window. The
   * tab stays out of the strip until the returned promise settles.
   */
  onTearOff(id: string, grab: Grab): Promise<void>
  onOpen(): void
}

/** Chrome-style strip: tabs sit in the titlebar, active tab merges with the pane. */
export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onMove,
  onMoveToNewWindow,
  onTearOff,
  onOpen,
}: TabStripProps) {
  const strip = useRef<HTMLDivElement>(null)
  const header = useRef<HTMLElement>(null)
  /** Names this window's latest tear-off, so a hide can say which it ends. */
  const tearing = useRef(0)
  /** The heartbeat that keeps the drag label up — see `ghost.rs`. */
  const beating = useRef<ReturnType<typeof setInterval>>(undefined)
  // A strip that goes away mid-drag stops its heartbeat; the label follows.
  useEffect(() => () => clearInterval(beating.current), [])
  const drag = useTabDrag(strip, {
    onMove,
    onTearOff,
    onTornChange: (id, torn, grab) => {
      clearInterval(beating.current)
      const tab = tabs.find((entry) => entry.id === id)
      if (!torn || !tab) {
        return void hideGhost(tearing.current).catch(() => {})
      }
      const lone = tabs.length === 1
      // The time, not a count: the label is shared by every window, so the
      // numbers have to rise across all of them, and survive a reload.
      tearing.current = Math.max(tearing.current + 1, Date.now())
      void showGhost({
        title: tab.title,
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
  const landing = useDropHover()
  useStripReport(header)
  const dragStyles = drag.stylesFor(tabs.map((tab) => tab.id))
  const [menu, setMenu] = useState<{
    id: string
    at: { x: number; y: number }
  } | null>(null)

  // A lone tab has nowhere to move to: its window would be left empty.
  const menuItems = (id: string): MenuItem[] => [
    ...(tabs.length > 1
      ? [{ label: 'Move to new window', onSelect: () => onMoveToNewWindow(id) }]
      : []),
    { label: 'Close tab', onSelect: () => onClose(id) },
  ]

  // A tab reached by shortcut or by cycling can be scrolled out of sight, and
  // the strip scrolls rather than shrinking past 100px per tab.
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  return (
    <header
      ref={header}
      data-tauri-drag-region
      className="flex h-[38px] flex-none items-end gap-0.5 border-b border-line bg-chrome px-2"
    >
      {/* Clears the macOS traffic lights, which sit inside the titlebar.
          Windows has no frame at all — this strip is its titlebar, so the
          caption buttons are drawn at the other end. Linux keeps its own
          decorations above the strip. */}
      {IS_MAC && (
        <div data-tauri-drag-region className="h-full w-[72px] flex-none" />
      )}

      <div
        ref={strip}
        role="tablist"
        className="flex min-w-0 items-end gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => (
          <Fragment key={tab.id}>
            {landing?.index === index && (
              <LandingMark accent={landing.accent} />
            )}
            <TabButton
              tab={tab}
              active={tab.id === activeId}
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
        title={`New tab (${SHORTCUTS.open})`}
        aria-label="New tab"
        onClick={onOpen}
        className="mb-1 h-[26px] w-[26px] flex-none rounded-[7px] text-[17px] leading-none text-muted hover:bg-surface-hover hover:text-ink"
      >
        +
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

      {IS_WINDOWS && (
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
  dragging: boolean
  dragStyle: CSSProperties | undefined
  onSelect(): void
  onClose(): void
  onDragStart(event: PointerEvent<HTMLElement>): void
  onMenu(event: MouseEvent<HTMLElement>): void
}

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
function useDropHover() {
  const [landing, setLanding] = useState<{
    index: number
    accent: string
  } | null>(null)
  useEffect(() => {
    let stale: ReturnType<typeof setTimeout> | undefined
    const unlisten = onDropHover(({ x, accent }) => {
      clearTimeout(stale)
      setLanding(x === null ? null : { index: stripIndexAt(x), accent })
      if (x !== null) stale = setTimeout(() => setLanding(null), 500)
    })
    return () => {
      clearTimeout(stale)
      void unlisten.then((stop) => stop())
    }
  }, [])
  return landing
}

/** A tab's colour: its agent's, or a shell's once its agent handed back. */
const accentOf = (tab: Tab) =>
  tab.handedBack
    ? SHELL_AGENT.accent
    : (tabSession(tab)?.accent ?? 'var(--color-faint)')

function TabButton({
  tab,
  active,
  dragging,
  dragStyle,
  onSelect,
  onClose,
  onDragStart,
  onMenu,
}: TabButtonProps) {
  const accent = accentOf(tab)

  return (
    <div
      role="tab"
      aria-selected={active}
      title={tab.detail ? `${tab.title} · ${tab.detail}` : tab.title}
      onPointerDown={onDragStart}
      onContextMenu={onMenu}
      // The active tab takes keyboard focus, so the Menu key and `Shift+F10`
      // reach its menu; a click must not take it, or focus would leave the
      // terminal for the strip on every tab switch.
      tabIndex={active ? 0 : -1}
      onMouseDown={(event) => {
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
        boxShadow: active ? `inset 0 2px 0 ${accent}` : undefined,
      }}
    >
      <StatusDot tab={tab} accent={accent} />
      <span className="flex-1 overflow-hidden font-medium text-ellipsis whitespace-nowrap">
        {tab.title}
      </span>
      {tab.detail && (
        <span className="max-w-[88px] flex-initial overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-faint">
          {tab.detail}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close tab"
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
        className={`h-[18px] w-[18px] flex-none rounded-[5px] text-sm leading-none hover:bg-[#48484f] hover:opacity-100 ${
          active ? 'opacity-65' : 'opacity-0 group-hover:opacity-65'
        }`}
      >
        ×
      </button>
    </div>
  )
}

/**
 * What the tab's agent is doing, in one dot.
 *
 * Working pulses, waiting is solid in the agent's accent, and anything else is
 * grey — an agent that announces nothing stays grey rather than being called
 * idle. `title` alone would leave the state unreadable to a screen reader, so
 * the same words go in an `sr-only` span.
 */
function StatusDot({ tab, accent }: { tab: Tab; accent: string }) {
  const said =
    tab.status === 'working'
      ? 'working'
      : tab.status === 'waiting' || tab.attention
        ? 'waiting for you'
        : null

  return (
    <>
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 flex-none rounded-full ${
          tab.status === 'working' || tab.attention ? 'animate-pulse' : ''
        }`}
        style={{
          background: said || tab.dirty ? accent : '#48484f',
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

/**
 * Tells the backend where this window's strip is, so a tab dragged out of
 * another window can be dropped onto it — only this window's layout knows.
 * The strip's box changes with the window's width and with zoom, and the
 * backend works out where it sits on screen at the drop itself.
 */
function useStripReport(header: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = header.current
    if (!element) return
    const report = () => {
      const box = element.getBoundingClientRect()
      void reportStrip({
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
      }).catch(() => {})
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => observer.disconnect()
  }, [header])
}
