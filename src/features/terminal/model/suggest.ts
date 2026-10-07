/**
 * Completing what is being typed at a shell prompt from what was run before.
 *
 * The shell's own history file is the source, newest first, read through
 * `shellHistory`. What this adds is the choice, and every rule in it exists
 * because accepting a suggestion **types it into a live shell**: the text goes
 * to the pty exactly as if it had been pressed.
 */

/**
 * The shortest prefix worth completing.
 *
 * One character matches most of a history file, so the list would be the
 * history rather than a suggestion, and the inline completion would change on
 * every keystroke and mean nothing. Two is where it starts to name something.
 */
const MIN_PREFIX = 2

/**
 * How many past commands the list offers.
 *
 * It is drawn over the session's own output, so it has to stay a hint rather
 * than a page: past this the list covers the work it is meant to help with.
 */
export const MAX_MATCHES = 8

/** What a tab can suggest from: this session first, then the history file. */
export interface History {
  /** What this session has run, oldest first. */
  ran: readonly string[]
  /** What the shell's history file held, newest first. */
  stored: readonly string[]
}

/**
 * Past commands starting with `typed`, newest first and without repeats.
 *
 * This session comes first, newest backwards, because what was just run here
 * is what is most likely wanted again — and the history file cannot know about
 * any of it until the shell exits.
 *
 * A candidate carrying a control byte is refused, however it got into the
 * history file. Accepting one types it into a live shell, so a newline in it
 * submits a line nobody wrote and `ESC` reaches the line editor as a keypress
 * — the same hazard `drop_text` refuses a path for.
 */
export function matchesFor(typed: string, history: History): string[] {
  if (typed.length < MIN_PREFIX) return []
  // Leading spaces are how a shell is asked not to record a line, and a
  // suggestion offered against them would name what was hidden.
  if (typed !== typed.trimStart()) return []
  const found: string[] = []
  const seen = new Set<string>()
  const take = (command: string) => {
    if (found.length >= MAX_MATCHES) return
    if (!matches(typed, command) || seen.has(command)) return
    seen.add(command)
    found.push(command)
  }
  for (let index = history.ran.length - 1; index >= 0; index -= 1) {
    if (found.length >= MAX_MATCHES) return found
    take(history.ran[index]!)
  }
  for (const command of history.stored) {
    if (found.length >= MAX_MATCHES) return found
    take(command)
  }
  return found
}

/**
 * What the top match would add to what is typed, or `null` when nothing does.
 *
 * The same answer as the first row of the list, so the two surfaces can never
 * disagree about what `→` would do.
 */
export function completionFor(
  typed: string,
  matches: readonly string[],
): string | null {
  const first = matches[0]
  return first ? first.slice(typed.length) : null
}

/** Whether `command` is a longer, typeable version of what is typed. */
function matches(typed: string, command: string): boolean {
  // The candidate's own leading space, not just the typed one: a command hidden
  // from the shell's history that way is still reported verbatim while the
  // session that ran it is open, and offering it back would name exactly what
  // was meant to stay unnamed.
  if (command !== command.trimStart()) return false
  if (command.length <= typed.length || !command.startsWith(typed)) return false
  return typeable(command.slice(typed.length))
}

/** Whether text can be written to a pty as if it had been typed. */
const typeable = (text: string) => !/[\u0000-\u001f\u007f]/.test(text)
