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

export type ClipboardIntent = 'copy' | 'paste' | 'copyOutput' | null

/**
 * What `chord` means for the clipboard, or `null` to leave it to the terminal.
 *
 * Deliberately narrow: any extra modifier, or a repeat of the same physical
 * chord with Alt held, belongs to the program in the terminal.
 *
 * `copyOutput` is the one macOS answers too. It takes the last command's
 * output rather than a selection, so no menu accelerator covers it — and a
 * control that exists only under the pointer is one a keyboard cannot reach.
 */
export function clipboardIntent(
  chord: KeyChord,
  isMac: boolean,
): ClipboardIntent {
  if (chord.type !== 'keydown') return null
  if (chord.altKey) return null
  const modifier = isMac ? chord.metaKey && !chord.ctrlKey : chord.ctrlKey
  if (!modifier || !chord.shiftKey) return null
  const key = chord.key.toLowerCase()
  if (key === 'o') return 'copyOutput'
  // The rest is the Windows and Linux convention, which macOS has no need of:
  // `⌘C` and `⌘V` are native menu accelerators there and xterm answers the
  // `copy` event itself, while `Ctrl+C` has to stay SIGINT everywhere.
  if (isMac || chord.metaKey) return null
  if (key === 'c') return 'copy'
  if (key === 'v') return 'paste'
  return null
}
