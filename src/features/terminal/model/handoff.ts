/**
 * A live terminal moving to another window.
 *
 * The process stays where it is — Rust owns it, and re-points its output at
 * the new window — but the screen does not: xterm's buffer lives in the old
 * window's webview, so it travels as a serialized snapshot. `offset` is how
 * many bytes of output that snapshot already shows, which is what lets the
 * backend send the new window exactly the rest.
 */
export interface TerminalHandoff {
  snapshot: string
  offset: number
  /**
   * The grid the snapshot was drawn at. It is parsed at exactly that size —
   * a sequence that moves the cursor means something only at its own width —
   * and the fit to the new window afterwards is an ordinary resize, which
   * clears an agent's scrollback the way every width change does.
   */
  cols: number
  rows: number
  /** The session's registration, quoted back by the kill when the tab closes. */
  epoch: number
  /** Whether the session's `OSC 133` reports are believed now… */
  integrated: boolean
  /** …and once its agent hands back. */
  integratedAfterHandback: boolean
  handbackToken: string | null
  handedBack: boolean
  /**
   * The private modes the snapshot cannot carry, as the sequences that set
   * them — mouse encoding and cursor visibility, which xterm keeps out of
   * the state the serializer reads.
   */
  modes: string
  /**
   * The history file the shell reported. It reports once per shell, so a
   * moved tab that did not carry it would offer no completions again.
   */
  historyFile: string | null
}

/** What a mounted terminal offers the window it is in. */
export interface HandoffSource {
  /**
   * Stops drawing and answers a snapshot, or `null` for a terminal with no
   * session yet. Nothing is drawn after it, so nothing after `offset` is lost.
   */
  detach(): Promise<TerminalHandoff | null>
  /** Takes the session back after a move that failed, from where it stopped. */
  resume(): void
}

const sources = new Map<string, HandoffSource>()
const adoptions = new Map<string, TerminalHandoff>()

/** Offers a terminal for moving; answers the call that withdraws it. */
export function offerHandoff(id: string, source: HandoffSource) {
  sources.set(id, source)
  return () => {
    if (sources.get(id) === source) sources.delete(id)
  }
}

export const detachTerminal = async (id: string) =>
  (await sources.get(id)?.detach()) ?? null

export const resumeTerminal = (id: string) => sources.get(id)?.resume()

/** Leaves a moved-in terminal for the view that mounts for its tab. */
export const expectAdoption = (id: string, handoff: TerminalHandoff) =>
  adoptions.set(id, handoff)

/** The moved-in terminal for a tab, once: a remount must spawn, not adopt. */
export function takeAdoption(id: string) {
  const handoff = adoptions.get(id) ?? null
  adoptions.delete(id)
  return handoff
}

/**
 * Reads a handoff that crossed from another window, or `null` for anything
 * that is not one. Another window of this app wrote it, but it still crossed
 * a serialization boundary, so its shape is checked rather than asserted.
 */
export function parseTerminalHandoff(input: unknown): TerminalHandoff | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = input as Record<string, unknown>
  const flag = (key: string) => raw[key] === true
  if (
    typeof raw.snapshot !== 'string' ||
    !isCount(raw.offset) ||
    !isCount(raw.epoch) ||
    !isCount(raw.cols) ||
    !isCount(raw.rows) ||
    raw.cols === 0 ||
    raw.rows === 0
  ) {
    return null
  }
  return {
    snapshot: raw.snapshot,
    offset: raw.offset,
    cols: raw.cols,
    rows: raw.rows,
    epoch: raw.epoch,
    integrated: flag('integrated'),
    integratedAfterHandback: flag('integratedAfterHandback'),
    handbackToken:
      typeof raw.handbackToken === 'string' ? raw.handbackToken : null,
    handedBack: flag('handedBack'),
    modes:
      typeof raw.modes === 'string' && CARRIED_SEQUENCES.test(raw.modes)
        ? raw.modes
        : '',
    historyFile: typeof raw.historyFile === 'string' ? raw.historyFile : null,
  }
}

/**
 * Private modes a move carries itself: SGR and URXVT mouse encoding, and
 * cursor visibility.
 */
export const CARRIED_MODES = new Set([25, 1005, 1006, 1015])

/** Only ever a run of those modes being set or reset — it is written to a
 *  terminal, so nothing else may pass. */
const CARRIED_SEQUENCES = /^(?:\x1b\[\?(?:25|1005|1006|1015)[hl])*$/

/** The sequences that put `modes` back. */
export const modeSequences = (modes: ReadonlyMap<number, boolean>) =>
  [...modes].map(([mode, set]) => `\x1b[?${mode}${set ? 'h' : 'l'}`).join('')

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
