import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { basename, folderOf } from '../model/changes'
import type { Edit } from '../model/edits'
import { DismissButton } from '../../../shared/ui/DismissButton'
import { useFrozen } from '../../../shared/lib/useHold'
import { FileTypeIcon } from '../../../shared/ui/FileTypeIcon'
import { EditBar, EditCounts, EditLines } from './EditLines'

export interface EditCardsProps {
  /** The pane's feed, newest first. */
  edits: Edit[]
  /** The pointer or focus is in the corner, which freezes what is drawn. */
  holding: boolean
  /**
   * The tab's agent colour. The cards sit beside the terminal rather than in
   * it, so they do not inherit the `agent` token the terminal sets.
   */
  accent: string
  onOpen: (edit: Edit) => void
  /**
   * Opens the Activity view. Absent when Activity is off; the folded card
   * then opens the newest edit's diff.
   */
  onShowAll?: () => void
}

/** Cards drawn one by one; more than this fold into one card for them all. */
const SHOWN = 3

/** Lines of an edit a card draws: a glimpse, the diff is a click away. */
const CARD_LINES = 6

/**
 * A card over the terminal for each file that changes in the tab's working
 * tree, newest on top — or, once more land than fit, one card for them all.
 *
 * Each card lives as long as its CSS animation and is cleared on
 * `animationend`, so no timer runs in any pane — and since a hidden pane
 * draws nothing, a tab you return to shows what landed while you were away,
 * then lets it go. While `holding`, every card pauses and the stack stops
 * changing: a card that moved or vanished under a pointer or a keyboard user
 * would take the click or the focus with it. The oldest card ending clears
 * the cards behind it, so they never drip out one at a time; any other card
 * goes alone.
 */
export function EditCards({
  edits,
  holding,
  accent,
  onOpen,
  onShowAll,
}: EditCardsProps) {
  const { t } = useTranslation('review')
  // Whatever was in the feed when the cards mounted has been seen, or was
  // made while they were switched off; neither is news.
  const [cleared, setCleared] = useState(() => edits[0]?.id ?? 0)
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const live = (edit: Edit) => edit.id > cleared && !dismissed.has(edit.id)
  const pending = edits.filter(live)
  const { frozen } = useFrozen(holding, () => pending)
  const shown = frozen?.filter(live) ?? pending
  if (shown.length === 0) return null
  const oldest = shown[shown.length - 1].id
  const done = (edit: Edit) => {
    if (edit.id === oldest) setCleared((was) => Math.max(was, edit.id))
    else setDismissed((was) => new Set(was).add(edit.id))
  }
  const burst = shown.length > SHOWN

  return (
    <div
      role="log"
      aria-label={t('edits.cards')}
      style={Object.fromEntries([['--color-agent', accent]])}
      className="flex flex-col"
    >
      {burst ? (
        <div className="pointer-events-auto pb-1.5">
          <Burst
            key={shown[0].id}
            edits={shown}
            onOpen={onShowAll ?? (() => onOpen(shown[0]))}
            onDone={() => setCleared((was) => Math.max(was, shown[0].id))}
          />
        </div>
      ) : (
        shown.map((edit) => (
          // The space between cards is the wrapper's padding rather than a
          // gap, so the pointer never crosses the terminal between two.
          <div key={edit.id} className="pointer-events-auto pb-1.5">
            <Card
              edit={edit}
              onOpen={() => onOpen(edit)}
              onDone={() => done(edit)}
              onDismiss={() => setDismissed((was) => new Set(was).add(edit.id))}
            />
          </div>
        ))
      )}
    </div>
  )
}

/**
 * A run of edits too quick to read one by one, as one card.
 *
 * Keyed on the newest edit, so each one that lands starts its life again and
 * it goes once the run has been quiet for a card's lifetime. The stack's hold
 * freezes it like the single cards, so it never remounts under the pointer.
 */
function Burst({
  edits,
  onOpen,
  onDone,
}: {
  edits: Edit[]
  onOpen: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('review')
  const files = [...new Set(edits.map((edit) => edit.path))]
  const added = edits.reduce((sum, edit) => sum + edit.added, 0)
  const removed = edits.reduce((sum, edit) => sum + edit.removed, 0)
  return (
    <div
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onDone()
      }}
      className="animate-edit-card overflow-hidden rounded-lg border border-l-2 border-line border-l-agent bg-chrome/95 shadow-xl backdrop-blur-sm group-focus-within:[animation-play-state:paused] group-hover:[animation-play-state:paused]"
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        >
          <span className="text-xs text-ink">
            {t('edits.burst', { count: files.length, added, removed })}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-[10px] text-faint">
            {files.slice(0, 4).map((path) => (
              <span key={path} className="flex min-w-0 items-center gap-1">
                <FileTypeIcon path={path} />
                <span className="truncate">{basename(path)}</span>
              </span>
            ))}
          </span>
        </button>
        <DismissButton label={t('edits.dismiss')} onClick={onDone} />
      </div>
    </div>
  )
}

interface CardProps {
  edit: Edit
  onOpen: () => void
  /** Its animation ended. */
  onDone: () => void
  /** Its ✕: this card only, never the backlog behind it. */
  onDismiss: () => void
}

function Card({ edit, onOpen, onDone, onDismiss }: CardProps) {
  const { t } = useTranslation('review')
  return (
    <div
      // Its own animation only: `animationend` bubbles, and the bar's blocks
      // finish theirs within a second.
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onDone()
      }}
      className="pointer-events-auto animate-edit-card overflow-hidden rounded-lg border border-l-2 border-line border-l-agent bg-chrome/95 shadow-xl backdrop-blur-sm group-focus-within:[animation-play-state:paused] group-hover:[animation-play-state:paused]"
    >
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={onOpen}
          title={t('edits.open', { path: edit.path })}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <FileTypeIcon path={edit.path} />
          <span className="truncate text-xs text-ink">
            {basename(edit.path)}
          </span>
          <span className="min-w-0 truncate text-[10px] text-faint">
            {folderOf(edit.path)}
          </span>
          <span className="flex-1" />
          <StatusWord edit={edit} />
          <EditCounts edit={edit} />
          <EditBar edit={edit} />
        </button>
        <DismissButton label={t('edits.dismiss')} onClick={onDismiss} />
      </div>
      {edit.lines.length > 0 && (
        <button
          type="button"
          onClick={onOpen}
          tabIndex={-1}
          aria-hidden="true"
          className="block w-full border-t border-line text-left"
        >
          <EditLines lines={edit.lines} limit={CARD_LINES} />
        </button>
      )}
    </div>
  )
}

/** Said only when the edit is more than a change to an existing file. */
export function StatusWord({ edit }: { edit: Edit }) {
  const { t } = useTranslation('review')
  const word =
    edit.status === null
      ? t('edits.reverted')
      : edit.status === 'added' || edit.status === 'untracked'
        ? t('edits.created')
        : edit.status === 'deleted'
          ? t('edits.deleted')
          : null
  if (!word) return null
  return (
    <span className="flex-none rounded-sm bg-surface px-1 text-[9px] text-muted uppercase">
      {word}
    </span>
  )
}
