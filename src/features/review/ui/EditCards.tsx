import { type FocusEvent, type PointerEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { basename, folderOf } from '../model/changes'
import type { Edit } from '../model/edits'
import { Icon } from '../../../shared/ui/Icon'
import { FileTypeIcon } from '../../../shared/ui/FileTypeIcon'
import { EditBar, EditCounts, EditLines } from './EditLines'

export interface EditCardsProps {
  /** The pane's feed, newest first. */
  edits: Edit[]
  /** Clear of the find bar, which sits in the same corner. */
  lowered: boolean
  /**
   * The tab's agent colour. The cards sit beside the terminal rather than in
   * it, so they do not inherit the `agent` token the terminal sets.
   */
  accent: string
  onOpen: (edit: Edit) => void
  /** Absent when the Activity view is off, and the overflow line says less. */
  onShowAll?: () => void
}

/** Cards on screen at once; the rest are summarised in one line. */
const SHOWN = 3

/** Lines of an edit a card draws: a glimpse, the diff is a click away. */
const CARD_LINES = 6

/**
 * A card over the terminal for each file that changes in the tab's working
 * tree, newest on top.
 *
 * Each card lives as long as its CSS animation and is cleared on
 * `animationend`, so no timer runs in any pane — and since a hidden pane
 * draws nothing, a tab you return to shows what landed while you were away,
 * then lets it go. While the pointer or focus is anywhere in the stack, every
 * card pauses and the stack stops changing: a card that moved or vanished
 * under a pointer or a keyboard user would take the click or the focus with
 * it. The oldest card ending clears the backlog behind it, so a backlog never
 * drips out three at a time; any other card goes alone.
 */
export function EditCards({
  edits,
  lowered,
  accent,
  onOpen,
  onShowAll,
}: EditCardsProps) {
  const { t } = useTranslation('review')
  // Whatever was in the feed when the cards mounted has been seen, or was
  // made while they were switched off; neither is news.
  const [cleared, setCleared] = useState(() => edits[0]?.id ?? 0)
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set())
  const [held, setHeld] = useState<Hold | null>(null)
  const live = (edit: Edit) => edit.id > cleared && !dismissed.has(edit.id)
  const pending = edits.filter(live)
  // A hold with nothing left in it holds nothing: its last card was
  // dismissed, and the stack unmounting would leave no event to release it.
  const kept = held?.cards.filter(live)
  const shown = kept?.length ? kept : pending.slice(0, SHOWN)
  if (shown.length === 0) return null
  const hidden = Math.max(0, pending.length - shown.length)
  const oldest = shown[shown.length - 1].id

  const enter = (by: 'pointer' | 'focus') => () =>
    setHeld((was) => ({
      pointer: false,
      focus: false,
      ...was,
      cards: was?.cards.some(live) ? was.cards : shown,
      [by]: true,
    }))
  // Pointer and focus hold separately: the mouse passing over and out must
  // not release a stack a keyboard user is still in, nor the reverse.
  const leave =
    (by: 'pointer' | 'focus') => (event: FocusEvent | PointerEvent) => {
      const next = event.relatedTarget
      if (next instanceof Node && event.currentTarget.contains(next)) return
      setHeld((was) => {
        if (!was) return null
        const still = { ...was, [by]: false }
        return still.pointer || still.focus ? still : null
      })
    }
  const done = (edit: Edit) => {
    if (edit.id === oldest) setCleared((was) => Math.max(was, edit.id))
    else setDismissed((was) => new Set(was).add(edit.id))
  }

  return (
    <div
      role="log"
      aria-label={t('edits.cards')}
      style={Object.fromEntries([['--color-agent', accent]])}
      onPointerOver={enter('pointer')}
      onPointerOut={leave('pointer')}
      onFocus={enter('focus')}
      onBlur={leave('focus')}
      className={`group pointer-events-none absolute right-10 z-20 flex w-[320px] max-w-[60%] flex-col ${
        lowered ? 'top-14' : 'top-3'
      }`}
    >
      {shown.map((edit) => (
        // The space between cards is the wrapper's padding rather than a gap,
        // so the pointer never crosses the terminal on its way between two.
        <div key={edit.id} className="pointer-events-auto pb-1.5">
          <Card
            edit={edit}
            onOpen={() => onOpen(edit)}
            onDone={() => done(edit)}
            onDismiss={() => setDismissed((was) => new Set(was).add(edit.id))}
          />
        </div>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={onShowAll}
          disabled={!onShowAll}
          className="pointer-events-auto self-end rounded-md border border-line bg-chrome/95 px-2 py-0.5 text-[10px] text-muted shadow-lg backdrop-blur-sm enabled:hover:text-ink"
        >
          {t('edits.more', { count: hidden })}
        </button>
      )}
    </div>
  )
}

/** The stack frozen as it was when the pointer or focus came in. */
interface Hold {
  cards: Edit[]
  pointer: boolean
  focus: boolean
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
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('edits.dismiss')}
          title={t('edits.dismiss')}
          className="flex size-4 flex-none items-center justify-center rounded-sm text-faint hover:bg-surface-hover hover:text-ink"
        >
          <Icon name="close" className="size-3" />
        </button>
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
