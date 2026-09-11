/**
 * Deciding when a key event means copy or paste rather than terminal input.
 *
 * macOS needs nothing from us: `⌘C` and `⌘V` are native menu accelerators, and
 * xterm answers the resulting `copy` event itself with its own selection. The
 * other two hosts have no such route — `Ctrl+C` has to stay SIGINT — so the
 * convention there is `Ctrl+Shift+C` / `Ctrl+Shift+V`, which xterm does not
 * bind.
 *
 * Typed structurally rather than against `KeyboardEvent` so the decision can be
 * tested without a DOM.
 */

export interface KeyChord {
  type: string
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export type ClipboardIntent = 'copy' | 'paste' | null

/**
 * What `chord` means for the clipboard, or `null` to leave it to the terminal.
 *
 * Deliberately narrow: any extra modifier, or a repeat of the same physical
 * chord with Alt held, belongs to the program in the terminal.
 */
export function clipboardIntent(
  chord: KeyChord,
  isMac: boolean,
): ClipboardIntent {
  if (isMac) return null
  if (chord.type !== 'keydown') return null
  if (!chord.ctrlKey || !chord.shiftKey || chord.altKey || chord.metaKey) {
    return null
  }
  const key = chord.key.toLowerCase()
  if (key === 'c') return 'copy'
  if (key === 'v') return 'paste'
  return null
}
