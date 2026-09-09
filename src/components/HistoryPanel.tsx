import { useCallback, useEffect, useState } from 'react'

import { type Commit, gitLog } from '../ipc'

export interface HistoryPanelProps {
  cwd: string
  branch: string
  limit: number
  /** Changes whenever HEAD may have moved, which re-reads the log. */
  revision: string
  onClose(): void
}

/** Right-hand drawer listing the working directory's commits. */
export function HistoryPanel({
  cwd,
  branch,
  limit,
  revision,
  onClose,
}: HistoryPanelProps) {
  const [commits, setCommits] = useState<Commit[] | null>(null)

  const load = useCallback(async () => {
    setCommits(await gitLog(cwd, limit).catch(() => []))
  }, [cwd, limit])

  useEffect(() => {
    void load()
  }, [load, revision])

  return (
    <aside className="flex w-[320px] flex-none flex-col border-l border-line bg-chrome">
      <header className="flex h-8 flex-none items-center gap-2 border-b border-line px-2.5">
        <span className="flex-1 truncate text-[11px] tracking-[0.06em] text-muted uppercase">
          History · {branch}
        </span>
        <button
          type="button"
          title="Refresh"
          aria-label="Refresh history"
          onClick={() => void load()}
          className="h-5 w-5 rounded text-muted hover:bg-surface-hover hover:text-ink"
        >
          ↻
        </button>
        <button
          type="button"
          title="Close history"
          aria-label="Close history"
          onClick={onClose}
          className="h-5 w-5 rounded text-muted hover:bg-surface-hover hover:text-ink"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {commits === null ? (
          <p className="m-0 px-2.5 py-3 text-[11px] text-faint">
            Reading history…
          </p>
        ) : commits.length === 0 ? (
          <p className="m-0 px-2.5 py-3 text-[11px] text-faint">
            No commits yet.
          </p>
        ) : (
          commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} />
          ))
        )}
      </div>
    </aside>
  )
}

function CommitRow({ commit }: { commit: Commit }) {
  return (
    <article
      title={commit.subject}
      className="flex flex-col gap-1 border-b border-line/60 px-2.5 py-2 hover:bg-surface"
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className="h-1.5 w-1.5 flex-none rounded-full"
          style={{
            background: commit.unpushed ? 'var(--color-brand)' : 'transparent',
          }}
          title={commit.unpushed ? 'not pushed yet' : undefined}
        />
        <span className="flex-1 truncate text-xs leading-snug text-ink">
          {commit.subject}
        </span>
      </div>

      {commit.refs.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-3">
          {commit.refs.map((reference) => (
            <span
              key={reference}
              className="rounded border border-line bg-surface px-1 text-[10px] text-[#a8b4c8]"
            >
              {reference}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-1.5 pl-3 text-[10px] text-faint">
        <span className="font-mono">{commit.short}</span>
        <span className="truncate">{commit.author}</span>
        <span className="flex-none">· {commit.when}</span>
      </div>
    </article>
  )
}
