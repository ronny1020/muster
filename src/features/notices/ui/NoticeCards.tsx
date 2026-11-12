import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { DismissButton } from '../../../shared/ui/DismissButton'
import { useFrozen } from '../../../shared/lib/useHold'
import {
  isFailure,
  isSticky,
  type Notice,
  type NoticeCard,
} from '../model/notices'

export interface NoticeCardsProps {
  cards: NoticeCard[]
  /** The pointer or focus is in the corner, which freezes what is drawn. */
  holding: boolean
  onOpen: (notice: Notice) => void
  onDismiss: (notice: Notice) => void
}

/** Cards drawn at once; the rest wait behind a count. */
const SHOWN = 3

/**
 * News from the other tabs, in the corner of the one with the keyboard.
 *
 * A card that waits for you stays until its state clears or you dismiss it;
 * the rest fade on their own CSS animation and are dropped on `animationend`,
 * so no timer runs. While `holding`, every card pauses and what is drawn is
 * frozen — the cards and the count both: a card arriving, replaced or cleared
 * would otherwise move the one under the pointer, and the click would land on
 * another tab's.
 */
export function NoticeCards({
  cards,
  holding,
  onOpen,
  onDismiss,
}: NoticeCardsProps) {
  const { t } = useTranslation('chrome')
  const live = {
    cards: cards.slice(0, SHOWN),
    hidden: Math.max(0, cards.length - SHOWN),
  }
  // Mounting into a held corner draws nothing yet: cards appearing would push
  // the edit cards below them out from under the pointer.
  const { frozen, refreeze } = useFrozen(holding, (mounting) =>
    mounting ? { cards: [], hidden: 0 } : live,
  )
  const { cards: shown, hidden } = frozen ?? live
  if (shown.length === 0) return null
  // A card acted on leaves the snapshot too, or it would stay under the
  // pointer looking as if the click did nothing.
  const leaveSnapshot = (notice: Notice) =>
    refreeze((was) => ({
      ...was,
      cards: was.cards.filter((card) => card.notice.id !== notice.id),
    }))

  return (
    <div role="log" aria-label={t('notices.label')} className="flex flex-col">
      {shown.map((card) => (
        <div key={card.notice.id} className="pointer-events-auto pb-1.5">
          <Card
            card={card}
            onOpen={() => {
              leaveSnapshot(card.notice)
              onOpen(card.notice)
            }}
            onDismiss={() => {
              leaveSnapshot(card.notice)
              onDismiss(card.notice)
            }}
          />
        </div>
      ))}
      {hidden > 0 && (
        // Padding, not margin, so the pointer never leaves the corner on its
        // way to the edit cards below.
        <div className="pointer-events-auto flex justify-end pb-1.5">
          <span className="rounded-md border border-line bg-chrome/95 px-2 py-0.5 text-[10px] text-muted shadow-lg backdrop-blur-sm">
            {t('notices.more', { count: hidden })}
          </span>
        </div>
      )}
    </div>
  )
}

interface CardProps {
  card: NoticeCard
  onOpen: () => void
  onDismiss: () => void
}

function Card({ card, onOpen, onDismiss }: CardProps) {
  const { t } = useTranslation('chrome')
  const { notice, title, agent, accent } = card
  const sticky = isSticky(notice)
  const wrong = isFailure(notice)
  const { headline, detail } = wording(card, t)
  const name = agent && agent !== title ? `${agent} · ${title}` : title
  return (
    <div
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
      style={wrong ? undefined : { borderLeftColor: accent }}
      className={`overflow-hidden rounded-lg border border-l-2 border-line bg-chrome/95 shadow-xl backdrop-blur-sm ${
        wrong ? 'border-l-danger' : 'border-l-primary'
      } ${
        sticky
          ? ''
          : 'animate-edit-card group-focus-within:[animation-play-state:paused] group-hover:[animation-play-state:paused]'
      }`}
    >
      <div className="flex items-start gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        >
          <span className="truncate text-[10px] text-faint">{name}</span>
          <span
            className={`truncate text-xs ${
              wrong ? 'text-danger' : 'text-ink'
            } ${notice.kind === 'command' ? 'font-mono' : ''}`}
          >
            {headline}
          </span>
          {detail && (
            <span className="line-clamp-2 text-[11px] break-words text-muted">
              {detail}
            </span>
          )}
        </button>
        <DismissButton label={t('notices.dismiss')} onClick={onDismiss} />
      </div>
    </div>
  )
}

/** What a card says: one line that names the news, and the words behind it. */
function wording(
  { notice, others }: NoticeCard,
  t: TFunction<'chrome'>,
): { headline: string; detail?: string } {
  switch (notice.kind) {
    case 'asking':
      return { headline: t('notices.asking') }
    case 'stopped':
      return notice.code === null
        ? { headline: t('notices.turnFailed'), detail: notice.said }
        : {
            headline: t('notices.exited', {
              code: notice.code,
              context: isFailure(notice) ? 'failed' : undefined,
            }),
            detail: notice.said,
          }
    case 'finished':
      return { headline: t('notices.finished'), detail: notice.said }
    case 'command':
      return {
        headline: notice.command,
        detail: t('notices.commandDone', {
          code: notice.code,
          duration: duration(notice.ms, t),
          context: notice.code === null ? undefined : 'code',
        }),
      }
    case 'committed':
      return {
        headline: t('notices.committed', { branch: notice.branch }),
        detail: notice.subject,
      }
    case 'conflict':
      return { headline: t('notices.conflict', { count: notice.count }) }
    case 'gitFailed':
      return {
        headline: t('notices.gitFailed'),
        detail: notice.text.split('\n').at(-1),
      }
    case 'collision':
      return {
        headline: notice.path,
        detail: t('notices.collision', { tabs: others.join(', ') }),
      }
  }
}

/** A run's length the way a person says it: `42s`, `2m 14s`, `1h 3m`. */
function duration(ms: number, t: TFunction<'chrome'>) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return t('notices.seconds', { s: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('notices.minutes', { m: minutes, s: seconds % 60 })
  return t('notices.hours', { h: Math.floor(minutes / 60), m: minutes % 60 })
}
