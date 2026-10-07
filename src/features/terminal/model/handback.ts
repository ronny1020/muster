/**
 * The moment an agent session's terminal passes to a shell.
 *
 * The session announces it as `OSC 777;muster-handback;<token>;<status>` —
 * see `platform::hands_back` — once the agent has exited and the modes it left
 * behind are reset. The token is the session's own, which the backend handed
 * to the announcing `sh`, so output that merely carries the sequence is not
 * believed — see `platform::HANDBACK_TOKEN_ENV` for what it does not stop.
 */
export const HANDBACK_VERB = 'muster-handback'

/**
 * The agent's exit status, when `data` is this session's announcement, or
 * `null` for anything else.
 */
export function parseHandback(data: string, token: string): number | null {
  // Checked before anything is split: this runs on every `OSC 777` an agent
  // prints, and one can be megabytes long.
  if (data.length > MAX_ANNOUNCEMENT || !data.startsWith(`${HANDBACK_VERB};`))
    return null
  const [verb, carried, status, ...rest] = data.split(';')
  if (verb !== HANDBACK_VERB || carried !== token || rest.length > 0)
    return null
  if (!/^\d{1,3}$/.test(status ?? '')) return null
  const code = Number(status)
  return code <= 255 ? code : null
}

/** The verb, a 16-digit token and a status, with room to spare. */
const MAX_ANNOUNCEMENT = 64

/** What a notification says once an agent has handed its tab back. */
export const handbackNotice = (code: number) =>
  code === 0
    ? 'Ended. The tab is back at your shell.'
    : `Exited with code ${code}. The tab is back at your shell.`
