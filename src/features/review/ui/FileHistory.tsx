import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import {
  type FileCommit,
  type FileHistory as History,
  gitFileLog,
} from '../../../shared/ipc'
import { useKeyedState } from '../../../shared/lib/useKeyedState'
import { Notice } from './Notice'

/** Enough to reach back past an agent's run of commits without a pager. */
const LIMIT = 50

export interface FileHistoryProps {
  cwd: string
  /** Absolute path of the file whose history this is. */
  path: string
  /** Changes when the tree may have moved, which re-reads the log. */
  revision: string
  /** The commit the column is showing, if it is showing one. */
  selected: string | null
  onPick: (entry: FileCommit, root: string) => void
}

type Read = { history: History } | { error: string } | null

/** The commits that changed one file, newest first, each one a click away. */
export function FileHistory({
  cwd,
  path,
  revision,
  selected,
  onPick,
}: FileHistoryProps) {
  const { t } = useTranslation('review')
  // Keyed on the file, not the revision: a re-read as the tree moves keeps
  // the list on screen, and its scroll position with it.
  const [read, setRead] = useKeyedState<Read>([cwd, path], null)
  // A reply lands unless a later request's already has, so a log slower than
  // the tree moves still shows, and an older one never replaces a newer one.
  const asked = useRef(0)
  const shown = useRef(0)

  useEffect(() => {
    const ticket = (asked.current += 1)
    void loadFileLog(cwd, path, (value) => {
      if (ticket < shown.current) return
      shown.current = ticket
      setRead([cwd, path], value)
    })
  }, [cwd, path, revision, setRead])

  return (
    <div
      role="region"
      aria-label={t('history.label')}
      className="max-h-48 flex-none overflow-y-auto border-b border-line bg-chrome"
    >
      {read === null ? (
        <Notice>{t('history.reading')}</Notice>
      ) : 'error' in read ? (
        <Notice tone="text-danger">{read.error}</Notice>
      ) : read.history.commits.length === 0 ? (
        <Notice>{t('history.empty')}</Notice>
      ) : (
        read.history.commits.map((entry) => (
          <button
            key={entry.sha}
            type="button"
            title={`${entry.subject}\n${entry.author} · ${entry.path}`}
            aria-current={entry.sha === selected ? 'true' : undefined}
            onClick={() => onPick(entry, read.history.root)}
            className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-xs ${
              entry.sha === selected
                ? 'bg-surface text-ink'
                : 'text-muted hover:bg-surface-hover hover:text-ink'
            }`}
          >
            <span className="flex-none font-mono text-[10px] text-faint">
              {entry.short}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.subject}</span>
          </button>
        ))
      )}
    </div>
  )
}

const loadFileLog = async (
  cwd: string,
  path: string,
  done: (read: Read) => void,
) => {
  try {
    done({ history: await gitFileLog(cwd, path, LIMIT) })
  } catch (error) {
    done({ error: String(error) })
  }
}
