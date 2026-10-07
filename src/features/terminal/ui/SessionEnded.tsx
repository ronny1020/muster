export interface SessionEndedProps {
  /** Exit code of the process that ended. */
  code: number
  agentName: string
  onRelaunch(): void
}

/**
 * Shown when a session's process ends — an agent session's once the shell it
 * handed back to has exited, and a PowerShell one when the agent itself does.
 * The tab would otherwise be a dead terminal with no way out but closing it.
 */
export function SessionEnded({
  code,
  agentName,
  onRelaunch,
}: SessionEndedProps) {
  const failed = code !== 0

  return (
    <div
      className={`flex flex-none items-center gap-2.5 border-t px-2.5 py-1.5 text-[11px] ${
        failed
          ? 'border-danger/40 bg-danger/10 text-ink'
          : 'border-line bg-surface text-muted'
      }`}
    >
      <span className="min-w-0 flex-1">
        {failed
          ? `${agentName} exited with code ${code}. Its own output above says why.`
          : `${agentName} ended.`}
      </span>
      <button
        type="button"
        onClick={onRelaunch}
        className="h-6 flex-none rounded-lg border border-line bg-surface px-2.5 hover:bg-surface-hover hover:text-ink"
      >
        Back to start
      </button>
    </div>
  )
}
