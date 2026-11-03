import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { basename, folderOf } from '../model/changes'
import type { Edit } from '../model/edits'
import { Icon } from '../../../shared/ui/Icon'
import { FileTypeIcon } from '../../../shared/ui/FileTypeIcon'
import { currentLocale } from '../../../shared/i18n/i18n'
import { StatusWord } from './EditCards'
import { EditBar, EditCounts, EditLines } from './EditLines'

export interface EditActivityProps {
  /** Newest first. */
  edits: Edit[]
  onOpen: (edit: Edit) => void
}

/** Lines an expanded entry draws before pointing at the full diff. */
const ENTRY_LINES = 40

/**
 * Every edit this tab has seen, newest first, as a timeline: when, which
 * file, how much. An entry opens to the lines that edit wrote — not the
 * file's whole diff, which is one click further.
 */
export function EditActivity({ edits, onOpen }: EditActivityProps) {
  const { t } = useTranslation('review')
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set())
  if (edits.length === 0) {
    return (
      <p role="status" className="m-0 px-2.5 py-3 text-[11px] text-faint">
        {t('edits.none')}
      </p>
    )
  }
  const toggle = (id: number) =>
    setOpen((was) => {
      const next = new Set(was)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <ol
      role="log"
      aria-label={t('panel.activity')}
      className="m-0 list-none p-0"
    >
      {edits.map((edit) => (
        <Entry
          key={edit.id}
          edit={edit}
          expanded={open.has(edit.id)}
          onToggle={() => toggle(edit.id)}
          onOpen={() => onOpen(edit)}
        />
      ))}
    </ol>
  )
}

interface EntryProps {
  edit: Edit
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
}

function Entry({ edit, expanded, onToggle, onOpen }: EntryProps) {
  const { t } = useTranslation('review')
  return (
    <li className="border-b border-line/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={edit.path}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-surface-hover"
      >
        <Icon
          name="chevron_right"
          className={`size-3.5 flex-none text-faint transition-transform ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <time
          dateTime={new Date(edit.at).toISOString()}
          className="flex-none text-[10px] text-faint tabular-nums"
        >
          {new Date(edit.at).toLocaleTimeString(currentLocale())}
        </time>
        <FileTypeIcon path={edit.path} />
        <span className="truncate text-ink">{basename(edit.path)}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
          {folderOf(edit.path)}
        </span>
        <StatusWord edit={edit} />
        <EditCounts edit={edit} />
        <EditBar edit={edit} />
      </button>
      {expanded && (
        <div className="pb-1.5 pl-6">
          {edit.lines.length > 0 ? (
            <EditLines lines={edit.lines} limit={ENTRY_LINES} />
          ) : (
            <p className="m-0 py-1 text-[11px] text-faint">
              {t('edits.noLines')}
            </p>
          )}
          {edit.status !== null && (
            <button
              type="button"
              onClick={onOpen}
              className="mt-1 text-[11px] text-primary hover:underline"
            >
              {t('edits.openDiff')}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
