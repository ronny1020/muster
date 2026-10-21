import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { matchBranches, switchWarning } from '../model/branches'
import { branchLabel } from '../model/status'
import { DragEdge } from '../../../shared/ui/DragEdge'
import { usePanelWidth } from '../../../shared/lib/usePanelWidth'
import { currentLocale } from '../../../shared/i18n/i18n'
import { AGE_TICK_MS, relativeAge } from '../../../shared/lib/ago'
import { useNow } from '../../../shared/lib/useNow'
import {
  type Branch,
  type Commit,
  type GitStatus,
  gitBranches,
  gitCheckout,
  gitLog,
} from '../../../shared/ipc'
import { useKeyChange } from '../../../shared/lib/useKeyChange'
import { useKeyedState } from '../../../shared/lib/useKeyedState'

export interface HistoryPanelProps {
  cwd: string
  git: GitStatus
  limit: number
  /** Changes whenever HEAD may have moved, which re-reads the log. */
  revision: string
  onClose: () => void
  /** A checkout landed, so the working directory should be re-read now. */
  onSwitched: () => void
  /** Drawn under the header — pull and push. */
  sync?: ReactNode
  /** A git write is running, so a checkout would race it. */
  busy: boolean
  /**
   * Runs a checkout as the tab's one git write at a time, so it and a commit
   * or push lock each other out, and reports its result where theirs go.
   */
  runGit: (
    action: (op: string) => Promise<string>,
    done: SwitchedNotice,
  ) => Promise<boolean>
}

/**
 * What a checkout git printed nothing for reports, as a key rather than text so
 * a notice still showing after a language change is reworded with it.
 */
interface SwitchedNotice {
  key: 'branches.switched'
  values: { branch: string }
}

/** Enough for a commit subject without wrapping every one of them. */
const DEFAULT_WIDTH = 320

/** Right-hand drawer listing the working directory's commits. */
export function HistoryPanel({
  cwd,
  git,
  limit,
  revision,
  onClose,
  onSwitched,
  sync,
  busy,
  runGit,
}: HistoryPanelProps) {
  const { t } = useTranslation('workspace')
  const [commits, setCommits] = useKeyedState<Commit[] | null>(
    [cwd, limit, revision],
    null,
  )
  const now = useNow(AGE_TICK_MS)
  const [switching, setSwitching] = useState(false)
  const size = usePanelWidth('muster.historyWidth', DEFAULT_WIDTH)

  const load = useCallback(
    async (live: () => boolean = () => true) => {
      const commits = await gitLog(cwd, limit).catch(() => [])
      if (live()) setCommits([cwd, limit, revision], commits)
    },
    [cwd, limit, revision, setCommits],
  )

  useEffect(() => {
    // A read in flight when the directory changes would otherwise land after
    // the newer one and show the previous tree's history.
    let cancelled = false
    void load(() => !cancelled)
    return () => {
      cancelled = true
    }
  }, [load])

  // Switching to another directory should not leave a picker open over a
  // branch list that belongs to the tree you have left.
  useKeyChange([cwd], () => setSwitching(false))

  return (
    <aside
      style={{ width: size.width, maxWidth: '80%' }}
      // Not `flex-none`: with both drawers open the dragged width is a
      // preference, and the flex row is what keeps the terminal a column.
      className="relative flex flex-col border-l border-line bg-chrome"
    >
      <DragEdge size={size} label={t('history.resize')} />
      <header className="flex h-8 flex-none items-center gap-2 border-b border-line px-2.5">
        <span className="flex-1 truncate text-[11px] tracking-[0.06em] text-muted uppercase">
          {t('history.title', { branch: branchLabel(git, t) })}
        </span>
        <button
          type="button"
          title={t('history.switchBranch')}
          aria-label={t('history.switchBranch')}
          aria-expanded={switching}
          onClick={() => setSwitching((open) => !open)}
          className={`h-5 rounded-sm px-1 text-[11px] hover:bg-surface-hover hover:text-ink ${
            switching ? 'bg-surface text-ink' : 'text-muted'
          }`}
        >
          {t('history.switch')}
        </button>
        <button
          type="button"
          title={t('history.refresh')}
          aria-label={t('history.refreshLabel')}
          onClick={() => void load()}
          className="size-5 rounded-sm text-muted hover:bg-surface-hover hover:text-ink"
        >
          ↻
        </button>
        <button
          type="button"
          title={t('history.close')}
          aria-label={t('history.close')}
          onClick={onClose}
          className="size-5 rounded-sm text-muted hover:bg-surface-hover hover:text-ink"
        >
          ×
        </button>
      </header>

      {sync && <div className="flex-none border-b border-line">{sync}</div>}

      {switching && (
        <BranchSwitcher
          cwd={cwd}
          git={git}
          locked={busy}
          runGit={runGit}
          onSwitched={() => {
            setSwitching(false)
            onSwitched()
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {commits === null ? (
          <p className="m-0 px-2.5 py-3 text-[11px] text-faint">
            {t('history.reading')}
          </p>
        ) : commits.length === 0 ? (
          <p className="m-0 px-2.5 py-3 text-[11px] text-faint">
            {t('history.empty')}
          </p>
        ) : (
          commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} now={now} />
          ))
        )}
      </div>
    </aside>
  )
}

interface BranchSwitcherProps {
  cwd: string
  git: GitStatus
  /** Another git write is running; a checkout would race it for the index. */
  locked: boolean
  runGit: HistoryPanelProps['runGit']
  onSwitched: () => void
}

/**
 * Branch list with a filter, and the checkout that follows a click.
 *
 * Whether a switch is allowed is git's call, not this component's: a dirty
 * tree only blocks a checkout when the two branches differ in the files you
 * have touched. So the warning states what is at stake, a dirty tree never
 * disables the click, and a refusal is reported in git's own words. Only a
 * branch another worktree holds, which git always refuses, is not offered.
 */
function BranchSwitcher({
  cwd,
  git,
  locked,
  runGit,
  onSwitched,
}: BranchSwitcherProps) {
  const { t } = useTranslation('workspace')
  const [branches, setBranches] = useState<Branch[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)

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
    setPicked(branch)
    // A refusal lands in the drawer's sync line, as a push's would.
    const switched = await runGit(
      async (op) => {
        await gitCheckout(cwd, branch, op)
        return ''
      },
      { key: 'branches.switched', values: { branch } },
    )
    setPicked(null)
    if (switched) onSwitched()
  }

  const warning = switchWarning(git, t)
  const matches = branches && matchBranches(branches, query)
  const now = useNow(AGE_TICK_MS)

  return (
    <div className="flex-none border-b border-line">
      <input
        type="text"
        value={query}
        autoFocus
        spellCheck={false}
        placeholder={t('branches.filter')}
        aria-label={t('branches.filterLabel')}
        onChange={(event) => setQuery(event.target.value)}
        className="h-7 w-full border-b border-line bg-surface px-2.5 text-xs text-ink outline-none placeholder:text-faint focus:bg-surface-hover"
      />

      {warning && (
        <p className="m-0 px-2.5 py-1.5 text-[10px] leading-snug text-[#d8b165]">
          {warning}
        </p>
      )}

      <div className="max-h-56 overflow-y-auto">
        {matches === null ? (
          <p className="m-0 px-2.5 py-2 text-[11px] text-faint">
            {t('branches.reading')}
          </p>
        ) : matches.length === 0 ? (
          <p className="m-0 px-2.5 py-2 text-[11px] text-faint">
            {branches?.length ? t('branches.noMatch') : t('branches.none')}
          </p>
        ) : (
          matches.map((branch) => (
            <BranchRow
              key={`${branch.remote ? 'r' : 'l'}:${branch.name}`}
              branch={branch}
              busy={picked === branch.name}
              disabled={locked}
              now={now}
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
  now: number
  onPick: () => void
}

function BranchRow({ branch, busy, disabled, now, onPick }: BranchRowProps) {
  const { t } = useTranslation('workspace')
  if (branch.current) {
    return (
      <div className="flex items-baseline gap-1.5 px-2.5 py-1.5 text-xs">
        <span className="flex-1 truncate text-ink">{branch.name}</span>
        <span className="flex-none text-[10px] text-faint">
          {t('branches.current')}
        </span>
      </div>
    )
  }
  // Git refuses a branch another worktree holds; the row says where it is.
  if (branch.worktree) {
    return (
      <div
        title={t('branches.heldAt', { path: branch.worktree })}
        className="flex items-baseline gap-1.5 px-2.5 py-1.5 text-xs"
      >
        <span className="flex-1 truncate text-faint">{branch.name}</span>
        <span className="flex-none text-[10px] text-faint">
          {t('branches.held')}
        </span>
        <span className="sr-only">
          {t('branches.heldAt', { path: branch.worktree })}
        </span>
      </div>
    )
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      title={
        branch.remote && branch.upstream
          ? t('branches.create', {
              branch: branch.name,
              upstream: branch.upstream,
            })
          : t('branches.switchTo', { branch: branch.name })
      }
      className="flex w-full items-baseline gap-1.5 px-2.5 py-1.5 text-left text-xs hover:bg-surface disabled:opacity-50"
    >
      <span className="flex-1 truncate text-[#a8b4c8]">{branch.name}</span>
      {branch.remote && (
        <span className="flex-none text-[10px] text-faint">
          {t('branches.remote')}
        </span>
      )}
      <span className="flex-none text-[10px] text-faint">
        {busy
          ? t('branches.switching')
          : branch.at !== null && relativeAge(branch.at, now, currentLocale())}
      </span>
    </button>
  )
}

function CommitRow({ commit, now }: { commit: Commit; now: number }) {
  const { t } = useTranslation('workspace')
  return (
    <article
      title={commit.subject}
      className="flex flex-col gap-1 border-b border-line/60 px-2.5 py-2 hover:bg-surface"
    >
      <div className="flex items-baseline gap-1.5">
        <span
          className="size-1.5 flex-none rounded-full"
          style={{
            background: commit.unpushed
              ? 'var(--color-primary)'
              : 'transparent',
          }}
          title={commit.unpushed ? t('history.unpushed') : undefined}
        />
        <span className="flex-1 truncate text-xs/snug text-ink">
          {commit.subject}
        </span>
      </div>

      {commit.refs.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-3">
          {commit.refs.map((reference) => (
            <span
              key={reference}
              className="rounded-sm border border-line bg-surface px-1 text-[10px] text-[#a8b4c8]"
            >
              {reference}
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-1.5 pl-3 text-[10px] text-faint">
        <span className="font-mono">{commit.short}</span>
        <span className="truncate">{commit.author}</span>
        {commit.at !== null && (
          <span className="flex-none">
            · {relativeAge(commit.at, now, currentLocale())}
          </span>
        )}
      </div>
    </article>
  )
}
