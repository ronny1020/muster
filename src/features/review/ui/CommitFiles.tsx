import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { sortChanges } from '../model/changes'
import type { Viewed } from '../model/viewed'
import { ChangedFiles } from './ChangedFiles'
import {
  type ChangedFile,
  type Changes,
  type Commit,
  gitCommitFiles,
} from '../../../shared/ipc'
import { useKeyedState } from '../../../shared/lib/useKeyedState'
import { Notice } from './Notice'

export interface CommitFilesProps {
  cwd: string
  commit: Commit
  /** What the file column is showing, so the row being read is marked. */
  viewed: Viewed | null
  onOpen: (file: ChangedFile, root: string) => void
}

type Read = { changes: Changes } | { error: string } | null

/**
 * The files one commit changed, as the Changes view lists the working tree's.
 *
 * A commit never changes, so this reads once per commit rather than on the
 * tree's revision.
 */
export function CommitFiles({ cwd, commit, viewed, onOpen }: CommitFilesProps) {
  const { t } = useTranslation('review')
  const [read, setRead] = useKeyedState<Read>([cwd, commit.sha], null)

  useEffect(() => {
    void loadCommitFiles(cwd, commit.sha, (value) =>
      setRead([cwd, commit.sha], value),
    )
  }, [cwd, commit.sha, setRead])

  if (read === null) return <Notice>{t('commit.reading')}</Notice>
  if ('error' in read) return <Notice tone="text-danger">{read.error}</Notice>
  if (read.changes.files.length === 0)
    return <Notice>{t('commit.empty')}</Notice>

  const selected =
    viewed?.kind === 'diff' && viewed.commit?.sha === commit.sha
      ? viewed.relative
      : null
  return (
    <ChangedFiles
      files={sortChanges(read.changes.files)}
      selected={selected}
      onSelect={(file) => onOpen(file, read.changes.root)}
    />
  )
}

const loadCommitFiles = async (
  cwd: string,
  sha: string,
  done: (read: Read) => void,
) => {
  try {
    done({ changes: await gitCommitFiles(cwd, sha) })
  } catch (error) {
    done({ error: String(error) })
  }
}
