import { useEffect, useRef, useState } from 'react'

export interface MenuItem {
  label: string
  onSelect(): void
}

export interface ContextMenuProps {
  /** Where the menu was asked for, in viewport coordinates. */
  at: { x: number; y: number }
  items: MenuItem[]
  onClose(): void
}

/** Kept off the window's edges, since the menu is placed at the pointer. */
const MARGIN = 8

/**
 * A menu at the pointer, for the things a row can do besides being clicked.
 *
 * Positioned `fixed` because the surfaces it opens over scroll and clip, and
 * built to the menu pattern rather than as a list of buttons: it takes focus,
 * the arrows move through it, Enter chooses, Escape closes and focus goes back
 * where it came from. That matters more than usual here — `contextmenu` is a
 * keyboard event too, fired by the Menu key and `Shift+F10`, so a menu that
 * only worked with a mouse would be reachable and then unusable.
 */
export function ContextMenu({ at, items, onClose }: ContextMenuProps) {
  const host = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    opener.current = document.activeElement
    const buttons = host.current?.querySelectorAll('button')
    buttons?.[0]?.focus()
    return () => {
      // Focus goes back to the row, or the keyboard is left nowhere.
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
  }, [])

  // Placed after the first paint, when the menu's own size is known.
  useEffect(() => {
    const menu = host.current
    if (!menu) return
    const box = menu.getBoundingClientRect()
    const x = Math.min(at.x, window.innerWidth - box.width - MARGIN)
    const y = Math.min(at.y, window.innerHeight - box.height - MARGIN)
    menu.style.left = `${Math.max(MARGIN, x)}px`
    menu.style.top = `${Math.max(MARGIN, y)}px`
  }, [at])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Claimed, not shared: the surfaces underneath close on Escape too.
        event.stopPropagation()
        event.preventDefault()
        onClose()
      }
    }
    const onOutside = (event: Event) => {
      if (!host.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onOutside)
    // A menu pinned to a point is wrong the moment anything moves under it.
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onOutside)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  const move = (step: number) => {
    const next = (active + step + items.length) % items.length
    focusItem(next)
  }

  /** Focus and the active index move together, or the arrows step from one
   *  place while the ring sits in another. */
  const focusItem = (at: number) => {
    setActive(at)
    host.current?.querySelectorAll('button')[at]?.focus()
  }

  return (
    <div
      ref={host}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') move(1)
        else if (event.key === 'ArrowUp') move(-1)
        else if (event.key === 'Tab') onClose()
        else return
        event.preventDefault()
      }}
      className="fixed z-50 min-w-44 rounded-lg border border-line bg-chrome py-1 shadow-xl"
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={index === active ? 0 : -1}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
          onMouseEnter={() => focusItem(index)}
          className="block w-full px-3 py-1 text-left text-xs text-ink hover:bg-surface focus:bg-surface focus:outline-none"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
