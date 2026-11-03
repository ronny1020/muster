import { useTranslation } from 'react-i18next'

import { useSettings } from '../../../entities/preferences/model/useSettings'

import type { DiffLine } from '../model/diff'
import { barSplit, type Edit } from '../model/edits'

/** The tints the diff view uses, so an edit reads as the same thing there. */
const TONE = {
  add: 'bg-[#1e3024] text-[#b5d8b0]',
  del: 'bg-[#33211f] text-[#e8b0aa]',
} as const

/** The lines an edit wrote, each tinted and marked, `limit` at most. */
export function EditLines({
  lines,
  limit,
}: {
  lines: DiffLine[]
  limit: number
}) {
  const { t } = useTranslation('review')
  const { settings } = useSettings()
  const shown = lines.slice(0, limit)
  return (
    <div
      // The terminal's family at a glance size: a card's lines are a glimpse
      // of the same code the output beside it shows.
      style={{ fontFamily: settings.fontFamily }}
      className="overflow-hidden text-[11px] leading-4"
    >
      {shown.map((line, index) => {
        const kind = line.kind === 'del' ? 'del' : 'add'
        return (
          <div
            // Lines repeat (`}`), and the list never reorders, so the index
            // is the identity here.
            key={index}
            className={`flex whitespace-pre ${TONE[kind]}`}
          >
            <span aria-hidden="true" className="w-4 flex-none text-center">
              {kind === 'add' ? '+' : '-'}
            </span>
            <span className="sr-only">
              {t(kind === 'add' ? 'diff.added' : 'diff.removed')}{' '}
            </span>
            <span className="min-w-0 truncate pr-2">{line.text || ' '}</span>
          </div>
        )
      })}
      {lines.length > limit && (
        <div className="px-4 text-[10px] text-faint">
          {t('edits.moreLines', { count: lines.length - limit })}
        </div>
      )}
    </div>
  )
}

/** Five blocks split between added and removed, the way GitHub draws it. */
export function EditBar({ edit }: { edit: Edit }) {
  const [green, red] = barSplit(edit.added, edit.removed)
  return (
    <span aria-hidden="true" className="flex flex-none gap-px">
      {Array.from({ length: 5 }, (_, index) => (
        <span
          key={index}
          // Staggered, so the bar fills left to right as the card arrives.
          style={{ animationDelay: `${120 + index * 60}ms` }}
          className={`size-1.5 animate-edit-bar rounded-[1px] ${
            index < green
              ? 'bg-[#7fb37a]'
              : index < green + red
                ? 'bg-danger'
                : 'bg-line'
          }`}
        />
      ))}
    </span>
  )
}

/** `+12 −3`, with only the halves that are not zero. */
export function EditCounts({ edit }: { edit: Edit }) {
  return (
    <span className="flex-none font-mono text-[10px] tabular-nums">
      {edit.added > 0 && <span className="text-[#7fb37a]">+{edit.added}</span>}
      {edit.removed > 0 && (
        <span className="pl-1 text-danger">−{edit.removed}</span>
      )}
    </span>
  )
}
