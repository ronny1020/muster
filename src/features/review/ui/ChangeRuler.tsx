import { useEffect, useState } from 'react'

/**
 * Where a change sits in the scrolled content, as a fraction of its height.
 */
interface Band {
  top: number
  height: number
  tone: string
}

/** Added and removed, in the tints the rows themselves carry. */
const TONES: Record<string, string> = {
  add: '#3f6f4a',
  del: '#7a3b3b',
}

/**
 * The narrowest band worth drawing, as a fraction of the track.
 *
 * A single row in a thousand-row diff is a fraction of a pixel, which rounds
 * away to nothing — the same reason the scrollbar thumb carries a minimum
 * height. Better a mark one pixel too tall than a change with no mark.
 */
const MIN_BAND = 0.004

/**
 * The marks a pass over the rendered rows finds, merged where they touch.
 *
 * Only the changed rows carry `data-change`, which is what keeps this from
 * filtering thousands of context rows on every pass.
 */
function bandsIn(host: HTMLElement): Band[] {
  const total = host.scrollHeight
  if (total === 0) return []
  const found: Band[] = []
  for (const row of host.querySelectorAll<HTMLElement>('[data-change]')) {
    const tone = TONES[row.dataset.change ?? '']
    if (!tone) continue
    const top = row.offsetTop / total
    const height = Math.max(row.offsetHeight / total, MIN_BAND)
    const last = found[found.length - 1]
    // Consecutive changed rows are one band: a ten-line hunk should read as a
    // block, not as ten marks that happen to touch.
    if (last && last.tone === tone && top <= last.top + last.height + MIN_BAND)
      last.height = Math.max(last.height, top + height - last.top)
    else found.push({ top, height, tone })
  }
  return found
}

/**
 * The changes in a scrolled panel, marked down its scrollbar.
 *
 * The scrollbar says how far through the file you are; this says where the
 * edits are, so a long file with three changed lines does not have to be
 * scrolled to find them. The same idea as the marks on the terminal's own
 * scrollbar, and the same reason — except here the positions come from the
 * rendered rows, because a diff's rows are real elements rather than cells on
 * a canvas.
 *
 * It watches the rows rather than trusting a key. `revision` covers what
 * changes their *layout* without changing the DOM — the wrap setting, the
 * context width — and the observers cover everything else: a re-render as the
 * diff arrives, a file swapped under it, a panel resized. Keying on a string
 * alone is what this started as, and it measured a cold-opened file before the
 * asynchronous `git diff` had landed, so the ruler came up empty for exactly
 * the files it exists to describe.
 */
export function ChangeRuler({
  host,
  revision,
}: {
  /**
   * The scrolled element whose `[data-change]` rows are measured. It must come
   * from state rather than a ref, so this renders again once the node exists,
   * and this must not be inside it — positioned within the scrolled content
   * the marks would scroll away with the rows they describe.
   */
  host: HTMLElement | null
  revision: string
}) {
  const [bands, setBands] = useState<Band[]>([])

  // An effect because it reads layout, which only exists after the rows have
  // been painted — and it has to re-read when the panel is resized.
  useEffect(() => {
    if (!host) return
    let frame = 0
    const measure = () => {
      frame = 0
      setBands(bandsIn(host))
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    // The first measure is synchronous: an occluded window gets no animation
    // frames, so a ruler that waited for one stayed empty until the window
    // came forward — and it looked exactly like finding no changes.
    measure()
    const resized = new ResizeObserver(schedule)
    resized.observe(host)
    // Rows arrive after the read they come from resolves, which no size change
    // announces. Coalesced into a frame, so one batch of thousands costs one
    // measure.
    const changed = new MutationObserver(schedule)
    changed.observe(host, {
      childList: true,
      subtree: true,
      attributeFilter: ['data-change'],
    })
    return () => {
      resized.disconnect()
      changed.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [host, revision])

  if (bands.length === 0) return null
  return (
    // Inert to the pointer: it sits over the scrollbar's own lane, and a drag
    // that started here would be a drag the bar never sees.
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 right-0 bottom-0 w-2.5"
    >
      {bands.map(({ top, height, tone }, index) => (
        <div
          key={index}
          className="absolute right-0 w-1.5"
          style={{
            top: `${top * 100}%`,
            height: `${height * 100}%`,
            backgroundColor: tone,
          }}
        />
      ))}
    </div>
  )
}
