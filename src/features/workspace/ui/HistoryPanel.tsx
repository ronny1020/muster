import { useCallback, useEffect, useState } from 'react'

import { matchBranches, switchWarning } from '../model/branches'
import { branchLabel } from '../model/status'
import {
  type Branch,
  type Commit,
  type GitStatus,
  gitBranches,
  gitCheckout,
  gitLog,
} from '../../../shared/ipc'

export interface HistoryPanelProps {
  cwd: string
  git: GitStatus
  limit: number
  /** Changes whenever HEAD may have moved, which re-reads the log. */
  revision: string
  onClose(): void
  /** A checkout landed, so the working directory should be re-read now. */
  onSwitched(): void
}

/** Right-hand drawer listing the working directory's commits. */
export function HistoryPanel({
  cwd,
  git,
  limit,
  revision,
  onClose,
  onSwitched,
}: HistoryPanelProps) {
  const [commits, setCommits] = useState<Commit[] | null>(null)
  const [switching, setSwitching] = useState(false)

  const load = useCallback(
    async (live: () => boolean = () => true) => {
      const commits = await gitLog(cwd, limit).catch(() => [])
      if (live()) setCommits(commits)
    },
    [cwd, limit],
  )

  useEffect(() => {
    // A read in flight when the directory changes would otherwise land after
    // the newer one and show the previous tree's history.
    let cancelled = false
    setCommits(null)
    void load(() => !cancelled)
    return () => {
      cancelled = true
    }
  }, [load, revision])

  // Switching to another directory should not leave a picker open over a
  // branch list that belongs to the tree you have left.
  useEffect(() => setSwitching(false), [cwd])

  return (
    <aside className="flex w-[320px] flex-none flex-col border-l border-line bg-chrome">
      <header className="flex h-8 flex-none items-center gap-2 border-b border-line px-2.5">
        <span className="flex-1 truncate text-[11px] tracking-[0.06em] text-muted uppercase">
          History · {branchLabel(git)}
        </span>
        <button
          type="button"
          title="Switch branch"
          aria-label="Switch branch"
          aria-expanded={switching}
          onClick={() => setSwitching((open) => !open)}
          className={`h-5 rounded px-1 text-[11px] hover:bg-surface-hover hover:text-ink ${
            switching ? 'bg-surface text-ink' : 'text-muted'
          }`}
        >
          Switch
        </button>
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

      {switching && (
        <BranchSwitcher
          cwd={cwd}
          git={git}
          onSwitched={() => {
            setSwitching(false)
            onSwitched()
          }}
        />
      )}

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

interface BranchSwitcherProps {
  cwd: string
  git: GitStatus
  onSwitched(): void
}

/**
 * Branch list with a filter, and the checkout that follows a click.
 *
 * Whether a switch is allowed is git's call, not this component's: a dirty
 * tree only blocks a checkout when the two branches differ in the files you
 * have touched. So the warning states what is at stake, the click is never
 * pre-emptively disabled, and a refusal is reported in git's own words.
 */
function BranchSwitcher({ cwd, git, onSwitched }: BranchSwitcherProps) {
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void gitBranches(cwd)
      .catch(() => [])
      .then((list) => {
        if (!cancelled) setBranches(list)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  const checkout = async (branch: string) => {
    setBusy(branch)
    setError(null)
    try {
      await gitCheckout(cwd, branch)
      onSwitched()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setBusy(null)
    }
  }

  const warning = switchWarning(git)
  const matches = branches && matchBranches(branches, query)

  return (
    <div className="flex-none border-b border-line">
      <input
        type="text"
        value={query}
        autoFocus
        spellCheck={false}
        placeholder="Filter branches…"
        aria-label="Filter branches"
        onChange={(event) => setQuery(event.target.value)}
        className="h-7 w-full border-b border-line bg-surface px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:bg-surface-hover"
      />

      {warning && (
        <p className="m-0 px-2.5 py-1.5 text-[10px] leading-snug text-[#d8b165]">
          {warning}
        </p>
      )}
      {error && (
        <p className="m-0 max-h-24 overflow-y-auto px-2.5 py-1.5 font-mono text-[10px] leading-snug whitespace-pre-wrap text-danger">
          {error}
        </p>
      )}

      <div className="max-h-56 overflow-y-auto">
        {matches === null ? (
          <p className="m-0 px-2.5 py-2 text-[11px] text-faint">
            Reading branches…
          </p>
        ) : matches.length === 0 ? (
          <p className="m-0 px-2.5 py-2 text-[11px] text-faint">
            {branches?.length ? 'No branch matches.' : 'No branches yet.'}
          </p>
        ) : (
          matches.map((branch) => (
            <BranchRow
              key={`${branch.remote ? 'r' : 'l'}:${branch.name}`}
              branch={branch}
              busy={busy === branch.name}
              disabled={busy !== null}
              onPick={() => void checkout(branch.name)}
            />
          ))
        )}
      </div>
    </div>
  )
}

interface BranchRowProps {
  branch: Branch
  busy: boolean
  disabled: boolean
  onPick(): void
}

function BranchRow({ branch, busy, disabled, onPick }: BranchRowProps) {
  if (branch.current) {
    return (
      <div className="flex items-baseline gap-1.5 px-2.5 py-1.5 text-xs">
        <span className="flex-1 truncate text-ink">{branch.name}</span>
        <span className="flex-none text-[10px] text-faint">current</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      title={
        branch.remote
          ? `Create ${branch.name} from ${branch.upstream}`
          : `Switch to ${branch.name}`
      }
      className="flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-left text-xs hover:bg-surface disabled:opacity-50"
    >
      <span className="flex-1 truncate text-[#a8b4c8]">{branch.name}</span>
      {branch.remote && (
        <span className="flex-none text-[10px] text-faint">remote</span>
      )}
      <span className="flex-none text-[10px] text-faint">
        {busy ? 'switching…' : branch.when}
      </span>
    </button>
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
