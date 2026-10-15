/**
 * What text may reach the clipboard when something other than the reader
 * chose it.
 *
 * xterm wraps a paste in `ESC[200~`…`ESC[201~` by plain concatenation, so an
 * `ESC[201~` inside the text ends the paste early and the rest arrives as
 * typed keys. Text the app puts on the clipboard from a name or a program's
 * request — an `OSC 52` write, a filename an agent picked — is checked here
 * first; text copied off the grid needs no check, since xterm's parser
 * consumes every control character before anything reaches the buffer.
 */

// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROL_EXCEPT_LINES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/
// eslint-disable-next-line no-control-regex -- control characters are the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/

/**
 * Whether `text` is free of control characters other than a tab or a line
 * break. Line breaks pass because copied text is full of them, which leaves a
 * paste into a program without bracketed paste submitting each line.
 */
export const isPasteable = (text: string): boolean =>
  !CONTROL_EXCEPT_LINES.test(text)

/**
 * Whether `path` carries no control character at all — the rule `drop_text`
 * holds a dropped path to. A path has no business holding a line break, and
 * one pasted where bracketed paste is off would submit the line.
 */
export const isPlainPath = (path: string): boolean => !CONTROL.test(path)
