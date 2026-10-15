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

import { isPasteable } from '../../../shared/lib/paste'

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

/**
 * The text an `OSC 52` payload asks to put on the clipboard, or `null` for a
 * query, an empty write, a payload that is not base64 or not UTF-8, or text
 * carrying a control character other than a tab or a line break.
 *
 * That last refusal is `isPasteable`'s, and it matters because anything that
 * prints into the tab can send an `OSC 52` write — a file being `cat` as much
 * as the agent.
 *
 * A query (`?` in place of the data) answers `null` because reading is never
 * honoured: the reply would hand the clipboard to whatever process asked, and
 * any command's output can ask. The selection letters are ignored — every
 * target lands on the one clipboard these hosts have.
 */
export function clipboardWrite(payload: string): string | null {
  const separator = payload.indexOf(';')
  if (separator < 0) return null
  const data = payload.slice(separator + 1)
  if (data === '' || data === '?') return null
  try {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text && isPasteable(text) ? text : null
  } catch {
    return null
  }
}
