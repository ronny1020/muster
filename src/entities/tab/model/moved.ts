import type { AgentStatus, ReviewView, Session, Tab, TabContent } from './deck'
import { normalizeStart } from './persist'

/**
 * Reads a tab another window sent this one, or `null` for anything that is not
 * one.
 *
 * Another window of this app wrote it, but it crossed a serialization
 * boundary on the way, so the shape is checked rather than asserted — and a
 * session that does not check out is refused rather than repaired, because a
 * repaired session would be spawned: a second agent nobody asked for.
 */
export function parseMovedTab(input: unknown): Tab | null {
  const raw = record(input)
  if (!raw || typeof raw.id !== 'string' || !raw.id) return null
  const content = parseContent(raw.content)
  if (!content) return null
  return {
    id: raw.id,
    title: text(raw.title, 'New session'),
    detail: text(raw.detail, ''),
    dirty: raw.dirty === true,
    exitCode:
      typeof raw.exitCode === 'number' && Number.isInteger(raw.exitCode)
        ? raw.exitCode
        : null,
    historyOpen: raw.historyOpen === true,
    reviewOpen: raw.reviewOpen === true,
    journalOpen: raw.journalOpen === true,
    reviewView: oneOf<ReviewView>(raw.reviewView, ['changes', 'files']),
    findOpen: raw.findOpen === true,
    attention: raw.attention === true,
    status: oneOf<AgentStatus>(raw.status, ['unknown', 'working', 'waiting']),
    handedBack: raw.handedBack === true,
    content,
  }
}

function parseContent(input: unknown): TabContent | null {
  const raw = record(input)
  if (raw?.type === 'settings') return { type: 'settings' }
  if (raw?.type === 'launcher') {
    const start = normalizeStart(raw.start)
    return start ? { type: 'launcher', start } : { type: 'launcher' }
  }
  if (raw?.type === 'session') {
    const session = parseSession(raw.session)
    return session ? { type: 'session', session } : null
  }
  return null
}

function parseSession(input: unknown): Session | null {
  const raw = record(input)
  if (!raw) return null
  const { agentId, agentName, accent, program, cwd, distro, args } = raw
  if (
    typeof agentId !== 'string' ||
    typeof agentName !== 'string' ||
    typeof accent !== 'string' ||
    typeof program !== 'string' ||
    typeof cwd !== 'string' ||
    typeof distro !== 'string' ||
    !isStrings(args)
  ) {
    return null
  }
  return {
    agentId,
    agentName,
    accent,
    program,
    args,
    cwd,
    backend: raw.backend === 'wsl' ? 'wsl' : 'native',
    distro,
    scrollback: raw.scrollback === true,
  }
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const record = (input: unknown) =>
  typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)
    : null

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' ? value : fallback

/** The value when it is one of `allowed`, else the first of them. */
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  allowed.find((option) => option === value) ?? allowed[0]!
