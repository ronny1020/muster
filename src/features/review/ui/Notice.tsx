import type { ReactNode } from 'react'

/**
 * A line of status in a review surface — "Reading…", an error, a cap.
 *
 * A status region, because these replace each other as reads land, and a
 * change nobody is told about is a change a screen reader never hears. Never
 * selectable, since a cap notice sits inside the code a copy is taken from.
 */
export const Notice = ({
  children,
  tone = 'text-faint',
}: {
  children: ReactNode
  tone?: string
}) => (
  <p
    role="status"
    className={`m-0 px-2.5 py-3 text-[11px] select-none ${tone}`}
  >
    {children}
  </p>
)
