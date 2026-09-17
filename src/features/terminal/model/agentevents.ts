/**
 * Turn-by-turn status an agent CLI broadcasts as an `OSC 777` sequence.
 *
 * Claude Code emits `OSC 777;notify;warp://cli-agent;<json>` at each turn
 * boundary and never rings the terminal bell, so this is the only signal that
 * a session has handed control back.
 */
export interface AgentEvent {
  name: EventName
  /** The agent's reply, on `stop`. It becomes the notification body. */
  response?: string
}

const NAMES = [
  'session_start',
  'prompt_submit',
  'tool_complete',
  'stop',
  'idle_prompt',
] as const

type EventName = (typeof NAMES)[number]

const isEventName = (value: unknown): value is EventName =>
  typeof value === 'string' && (NAMES as readonly string[]).includes(value)

/**
 * Enough of a notification body to be worth reading, and short enough that an
 * agent printing a novel cannot turn one into a wall of text.
 */
const MAX_TEXT = 200

/**
 * Far past any real status payload, and far below the 10 MB xterm will
 * accumulate for one OSC string — which is what a process writing to the pty
 * could otherwise hand to `JSON.parse`, synchronously, on the thread drawing
 * the window.
 */
const MAX_PAYLOAD = 8192

/**
 * Reads one `OSC 777` payload, or answers `null` for anything that is not a
 * status event this understands.
 *
 * Total by construction, and for a stronger reason than a stored setting is:
 * the string comes from a process that chooses its own bytes. An oversized
 * payload, a malformed body or an unknown event answers `null`; a field of
 * the wrong type is dropped and the event kept without it. Nothing throws
 * inside xterm's parser.
 */
export function parseAgentEvent(data: string): AgentEvent | null {
  if (data.length > MAX_PAYLOAD) return null

  // Hand-split rather than `split(';', 3)`, which in JS discards the
  // remainder instead of keeping it — and the remainder is the payload.
  const kindEnd = data.indexOf(';')
  const titleEnd = data.indexOf(';', kindEnd + 1)
  if (kindEnd < 0 || titleEnd < 0) return null
  if (data.slice(0, kindEnd) !== 'notify') return null

  let payload: unknown
  try {
    payload = JSON.parse(data.slice(titleEnd + 1))
  } catch {
    return null
  }
  // Asserted behind the guard on the line above, the same shape and the same
  // reason as `normalizeSettings`: every field is checked before it is read.
  const fields = (
    typeof payload === 'object' && payload !== null ? payload : {}
  ) as Record<string, unknown>
  if (!isEventName(fields.event)) return null

  // Only `response` is carried: the other fields the payload holds have no
  // consumer, and parsing what nothing reads is surface with a cost.
  const event: AgentEvent = { name: fields.event }
  const response = capped(fields.response)
  if (response) event.response = response
  return event
}

/** The field as text the interface can carry, or `undefined` if it is not. */
function capped(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  const cut = value.slice(0, MAX_TEXT)
  // A cut landing between a surrogate pair leaves half a character, which the
  // OS renders as a replacement glyph in the notification. Dropping the orphan
  // costs one code point; iterating the whole string to count them would cost
  // an array as long as whatever the agent chose to print.
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
