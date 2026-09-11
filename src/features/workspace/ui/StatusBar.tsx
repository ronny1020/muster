import { branchLabel, chipGroups, type GitChip } from '../model/status'
import {
  type Editor,
  openInEditor,
  report,
  type Workspace,
} from '../../../shared/ipc'
import { SHORTCUTS } from '../../../entities/preferences/model/shortcuts'
import type { ReviewView } from '../../../entities/tab/model/deck'

const CHIP_TONE: Record<GitChip['tone'], string> = {
  neutral: 'text-faint',
  staged: 'text-[#7fb37a]',
  modified: 'text-[#d8b165]',
  untracked: 'text-[#6f9ede]',
  conflict: 'text-danger',
  clean: 'text-[#5f6b5e]',
}

export interface StatusBarProps {
  cwd: string
  workspace: Workspace | null
  /** Whether `cwd` follows the session or is still its launch directory. */
  tracked: boolean
  agentName: string
  state: string
  exited: boolean
  historyOpen: boolean
  reviewOpen: boolean
  /** Which view the review drawer is on, so a second click can close it. */
  reviewView: ReviewView
  /** Editor to offer for this directory, or `null` when none was found. */
  editor: Editor | null
  onToggleHistory(): void
  /**
   * Show the review drawer on this view — or close it, when it is already
   * open on it. Each control names what it wants to see rather than toggling
   * something.
   */
  onShowReview(view: ReviewView): void
  onShowHistory(): void
}

/** Footer with the tab's working directory and the git state of that tree. */
export function StatusBar({
  cwd,
  workspace,
  tracked,
  agentName,
  state,
  exited,
  historyOpen,
  reviewOpen,
  reviewView,
  editor,
  onToggleHistory,
  onShowReview,
  onShowHistory,
}: StatusBarProps) {
  const git = workspace?.git
  const groups = git?.repo ? chipGroups(git) : null
  /** A control is "expanded" only when the drawer is showing what it opens. */
  const showing = (view: ReviewView) => reviewOpen && reviewView === view

  return (
    <footer className="flex h-6 flex-none items-center gap-2.5 border-t border-line bg-chrome px-2.5 text-[11px] whitespace-nowrap text-muted">
      {/* The directory names the tree, so it opens the tree. */}
      <button
        type="button"
        aria-expanded={showing('files')}
        title={
          tracked
            ? `Browse this directory · ${SHORTCUTS.toggleReview}`
            : `Browse this directory · ${SHORTCUTS.toggleReview} — the one this session started in`
        }
        onClick={() => onShowReview('files')}
        className={`max-w-[46%] overflow-hidden text-ellipsis hover:text-ink hover:underline ${
          showing('files') ? 'text-ink' : ''
        } ${workspace && !workspace.exists ? 'text-danger' : ''}`}
      >
        {workspace?.path ?? cwd}
      </button>

      {git?.repo && (
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={onToggleHistory}
            title={`Show history${git.upstream ? ` · tracking ${git.upstream}` : ' · no upstream'}`}
            className={`flex items-center gap-1 rounded px-1 hover:bg-surface-hover hover:text-ink ${
              historyOpen ? 'bg-surface text-ink' : 'text-[#a8b4c8]'
            }`}
          >
            <BranchIcon />
            {branchLabel(git)}
          </button>
          {groups && groups.history.length > 0 && (
            <ChipGroup
              chips={groups.history}
              label="commits"
              expanded={historyOpen}
              onClick={onShowHistory}
            />
          )}
          {groups && groups.review.length > 0 && (
            <ChipGroup
              chips={groups.review}
              label="changed files"
              expanded={showing('changes')}
              onClick={() => onShowReview('changes')}
            />
          )}
          {groups?.clean && (
            <span title={groups.clean.title} className={CHIP_TONE.clean}>
              {groups.clean.text}
            </span>
          )}
        </span>
      )}

      <span className="flex-1" />

      {editor && (
        <button
          type="button"
          title={`Open this directory in ${editor.name}`}
          onClick={() => void openInEditor(cwd, editor.command).catch(report)}
          className="rounded px-1 hover:bg-surface-hover hover:text-ink"
        >
          Open in {editor.name}
        </button>
      )}
      {state && <span className={exited ? 'text-danger' : ''}>{state}</span>}
      <span className="text-faint">{agentName}</span>
    </footer>
  )
}

interface ChipGroupProps {
  chips: GitChip[]
  /** What the group counts, for the name a screen reader reads. */
  label: string
  expanded: boolean
  onClick(): void
}

/**
 * One group of counts, as one control.
 *
 * The counts keep their own colours inside it — the colour is what tells
 * staged from untracked at a glance — but the click target is the group,
 * because they all lead to the same place.
 */
const ChipGroup = ({ chips, label, expanded, onClick }: ChipGroupProps) => (
  <button
    type="button"
    aria-expanded={expanded}
    // The visible label is `~24`, which names nothing on its own.
    aria-label={`${chips.map((chip) => chip.title).join(', ')} — show ${label}`}
    title={`${chips.map((chip) => chip.title).join(' · ')} — click to show`}
    onClick={onClick}
    className={`flex items-center gap-1.5 rounded px-1 hover:bg-surface-hover ${
      expanded ? 'bg-surface' : ''
    }`}
  >
    {chips.map((chip) => (
      <span key={chip.key} className={CHIP_TONE[chip.tone]}>
        {chip.text}
      </span>
    ))}
  </button>
)

/**
 * Branch mark drawn inline rather than typed, since the Unicode glyphs for it
 * are either absent from system fonts or read as the Option key.
 */
function BranchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className="h-3 w-3 flex-none text-faint"
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      >
        <circle cx="4.5" cy="3" r="1.7" />
        <circle cx="4.5" cy="13" r="1.7" />
        <circle cx="11.5" cy="6" r="1.7" />
        <path d="M4.5 4.7v6.6" />
        <path d="M11.5 7.7c0 2.4-2.1 3-4.2 3.4" />
      </g>
    </svg>
  )
}
