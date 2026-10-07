/**
 * Where a shell says one command ends and the next prompt begins.
 *
 * Nothing in a terminal's output marks that on its own — the prompt is just
 * characters, and an agent's tinted block is the only signal anywhere else in
 * this app (see `messages.ts`). A shell started through `src-tauri/src/shell.rs`
 * reports it instead, as the `OSC 133` sequences every terminal that draws
 * command blocks reads. A shell that emits none simply has no blocks.
 *
 * Typed structurally rather than against xterm's interfaces, so the whole
 * state machine can be tested without a terminal.
 */

/** A place in the buffer: an absolute row, and a column within it. */
export interface Position {
  row: number
  col: number
}

export type ShellEvent =
  | { kind: 'promptStart' }
  | { kind: 'promptEnd' }
  | { kind: 'outputStart' }
  | { kind: 'commandEnd' }
  | { kind: 'historyFile'; path: string }
  | { kind: 'command'; text: string }

/**
 * One `OSC 133` payload — everything after `133;` — or `null` for anything
 * this does not recognise.
 *
 * Deliberately total: the sequence comes from another program, and an
 * unhandled shape has to cost one boundary rather than throw inside xterm's
 * parser.
 */
export function parseShellEvent(data: string): ShellEvent | null {
  const separator = data.indexOf(';')
  const code = separator === -1 ? data : data.slice(0, separator)
  const rest = separator === -1 ? '' : data.slice(separator + 1)
  switch (code) {
    case 'A':
      return { kind: 'promptStart' }
    case 'B':
      return { kind: 'promptEnd' }
    case 'C':
      return { kind: 'outputStart' }
    case 'D':
      return { kind: 'commandEnd' }
    case 'P':
      return propertyEvent(rest)
    default:
      return null
  }
}

/**
 * How long a reported path may be before it is refused.
 *
 * The value becomes a filesystem read, so it is bounded here rather than
 * trusted: a shell writes this, and so does anything that can print to the
 * session.
 */
const MAX_PATH = 4096

/**
 * How long a reported command may be before it is refused.
 *
 * Only what a person could have typed at a prompt is worth suggesting, and
 * the value is agent-authored either way.
 */
const MAX_COMMAND = 4096

/** `P;<key>=<value>`: the history file, and the command about to run. */
function propertyEvent(rest: string): ShellEvent | null {
  const equals = rest.indexOf('=')
  if (equals === -1) return null
  const key = rest.slice(0, equals)
  const value = unescapeValue(rest.slice(equals + 1))
  // The escaping carries `\xNN` for any byte, so a control character reaches
  // this side as ordinary text in the sequence and has to be refused here for
  // both properties — one becomes a filesystem read, the other becomes text
  // typed into a live shell.
  if (!value || CONTROL.test(value)) return null
  if (key === 'Cmd') {
    return value.length <= MAX_COMMAND ? { kind: 'command', text: value } : null
  }
  if (key !== 'HistFile') return null
  return value.length <= MAX_PATH ? { kind: 'historyFile', path: value } : null
}

/** C0 and DEL, which neither a path nor a command may carry. */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The value behind a property's escaping: `;` would end the field, and `\`
 * is what escapes it, so both come back as hex.
 */
function unescapeValue(text: string): string {
  return text.replace(/\\(\\|x[0-9a-fA-F]{2})/g, (_whole, escaped: string) =>
    escaped === '\\'
      ? '\\'
      : String.fromCharCode(parseInt(escaped.slice(1), 16)),
  )
}

/** The parts of xterm's buffer this reads, so a test can supply them. */
export interface BlockLine {
  isWrapped: boolean
  translateToString(
    trimRight?: boolean,
    startColumn?: number,
    endColumn?: number,
  ): string
}
export interface BlockBuffer {
  readonly length: number
  getLine(row: number): BlockLine | undefined
}

/**
 * The text between two places in the buffer, as it was drawn, with `to`
 * exclusive.
 *
 * A wrapped row is joined to the one above it rather than broken with a
 * newline: the break is the terminal's, not the text's, and a command or a
 * path copied out of a narrow pane would otherwise arrive in pieces.
 */
export function textBetween(
  buffer: BlockBuffer,
  from: Position,
  to: Position,
): string {
  // A row of -1 is how a marker says its line has been trimmed out of the
  // scrollback, and it must never be walked: xterm's `getLine` has no bounds
  // check, and its circular buffer resolves -1 to a real stale row once the
  // list has wrapped — so the loop below would not stop, and would return
  // every row of the session instead of one command's output.
  if (from.row < 0 || to.row < 0) return ''
  let text = ''
  for (let row = from.row; row <= to.row && row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    if (!line) break
    const start = row === from.row ? from.col : 0
    const end = row === to.row ? to.col : undefined
    if (row === to.row && to.col <= start) break
    if (row > from.row) text += line.isWrapped ? '' : '\n'
    text += line.translateToString(end === undefined, start, end)
  }
  return text
}

/** A command the shell reported, and the rows it owns. */
export interface ShellBlock {
  /** Where typing begins: the end of the prompt. */
  input: Position
  /** Where the command's output begins, once it has started running. */
  output: Position | null
  /** Where the output ends, once the command has finished. */
  end: Position | null
}

/** The command as it was typed, or empty while the prompt is still open. */
export const commandOf = (buffer: BlockBuffer, block: ShellBlock): string =>
  block.output ? textBetween(buffer, block.input, block.output).trim() : ''

/** Everything the command printed, or empty while it is still printing. */
export const outputOf = (buffer: BlockBuffer, block: ShellBlock): string =>
  block.output && block.end
    ? textBetween(buffer, block.output, block.end).replace(/\n+$/, '')
    : ''

/**
 * What has been typed at an open prompt, or `null` when the cursor is not
 * where a suggestion could be accepted.
 *
 * Two things disqualify it. A cursor that is not at the end of the line means
 * the text after it would be pushed along by anything accepted, so there is
 * nothing to complete. And a cursor above the line typing started on means
 * the shell is drawing something of its own — a completion menu, a reverse
 * search — over the prompt.
 */
export function typedAt(
  buffer: BlockBuffer,
  input: Position,
  cursor: Position,
): string | null {
  if (cursor.row < input.row) return null
  if (cursor.row === input.row && cursor.col < input.col) return null
  const line = buffer.getLine(cursor.row)
  if (!line) return null
  if (line.translateToString(true, cursor.col) !== '') return null
  return textBetween(buffer, input, cursor)
}
