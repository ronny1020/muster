import { useEffect, useRef } from 'react'

import { type Tab, tabSession } from '../../../entities/tab/model/deck'
import { IS_MAC, IS_WINDOWS } from '../../../shared/lib/platform'
import { WindowControls } from '../../../shared/ui/WindowControls'
import { SHORTCUTS } from '../../../entities/preferences/model/shortcuts'

export interface TabStripProps {
  tabs: Tab[]
  activeId: string
  onSelect(id: string): void
  onClose(id: string): void
  onOpen(): void
}

/** Chrome-style strip: tabs sit in the titlebar, active tab merges with the pane. */
export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onOpen,
}: TabStripProps) {
  const strip = useRef<HTMLDivElement>(null)

  // A tab reached by shortcut or by cycling can be scrolled out of sight, and
  // the strip scrolls rather than shrinking past 100px per tab.
  useEffect(() => {
    strip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  return (
    <header
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
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
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
  onSelect(): void
  onClose(): void
}

function TabButton({ tab, active, onSelect, onClose }: TabButtonProps) {
  const accent = tabSession(tab)?.accent ?? '#63636d'

  return (
    <div
      role="tab"
      aria-selected={active}
      title={tab.detail ? `${tab.title} · ${tab.detail}` : tab.title}
      onMouseDown={(event) => {
        if (event.button === 1) onClose()
        else if (event.button === 0) onSelect()
      }}
      className={`group flex h-[30px] max-w-[220px] min-w-[100px] items-center gap-1.5 rounded-t-[9px] pr-2 pl-2.5 ${
        active
          ? 'bg-canvas text-ink'
          : 'text-muted hover:bg-surface-hover hover:text-ink'
      }`}
      style={active ? { boxShadow: `inset 0 2px 0 ${accent}` } : undefined}
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
        // were working in.
        onMouseDown={(event) => event.stopPropagation()}
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
