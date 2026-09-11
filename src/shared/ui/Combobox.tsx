import { useEffect, useId, useRef, useState } from 'react'

export interface ComboboxOption {
  id: string
  label: string
  /** Drawn as a dot before the label, where the caller has a colour for it. */
  accent?: string
}

export interface ComboboxProps {
  label: string
  options: ComboboxOption[]
  selected: string
  onSelect(id: string): void
  placeholder?: string
}

/**
 * A picker you can type into.
 *
 * A row of buttons stops working somewhere around six choices — it wraps, the
 * eye has to scan it, and the thing you want is wherever it happens to be. A
 * list you filter does not care how long it gets.
 *
 * Built to the combobox pattern rather than out of a `<select>`: the native
 * control cannot be filtered, and cannot show an agent's colour beside its
 * name. That means owning the keyboard — arrows move, Enter takes, Escape
 * closes without changing anything, and the input keeps focus throughout so a
 * screen reader is told which option is active by `aria-activedescendant`.
 */
export function Combobox({
  label,
  options,
  selected,
  onSelect,
  placeholder,
}: ComboboxProps) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const host = useRef<HTMLDivElement>(null)

  const chosen = options.find((option) => option.id === selected)
  const matches = matching(options, query)
  // Kept in range as the filter narrows, or Enter takes an option nobody sees.
  const index = stepped(active, 0, matches.length)

  const close = () => {
    setOpen(false)
    setQuery('')
  }

  useEffect(() => {
    if (!open) return
    const onOutside = (event: Event) => {
      // Through `close`, so the filter goes with it: leaving the query behind
      // meant the list reopened still narrowed by something you had typed and
      // then clicked away from.
      if (!host.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('pointerdown', onOutside)
    return () => window.removeEventListener('pointerdown', onOutside)
  }, [open])

  const take = (option: ComboboxOption | undefined) => {
    if (!option) return
    onSelect(option.id)
    close()
  }

  return (
    <div ref={host} className="relative w-[220px]">
      <div className="flex h-[26px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2">
        {chosen?.accent && !open && <Dot colour={chosen.accent} />}
        <input
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && matches[index]
              ? `${listId}-${matches[index].id}`
              : undefined
          }
          value={open ? query : (chosen?.label ?? '')}
          placeholder={placeholder}
          spellCheck={false}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown')
              setActive((at) => stepped(at, 1, matches.length))
            else if (event.key === 'ArrowUp')
              setActive((at) => stepped(at, -1, matches.length))
            else if (event.key === 'Enter') take(matches[index])
            else if (event.key === 'Escape') {
              // Claimed: the surfaces underneath close on Escape too, and
              // dismissing a list must not close the pane behind it.
              event.stopPropagation()
              close()
            } else if (event.key === 'Tab') close()
            else return
            if (event.key !== 'Tab') event.preventDefault()
          }}
          className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-faint"
        />
      </div>

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute top-[30px] right-0 left-0 z-30 max-h-56 overflow-y-auto rounded-lg border border-line bg-chrome py-1 shadow-xl"
        >
          {matches.length === 0 && (
            <li className="px-2.5 py-1 text-[11px] text-faint">No match.</li>
          )}
          {matches.map((option, at) => (
            <li key={option.id}>
              <button
                type="button"
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={option.id === selected}
                tabIndex={-1}
                // `pointerdown` would blur the input before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => take(option)}
                onMouseEnter={() => setActive(at)}
                className={`flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] ${
                  at === index ? 'bg-surface text-ink' : 'text-muted'
                }`}
              >
                {option.accent && <Dot colour={option.accent} />}
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The active option after moving `step`, held inside the list.
 *
 * Clamped when it is *stored*, not only when it is drawn: letting it run past
 * the end meant an arrow key that had been held down left a number nothing
 * could see, and the next few presses in the other direction did nothing.
 */
export function stepped(active: number, step: number, count: number): number {
  if (count === 0) return 0
  return Math.min(count - 1, Math.max(0, active + step))
}

/** Case-insensitive, and on any part of the name: `code` finds OpenCode. */
export function matching(
  options: ComboboxOption[],
  query: string,
): ComboboxOption[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return options
  return options.filter((option) => option.label.toLowerCase().includes(wanted))
}

const Dot = ({ colour }: { colour: string }) => (
  <span
    aria-hidden="true"
    className="h-2 w-2 flex-none rounded-full"
    style={{ background: colour }}
  />
)
