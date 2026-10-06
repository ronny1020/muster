import type { Tab } from '../entities/tab/model/deck'
import { parseMovedTab } from '../entities/tab/model/moved'
import {
  expectAdoption,
  parseTerminalHandoff,
  type TerminalHandoff,
} from '../features/terminal/model/handoff'
import { takeHandoffs } from '../shared/ipc'

/** A tab on its way to another window, with its live terminal if it has one. */
interface Handoff {
  tab: Tab
  terminal: TerminalHandoff | null
  /** Where along the receiving window's strip it was dropped, in its CSS
   *  pixels; `null` appends it. */
  dropX: number | null
}

export const writeHandoff = (handoff: Handoff) => JSON.stringify(handoff)

/**
 * Reads what another window sent, or `null` for something that is not a
 * handoff. A session tab without its terminal is refused too: adopted, it
 * would spawn the agent again in this window while the original kept running.
 */
export function readHandoff(text: string): Handoff | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const fields = raw as Record<string, unknown>
  const tab = parseMovedTab(fields.tab)
  const terminal = parseTerminalHandoff(fields.terminal)
  if (!tab || (tab.content.type === 'session' && !terminal)) return null
  const dropX = Number.isFinite(fields.dropX) ? Number(fields.dropX) : null
  return { tab, terminal, dropX }
}

/** A tab taken from another window, and where on the strip it was dropped. */
interface Adopted {
  tab: Tab
  dropX: number | null
}

/**
 * Takes the tabs other windows sent this one, leaving each terminal for the
 * view that mounts for its tab, and answers the tabs.
 */
export async function adoptHandoffs(): Promise<Adopted[]> {
  let sent: string[]
  try {
    sent = await takeHandoffs()
  } catch {
    return []
  }
  return sent.flatMap((text) => {
    const handoff = readHandoff(text)
    if (!handoff) return []
    if (handoff.terminal) expectAdoption(handoff.tab.id, handoff.terminal)
    return [{ tab: handoff.tab, dropX: handoff.dropX }]
  })
}
