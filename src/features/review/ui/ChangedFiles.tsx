import { useTranslation } from 'react-i18next'

import { basename, folderOf, statusMark, statusTone } from '../model/changes'
import type { Edit } from '../model/edits'
import { FileTypeIcon } from '../../../shared/ui/FileTypeIcon'
import type { ChangedFile } from '../../../shared/ipc'
import { currentLocale } from '../../../shared/i18n/i18n'
import { Notice } from './Notice'
import { freshPulse, NO_PULSES, Pulse, type Pulses } from './Pulse'

export interface ChangedFilesProps {
  files: ChangedFile[]
  /**
   * Which rows flash, keyed by repo-relative path. Absent for a commit's
   * files, which are history and never being edited.
   */
  pulses?: Pulses
  /** Repo-relative path of the file being read, if any. */
  selected: string | null
  onSelect: (file: ChangedFile) => void
}

/**
 * Rows drawn at once. A commit or a tree can change tens of thousands of files
 * — a vendored directory, a generated one — and every row is several elements
 * laid out on the thread that draws the window.
 */
const MAX_ROWS = 5000

/** The changed-file list: what to read, in the order it sits on disk. */
export function ChangedFiles({
  files,
  pulses = NO_PULSES,
  selected,
  onSelect,
}: ChangedFilesProps) {
  const { t } = useTranslation('review')
  return (
    <div>
      {files.slice(0, MAX_ROWS).map((file) => (
        <Row
          key={file.path}
          file={file}
          pulse={freshPulse(pulses, file.path)}
          active={file.path === selected}
          onSelect={() => onSelect(file)}
        />
      ))}
      {files.length > MAX_ROWS && (
        <Notice tone="text-[#d8b165]">
          {t('list.filesCapped', {
            shown: MAX_ROWS.toLocaleString(currentLocale()),
            total: files.length.toLocaleString(currentLocale()),
          })}
        </Notice>
      )}
    </div>
  )
}

interface RowProps {
  file: ChangedFile
  /** The edit to flash for, if this row has just been edited. */
  pulse?: Edit
  active: boolean
  onSelect: () => void
}

function Row({ file, pulse, active, onSelect }: RowProps) {
  const folder = folderOf(file.path)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      className={`relative flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs ${
        active ? 'bg-surface text-ink' : 'hover:bg-surface-hover'
      }`}
    >
      <Pulse edit={pulse} />
      <span
        aria-hidden="true"
        className={`w-2.5 flex-none text-center font-mono text-[10px] ${statusTone(
          file.status,
        )}`}
      >
        {statusMark(file.status)}
      </span>
      <FileTypeIcon path={file.path} />
      <span className="truncate text-ink">{basename(file.path)}</span>
      {/* Always present, empty or not: it is what pushes the counts to the
          right edge, so a file at the repository root lines up with the rest. */}
      <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
        {folder}
      </span>
      <Counts file={file} />
    </button>
  )
}

/** `+12 −3`, or the word "binary" where lines mean nothing. */
function Counts({ file }: { file: ChangedFile }) {
  const { t } = useTranslation('review')
  if (file.binary) {
    return (
      <span className="flex-none text-[10px] text-faint">
        {t('list.binary')}
      </span>
    )
  }
  if (!file.counted) {
    // Not counted is not zero, and a blank column reads as an empty file.
    // Both reasons are named because the backend has two and the row cannot
    // tell which applied: there were too many new files to read them all, or
    // this one is reached through a symlink and is not followed.
    return (
      <span
        title={t('list.notCounted')}
        className="flex-none text-[10px] text-faint"
      >
        —
      </span>
    )
  }
  return (
    <span className="flex-none font-mono text-[10px] tabular-nums">
      {file.insertions > 0 && (
        <span className="text-[#7fb37a]">+{file.insertions}</span>
      )}
      {file.deletions > 0 && (
        <span className="pl-1 text-danger">−{file.deletions}</span>
      )}
    </span>
  )
}
