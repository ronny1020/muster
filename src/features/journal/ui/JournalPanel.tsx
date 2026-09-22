import { useEffect, useState } from 'react'

import {
  AGENTS,
  type Agent,
  resumeArgs,
} from '../../../entities/agent/model/agents'
import { agoLabel } from '../../../shared/lib/ago'
import { earlierThan } from '../model/entries'
import { DragEdge } from '../../../shared/ui/DragEdge'
import { formatBytes } from '../../../shared/lib/bytes'
import { usePanelWidth } from '../../../shared/lib/usePanelWidth'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { type JournalEntry, journalSessions } from '../../../shared/ipc'

export interface JournalPanelProps {
  /** Directory whose recorded sessions this lists. */
  cwd: string
  /** The tab's own live session, which is never offered. */
  liveId: string | null
  /** Whether recording is switched on, so an empty list can say why. */
  recording: boolean
  /** Whether a session is running here, which reopening would end. */
  busy: boolean
  /** Reopen this conversation in this tab, ending whatever runs here now. */
  onResume(agent: Agent, args: string[]): void
  /**
   * Start again in this tab, ending whatever runs here now — absent for a tab
   * already on its start screen, where the same thing is a click away behind
   * this drawer.
   *
   * The drawer's list answers "take me back to one of these", and "none of
   * these" is the other half of that question.
   */
  onNew?(): void
  onClose(): void
}

/** Enough for a timestamp, a size and the button beside them. */
const DEFAULT_WIDTH = 300

/**
 * Earlier sessions recorded in this directory, and a way back into one.
 *
 * The record identifies the conversation; the agent's own `--resume` is what
 * reopens it. Muster's own file is keyed on the tab, which outlives any single
 * session, so it can say *that* a conversation happened here but never carry
 * it — only the id the CLI published can do that.
 */
export function JournalPanel({
  cwd,
  liveId,
  recording,
  busy,
  onResume,
  onNew,
  onClose,
}: JournalPanelProps) {
  const { settings } = useSettings()
  const size = usePanelWidth('muster.journalWidth', DEFAULT_WIDTH)
  const [entries, setEntries] = useState<JournalEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setEntries(null)
    void journalSessions(cwd)
      .catch(() => [])
      .then((found) => {
        if (!cancelled) setEntries(earlierThan(found, liveId))
      })
    return () => {
      cancelled = true
    }
  }, [cwd, liveId])

  return (
    <aside
      style={{ width: size.width, maxWidth: '80%' }}
      // Not `flex-none`: like the other drawers, the dragged width is a
      // preference and the flex row is what keeps the terminal a column.
      className="relative flex min-h-0 flex-col border-l border-line bg-chrome"
    >
      <DragEdge size={size} label="Resize the earlier-sessions drawer" />
      <header className="flex h-8 flex-none items-center gap-2 border-b border-line px-2.5">
        <span className="flex-1 truncate text-[11px] tracking-[0.06em] text-muted uppercase">
          Earlier sessions
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close earlier sessions"
          className="rounded px-1.5 text-muted hover:bg-surface hover:text-ink"
        >
          ✕
        </button>
      </header>

      {onNew && (
        <div className="flex-none border-b border-line px-2.5 py-2">
          <button
            type="button"
            onClick={onNew}
            title={
              busy
                ? 'Ends the session running in this tab, then opens its start screen'
                : 'Opens the start screen for this tab'
            }
            className="w-full rounded border border-line px-1.5 py-1 text-[11px] text-ink hover:bg-surface"
          >
            New session here
          </button>
          {busy && (
            <span className="mt-1 block text-[10px] text-faint">
              Ends the session running here.
            </span>
          )}
        </div>
      )}

      <div role="status" className="flex-none">
        {entries === null && (
          <p className="px-2.5 py-2 text-[11px] text-faint">Reading…</p>
        )}
        {entries?.length === 0 && (
          <p className="px-2.5 py-2 text-[11px] text-faint">
            {recording
              ? `Nothing recorded here yet. Sessions are kept for ${settings.journalRetentionDays} days.`
              : 'Recording is switched off, so nothing new is being kept. Settings → Session records.'}
          </p>
        )}
      </div>

      {/* The overflow is on the box with the height — a scroll inside an
          `overflow-hidden` parent never becomes a scroll container. */}
      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto p-0">
        {entries?.map((entry) => (
          <Row key={entry.id} entry={entry} busy={busy} onResume={onResume} />
        ))}
      </ul>
    </aside>
  )
}

interface RowProps {
  entry: JournalEntry
  busy: boolean
  onResume(agent: Agent, args: string[]): void
}

/**
 * One recorded session.
 *
 * A record with no agent or no published id gets no button rather than a
 * disabled-looking one: the row is still worth showing — it says work happened
 * here — and a control that cannot act is worse than no control.
 */
function Row({ entry, busy, onResume }: RowProps) {
  const agent = AGENTS.find((candidate) => candidate.id === entry.agentId)
  const args = agent ? resumeArgs(agent, entry.sessionId) : null

  return (
    <li className="flex flex-col gap-1 border-b border-line px-2.5 py-2">
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="flex-1 truncate text-muted">
          {agent ? agent.name : 'Session'} · last printed{' '}
          {agoLabel(entry.endedAt, Date.now())}
        </span>
        <span className="flex-none text-faint">{formatBytes(entry.bytes)}</span>
      </div>
      {agent && args ? (
        <button
          type="button"
          onClick={() => onResume(agent, args)}
          title={
            busy
              ? 'Ends the session running in this tab, then reopens this conversation'
              : 'Reopens this conversation in this tab'
          }
          className="self-start rounded border border-line px-1.5 py-0.5 text-[11px] text-ink hover:bg-surface"
        >
          Resume in this tab
        </button>
      ) : (
        <span className="text-[10px] text-faint">
          {agent
            ? `${agent.name} did not publish an id for this one — reopen it from its own picker`
            : 'Recorded before this tab remembered which agent wrote it'}
        </span>
      )}
      {busy && agent && args && (
        <span className="text-[10px] text-faint">
          Ends the session running here.
        </span>
      )}
    </li>
  )
}
