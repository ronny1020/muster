import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { branchLabel, type GitChip, gitChips } from '../git'
import { type Editor, openInEditor, type Workspace, report } from '../ipc'
import { REVEAL_LABEL } from '../platform'

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
  /** Editor to offer for this directory, or `null` when none was found. */
  editor: Editor | null
  onToggleHistory(): void
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
  editor,
  onToggleHistory,
}: StatusBarProps) {
  const git = workspace?.git

  return (
    <footer className="flex h-6 flex-none items-center gap-2.5 border-t border-line bg-chrome px-2.5 text-[11px] whitespace-nowrap text-muted">
      <button
        type="button"
        title={
          tracked
            ? REVEAL_LABEL
            : `${REVEAL_LABEL} — the directory this session started in`
        }
        onClick={() => void revealItemInDir(cwd).catch(report)}
        className={`max-w-[46%] overflow-hidden text-ellipsis hover:text-ink hover:underline ${
          workspace && !workspace.exists ? 'text-danger' : ''
        }`}
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
          {gitChips(git).map((chip) => (
            <span
              key={chip.key}
              title={chip.title}
              className={CHIP_TONE[chip.tone]}
            >
              {chip.text}
            </span>
          ))}
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
