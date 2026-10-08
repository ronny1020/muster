import type { TFunction } from 'i18next'

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago something was written, at the coarseness a list wants.
 *
 * The times are what their sources hand over: `at` in seconds, as every
 * record's mtime crosses IPC, and `now` in milliseconds, as `Date.now()` gives
 * it. `t` is the caller's, so the label follows the language the caller
 * renders in.
 */
export function agoLabel(
  at: number,
  now: number,
  t: TFunction<'common'>,
): string {
  const seconds = Math.max(0, Math.round(now / 1000) - at)
  if (seconds < MINUTE) return t('justNow')
  if (seconds < HOUR)
    return t('minutesAgo', { count: Math.floor(seconds / MINUTE) })
  if (seconds < DAY) return t('hoursAgo', { count: Math.floor(seconds / HOUR) })
  return t('daysAgo', { count: Math.floor(seconds / DAY) })
}

/** Units an age is worded in, each with how many seconds the next one up holds. */
const SPANS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['second', MINUTE],
  ['minute', HOUR],
  ['hour', DAY],
  ['day', 7 * DAY],
  ['week', 30 * DAY],
  ['month', 365 * DAY],
]

/**
 * An age worded in full, up to years, as a history list says it — "3 weeks
 * ago", 「3 週間前」. `Intl` carries the grammar for every locale, so no
 * catalog is needed. Times are in the same units as `agoLabel`'s.
 */
export function relativeAge(at: number, now: number, locale: string): string {
  const seconds = Math.max(0, Math.round(now / 1000) - at)
  // The count is rounded down, so it is stated as a number: a calendar word
  // such as "last week" names a different span.
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'always' })
  let size = 1
  for (const [unit, next] of SPANS) {
    if (seconds < next) return format.format(-Math.floor(seconds / size), unit)
    size = next
  }
  return format.format(-Math.floor(seconds / (365 * DAY)), 'year')
}
