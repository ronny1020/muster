import { IS_MAC } from './platform'

export type ShortcutAction =
  | { type: 'open' }
  | { type: 'openSettings' }
  | { type: 'toggleHistory' }
  | { type: 'closeActive' }
  | { type: 'cycle'; step: number }
  | { type: 'activateIndex'; index: number }

/** Just the fields a shortcut is decided from, so this stays testable. */
export type ShortcutEvent = Pick<
  KeyboardEvent,
  'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>

/**
 * Tab shortcuts in each platform's own idiom.
 *
 * macOS puts them on ⌘, which no terminal program claims. Elsewhere the
 * modifier has to be Ctrl, where bare `Ctrl+T`/`Ctrl+W` belong to readline and
 * must reach the terminal untouched — so letters take `Ctrl+Shift`, the way
 * every Windows and Linux terminal binds them.
 */
export function matchShortcut(
  event: ShortcutEvent,
  isMac: boolean,
): ShortcutAction | null {
  if (event.altKey) return null
  const modifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (!modifier) return null

  // Page keys cycle tabs everywhere; nothing in a terminal wants them modified.
  if (event.key === 'PageUp') return { type: 'cycle', step: -1 }
  if (event.key === 'PageDown') return { type: 'cycle', step: 1 }
  if (event.shiftKey && BRACKET_STEP[event.key])
    return { type: 'cycle', step: BRACKET_STEP[event.key] }

  // Digits are free of readline too, so they never need the extra shift.
  if (!event.shiftKey) {
    if (event.key === ',') return { type: 'openSettings' }
    if (event.key === '9') return { type: 'activateIndex', index: -1 }
    const digit = Number(event.key)
    if (Number.isInteger(digit) && digit >= 1 && digit <= 8) {
      return { type: 'activateIndex', index: digit - 1 }
    }
  }

  if (event.shiftKey !== !isMac) return null
  return LETTER_ACTIONS[event.key.toLowerCase()] ?? null
}

/** Shift turns `[` into `{` on some layouts, so both spellings count. */
const BRACKET_STEP: Record<string, number> = {
  '[': -1,
  '{': -1,
  ']': 1,
  '}': 1,
}

const LETTER_ACTIONS: Record<string, ShortcutAction> = {
  t: { type: 'open' },
  w: { type: 'closeActive' },
  y: { type: 'toggleHistory' },
}

/** The same bindings written out, for tooltips and docs. */
export function shortcutLabels(isMac: boolean) {
  const letter = isMac
    ? (key: string) => `⌘${key}`
    : (key: string) => `Ctrl+Shift+${key}`
  return {
    open: letter('T'),
    closeActive: letter('W'),
    toggleHistory: letter('Y'),
    openSettings: isMac ? '⌘,' : 'Ctrl+,',
    previous: isMac ? '⌘⇧[' : 'Ctrl+PageUp',
    next: isMac ? '⌘⇧]' : 'Ctrl+PageDown',
    jump: isMac ? '⌘1–⌘9' : 'Ctrl+1–Ctrl+9',
  }
}

export const SHORTCUTS = shortcutLabels(IS_MAC)
