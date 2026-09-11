import { useEffect, useMemo, useState } from 'react'

import { changeTotals, sortChanges } from '../model/changes'
import { useChanges } from '../model/useChanges'
import type { ReviewView } from '../../../entities/tab/model/deck'
import type { Viewed } from '../model/viewed'
import { ChangedFiles } from './ChangedFiles'
import { FileTree } from './FileTree'
import { DragEdge } from '../../../shared/ui/DragEdge'
import { Icon } from '../../../shared/ui/Icon'
import type { IconName } from '../../../shared/ui/icons'
import { usePanelWidth } from '../../../shared/lib/usePanelWidth'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import {
  type Branch,
  type ChangedFile,
  gitBranches,
  report,
} from '../../../shared/ipc'
import { REVEAL_LABEL } from '../../../shared/lib/platform'

export interface ReviewPanelProps {
  cwd: string
  /** Changes whenever the tree may have moved, which re-reads the list. */
  revision: string
  /** Branch being compared against, or `''` for uncommitted work. */
  base: string
  onBase(base: string): void
  view: ReviewView
  onView(view: ReviewView): void
  /** What the content column is showing, so the list can mark it. */
  viewed: Viewed | null
  onOpenDiff(file: ChangedFile, root: string): void
  onOpenFile(path: string): void
  /** Types a path into the session, for handing a file to the agent. */
  onSend(path: string): void
  onClose(): void
}

/** A list, not a reader: wide enough for paths and their counts. */
const DEFAULT_WIDTH = 340

/**
 * What the agent changed, and the tree it changed it in.
 *
 * Strictly a navigator: everything you actually read — a diff, a file — opens
 * in the column beside it, which has the width for it. Nothing here writes.
 * No staging, no discarding, no editing: the agent in the tab is what edits,
 * and a reviewer that can also edit is a merge conflict waiting to happen.
 */
export function ReviewPanel({
  cwd,
  revision,
  base,
  onBase,
  view,
  onView,
  viewed,
  onOpenDiff,
  onOpenFile,
  onSend,
  onClose,
}: ReviewPanelProps) {
  const [showHidden, setShowHidden] = useState(false)
  const size = usePanelWidth('muster.reviewWidth', DEFAULT_WIDTH)

  const { changes, loading, reload } = useChanges(cwd, base, revision)
  /**
   * Bumped by Re-read, so the button reaches the file tree too — its folders
   * follow `revision`, which a click does not move.
   */
  const [asked, setAsked] = useState(0)
  const files = useMemo(
    () => (changes ? sortChanges(changes.files) : []),
    [changes],
  )
  const root = changes?.root ?? cwd
  const totals = changeTotals(files)
  const selected =
    viewed?.kind === 'diff' ? viewed.relative : viewed ? viewed.absolute : null

  return (
    <aside
      style={{ width: size.width, maxWidth: '80%' }}
      // Not `flex-none`: with the column open too, the flex row is the only
      // thing left that can keep the terminal on screen.
      className="relative flex flex-col border-l border-line bg-chrome"
    >
      <DragEdge size={size} label="Resize the review drawer" />

      <header className="flex h-8 flex-none items-center gap-1 border-b border-line px-2">
        <Tab
          icon="difference"
          label="Changes"
          active={view === 'changes'}
          onClick={() => onView('changes')}
        />
        <Tab
          icon="account_tree"
          label="Files"
          active={view === 'files'}
          onClick={() => onView('files')}
        />
        <span className="flex-1" />
        <IconButton
          icon="refresh"
          label="Re-read"
          onClick={() => {
            reload()
            setAsked((count) => count + 1)
          }}
        />
        <IconButton icon="close" label="Close review" onClick={onClose} />
      </header>

      <div className="flex h-7 flex-none items-center gap-1.5 border-b border-line px-2 text-[11px] text-muted">
        {view === 'changes' ? (
          <>
            <BasePicker cwd={cwd} base={base} onBase={onBase} />
            <span
              role="status"
              className="flex-1 truncate text-[10px] text-faint"
            >
              {summary(loading, changes?.repo ?? false, totals)}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowHidden((was) => !was)}
              className={`rounded px-1 ${
                showHidden ? 'bg-surface text-ink' : 'hover:bg-surface-hover'
              }`}
            >
              Hidden files
            </button>
            <span className="flex-1" />
            {/* The tree lists the directory's children, not the directory, so
                without this there is no row to right-click for the working
                directory itself — and none at all when it is empty. */}
            <IconButton
              icon="folder_open"
              label={`${REVEAL_LABEL} — this directory`}
              onClick={() => void revealItemInDir(cwd).catch(report)}
            />
          </>
        )}
        {viewed && (
          <IconButton
            icon="terminal"
            label="Type this path into the session"
            onClick={() => onSend(viewed.absolute)}
          />
        )}
      </div>

      {view === 'changes' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {changes && !changes.repo ? (
            <Empty>Not a git repository, so there is nothing to compare.</Empty>
          ) : changes?.error ? (
            <Empty tone="text-danger">{changes.error}</Empty>
          ) : files.length === 0 ? (
            <Empty>{loading ? 'Reading changes…' : 'No changes.'}</Empty>
          ) : (
            <ChangedFiles
              files={files}
              selected={selected}
              onSelect={(file: ChangedFile) => onOpenDiff(file, root)}
            />
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <FileTree
            root={cwd}
            revision={`${revision}:${asked}`}
            showHidden={showHidden}
            selected={selected}
            onSelect={(entry) => onOpenFile(entry.path)}
          />
        </div>
      )}
    </aside>
  )
}

function summary(
  loading: boolean,
  repo: boolean,
  totals: ReturnType<typeof changeTotals>,
) {
  if (!repo) return ''
  if (loading && totals.files === 0) return 'reading…'
  const plural = totals.files === 1 ? 'file' : 'files'
  return `${totals.files} ${plural} · +${totals.insertions} −${totals.deletions}`
}

interface BasePickerProps {
  cwd: string
  base: string
  onBase(base: string): void
}

/**
 * What to compare against: the uncommitted state, or another branch.
 *
 * A branch comparison is against the point the two diverged, so the base
 * branch's own later commits never read as the user's work — which is the
 * question "is this ready to open as a pull request" actually asks.
 */
function BasePicker({ cwd, base, onBase }: BasePickerProps) {
  const [branches, setBranches] = useState<Branch[]>([])

  useEffect(() => {
    let live = true
    void gitBranches(cwd)
      .catch(() => [])
      .then((list) => live && setBranches(list.filter((b) => !b.current)))
    return () => {
      live = false
    }
  }, [cwd])

  return (
    <label className="flex items-center gap-1">
      <span className="text-[10px] text-faint">vs</span>
      <select
        value={base}
        aria-label="Compare against"
        onChange={(event) => onBase(event.target.value)}
        className="max-w-[140px] rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-ink outline-none hover:bg-surface-hover"
      >
        <option value="">uncommitted</option>
        {/* The chosen base is always among the options, even before the branch
            list has loaded, after it failed, or once that branch became the
            current one — otherwise the picker falls back to showing
            "uncommitted" while the panel diffs against something else. */}
        {base && !branches.some((branch) => branch.name === base) && (
          <option value={base}>{base}</option>
        )}
        {branches.map((branch) => (
          <option key={branch.name} value={branch.name}>
            {branch.name}
          </option>
        ))}
      </select>
    </label>
  )
}

interface TabProps {
  icon: IconName
  label: string
  active: boolean
  onClick(): void
}

const Tab = ({ icon, label, active, onClick }: TabProps) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
      active ? 'bg-surface text-ink' : 'text-muted hover:bg-surface-hover'
    }`}
  >
    <Icon name={icon} className="h-3.5 w-3.5" />
    {label}
  </button>
)

interface IconButtonProps {
  icon: IconName
  label: string
  active?: boolean
  onClick(): void
}

const IconButton = ({ icon, label, active, onClick }: IconButtonProps) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    onClick={onClick}
    className={`flex h-5 w-5 items-center justify-center rounded ${
      active
        ? 'bg-surface text-ink'
        : 'text-muted hover:bg-surface-hover hover:text-ink'
    }`}
  >
    <Icon name={icon} className="h-3.5 w-3.5" />
  </button>
)

const Empty = ({
  children,
  tone = 'text-faint',
}: {
  children: string
  tone?: string
}) => (
  <p role="status" className={`m-0 px-2.5 py-3 text-[11px] ${tone}`}>
    {children}
  </p>
)
