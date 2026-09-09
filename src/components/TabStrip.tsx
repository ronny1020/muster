import { type Tab, tabSession } from '../deck'
import { IS_MAC } from '../platform'
import { SHORTCUTS } from '../shortcuts'

export interface TabStripProps {
  tabs: Tab[]
  activeId: string
  onSelect(id: string): void
  onClose(id: string): void
  onOpen(): void
  onOpenSettings(): void
}

/** Chrome-style strip: tabs sit in the titlebar, active tab merges with the pane. */
export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onOpen,
  onOpenSettings,
}: TabStripProps) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-[38px] flex-none items-end gap-0.5 border-b border-line bg-chrome px-2"
    >
      {/* Clears the macOS traffic lights, which sit inside the titlebar.
          Windows and Linux keep their own decorations above this strip. */}
      {IS_MAC && (
        <div data-tauri-drag-region className="h-full w-[72px] flex-none" />
      )}

      <div
        role="tablist"
        className="flex min-w-0 items-end gap-0.5 overflow-hidden"
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

      <button
        type="button"
        title={`Settings (${SHORTCUTS.openSettings})`}
        aria-label="Settings"
        onClick={onOpenSettings}
        className="mb-1 h-[26px] w-[26px] flex-none rounded-[7px] text-sm leading-none text-muted hover:bg-surface-hover hover:text-ink"
      >
        ⚙
      </button>
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
      <span
        className={`h-1.5 w-1.5 flex-none rounded-full ${tab.attention ? 'animate-pulse' : ''}`}
        style={{ background: tab.attention || tab.dirty ? accent : '#48484f' }}
        title={tab.attention ? 'waiting for you' : undefined}
      />
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
