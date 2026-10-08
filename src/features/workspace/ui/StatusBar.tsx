import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { branchLabel, chipGroups, type GitChip } from '../model/status'
import {
  type Editor,
  openInEditor,
  report,
  type Workspace,
} from '../../../shared/ipc'
import { SHORTCUTS } from '../../../entities/preferences/model/shortcuts'
import type { ReviewView } from '../../../entities/tab/model/deck'
import { Icon } from '../../../shared/ui/Icon'

/**
 * The two terminal modes, as the control shows them.
 *
 * Both are always drawn, with the tab's own pressed. A single button labelled
 * with the current mode reads as "press for this", which is the opposite of
 * what it does — and the mode a user is looking for is the one they cannot
 * see. `src/features/terminal/AGENTS.md`'s "But the mouse is on the other side of
 * that trade" invariant has what each costs.
 */
const modes = (t: TFunction<'workspace'>) =>
  [
    {
      scrollback: false,
      label: t('status.clicks'),
      hint: t('status.clicksHint'),
    },
    {
      scrollback: true,
      label: t('status.scrollback'),
      hint: t('status.scrollbackHint'),
    },
  ] as const

const CHIP_TONE: Record<GitChip['tone'], string> = {
  neutral: 'text-faint',
  staged: 'text-[#7fb37a]',
  modified: 'text-[#d8b165]',
  untracked: 'text-[#6f9ede]',
  conflict: 'text-danger',
  clean: 'text-[#5f6b5e]',
}

export interface StatusBarProps {
  /** Empty on a tab with no session — the bar then carries settings alone. */
  cwd: string
  workspace: Workspace | null
  /** Whether `cwd` follows the session or is still its launch directory. */
  tracked: boolean
  agentName: string
  state: string
  exited: boolean
  historyOpen: boolean
  reviewOpen: boolean
  /**
   * What another tab is changing at the same time, already phrased — empty
   * when nothing is. Handed over as a sentence rather than as the collisions
   * themselves: the bar renders, it does not decide what a collision means.
   */
  collision: string
  /**
   * Which of the two modes the session is in and what switches it, or `null`
   * where the choice does not apply: a launcher, a shell, or a CLI that holds
   * the alternate buffer whatever it is told. One prop rather than two, so the
   * state and its control cannot disagree.
   */
  mode: { scrollback: boolean; onSwitch(): void } | null
  /** Whether a directory is known, so there is somewhere to look for records. */
  journal: boolean
  journalOpen: boolean
  /** Which view the review drawer is on, so a second click can close it. */
  reviewView: ReviewView
  /** Editor to offer for this directory, or `null` when none was found. */
  editor: Editor | null
  onToggleHistory(): void
  onToggleJournal(): void
  /**
   * Show the review drawer on this view — or close it, when it is already
   * open on it. Each control names what it wants to see rather than toggling
   * something.
   */
  onShowReview(view: ReviewView): void
  onShowHistory(): void
  onOpenSettings(): void
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
  collision,
  mode,
  journal,
  journalOpen,
  onToggleJournal,
  onToggleHistory,
  onShowReview,
  onShowHistory,
  onOpenSettings,
}: StatusBarProps) {
  const { t } = useTranslation(['workspace', 'settings'])
  const git = workspace?.git
  const groups = git?.repo ? chipGroups(git, t) : null
  /** A control is "expanded" only when the drawer is showing what it opens. */
  const showing = (view: ReviewView) => reviewOpen && reviewView === view

  return (
    <footer className="flex h-6 flex-none items-center gap-2.5 overflow-hidden border-t border-line bg-chrome px-2.5 text-[11px] whitespace-nowrap text-muted">
      {/* The directory names the tree, so it opens the tree. */}
      {cwd && (
        <button
          type="button"
          aria-expanded={showing('files')}
          title={t(tracked ? 'status.browse' : 'status.browseLaunch', {
            shortcut: SHORTCUTS.toggleReview,
          })}
          onClick={() => onShowReview('files')}
          className={`max-w-[46%] overflow-hidden text-ellipsis hover:text-ink hover:underline ${
            showing('files') ? 'text-ink' : ''
          } ${workspace && !workspace.exists ? 'text-danger' : ''}`}
        >
          {workspace?.path ?? cwd}
        </button>
      )}

      {git?.repo && (
        <span className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={onToggleHistory}
            title={t('status.showHistory', {
              upstream: git.upstream,
              context: git.upstream ? 'tracking' : undefined,
            })}
            className={`flex min-w-0 items-center gap-1 overflow-hidden rounded px-1 text-ellipsis hover:bg-surface-hover hover:text-ink ${
              historyOpen ? 'bg-surface text-ink' : 'text-[#a8b4c8]'
            }`}
          >
            <BranchIcon />
            {branchLabel(git, t)}
          </button>
          {groups && groups.history.length > 0 && (
            <ChipGroup
              chips={groups.history}
              label={t('status.commits')}
              expanded={historyOpen}
              onClick={onShowHistory}
            />
          )}
          {groups && groups.review.length > 0 && (
            <ChipGroup
              chips={groups.review}
              label={t('status.changedFiles')}
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

      {/* The region is always mounted and only its text changes: inserting a
          region that already has content in it is typically announced to
          nobody, which would miss the first collision — the interesting one. */}
      <span
        role="status"
        title={
          collision ? t('status.collisionTitle', { collision }) : undefined
        }
        // Not a colour alone: the word "also" carries the meaning for anyone
        // who cannot see the tint.
        className={`min-w-0 truncate text-danger ${
          collision ? 'rounded border border-danger/40 px-1' : ''
        }`}
      >
        {collision}
      </span>

      <span className="flex-1" />

      {editor && (
        <button
          type="button"
          title={t('status.openInEditorTitle', { editor: editor.name })}
          onClick={() => void openInEditor(cwd, editor.command).catch(report)}
          className="min-w-0 overflow-hidden rounded px-1 text-ellipsis hover:bg-surface-hover hover:text-ink"
        >
          {t('status.openInEditor', { editor: editor.name })}
        </button>
      )}
      {mode && (
        <span
          className="flex flex-none items-center overflow-hidden rounded border border-line"
          role="group"
          aria-label={t('status.terminalMode')}
        >
          {modes(t).map(({ scrollback, label, hint }) => (
            <button
              key={label}
              type="button"
              aria-pressed={mode.scrollback === scrollback}
              title={hint}
              onClick={
                mode.scrollback === scrollback ? undefined : mode.onSwitch
              }
              className={`px-1.5 ${
                mode.scrollback === scrollback
                  ? 'bg-surface text-ink'
                  : 'hover:bg-surface-hover hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </span>
      )}
      {journal && (
        <button
          type="button"
          title={t('status.journalTitle')}
          aria-label={t('status.journal')}
          aria-expanded={journalOpen}
          onClick={onToggleJournal}
          className={`flex-none rounded px-1 py-0.5 hover:bg-surface-hover hover:text-ink ${
            journalOpen ? 'bg-surface text-ink' : ''
          }`}
        >
          <Icon name="terminal" className="h-3.5 w-3.5" />
        </button>
      )}
      {state && <span className={exited ? 'text-danger' : ''}>{state}</span>}
      {agentName && <span className="text-faint">{agentName}</span>}

      {/* Settings ends the bar rather than the tab strip — see `TabStrip`. It
          keeps the bar's padding rather than the corner, which an undecorated
          window claims for its resize grip, and `flex-none` with the `min-w-0`
          above is what keeps it on screen — see AGENTS.md's far-right rule. */}
      <button
        type="button"
        title={t('status.settingsTitle', {
          settings: t('settings:title'),
          shortcut: SHORTCUTS.openSettings,
        })}
        aria-label={t('settings:title')}
        onClick={onOpenSettings}
        className="flex-none rounded px-1 py-0.5 hover:bg-surface-hover hover:text-ink"
      >
        <Icon name="settings" className="h-3.5 w-3.5" />
      </button>
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
function ChipGroup({ chips, label, expanded, onClick }: ChipGroupProps) {
  const { t } = useTranslation('workspace')
  const titles = chips.map((chip) => chip.title)
  return (
    <button
      type="button"
      aria-expanded={expanded}
      // The visible label is `~24`, which names nothing on its own.
      aria-label={t('status.chipGroupLabel', {
        titles: titles.join(t('status.titleSeparator')),
        what: label,
      })}
      title={t('status.chipGroupTitle', { titles: titles.join(' · ') })}
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
}

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
