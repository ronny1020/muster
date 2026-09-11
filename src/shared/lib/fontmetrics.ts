import { useEffect, useState } from 'react'

/**
 * The cell size xterm will use for a font, so anything drawn beside a terminal
 * can line up with it.
 *
 * None of this is guesswork: xterm measures the font rather than trusting the
 * size asked for, and its row height is
 * `floor(ceil(measuredHeight × dpr) × lineHeight) / dpr` — so a CSS
 * `line-height: 1.25` on 13px text is nowhere near a terminal at the same
 * setting, because the measured line box of a monospace font is half again its
 * point size. Letter spacing has the same trap: xterm adds it in *device*
 * pixels, which is half as much as CSS on a retina screen.
 */
export interface FontMetrics {
  /** Natural line box of the font at its size, in CSS pixels. */
  natural: number
  dpr: number
}

/** Row height in CSS pixels, matching xterm's own arithmetic exactly. */
export function cellHeight(
  { natural, dpr }: FontMetrics,
  lineHeight: number,
): number {
  return Math.floor(Math.ceil(natural * dpr) * lineHeight) / dpr
}

/** Extra width per character in CSS pixels, from xterm's device-pixel value. */
export function cellSpacing(
  { dpr }: FontMetrics,
  letterSpacing: number,
): number {
  return Math.round(letterSpacing) / dpr
}

/**
 * What a character of this font occupies, measured the way xterm measures it:
 * 32 `W`s in a pre-wrapped span, read back as `offsetHeight`.
 *
 * `null` where there is no layout to measure — a test environment, or a
 * document that has not painted yet — so the caller can fall back rather than
 * lay out against a zero.
 */
export function measureFont(
  fontFamily: string,
  fontSize: number,
): FontMetrics | null {
  if (typeof document === 'undefined') return null

  const probe = document.createElement('span')
  probe.textContent = 'W'.repeat(32)
  probe.setAttribute('aria-hidden', 'true')
  Object.assign(probe.style, {
    position: 'absolute',
    top: '-9999px',
    left: '-9999px',
    whiteSpace: 'pre',
    fontKerning: 'none',
    fontFamily,
    fontSize: `${fontSize}px`,
    lineHeight: 'normal',
  })

  document.body.appendChild(probe)
  const natural = probe.offsetHeight
  probe.remove()

  return natural > 0 ? { natural, dpr: window.devicePixelRatio || 1 } : null
}

/**
 * The metrics of the terminal's font, re-measured when they can change.
 *
 * A webfont that arrives after first paint changes the measurement, which is
 * why this waits for `document.fonts` as well as measuring at once — and a
 * window moved to a display of another density changes the ratio, which
 * arrives as a resize.
 */
export function useFontMetrics(
  fontFamily: string,
  fontSize: number,
): FontMetrics | null {
  const [metrics, setMetrics] = useState<FontMetrics | null>(null)

  useEffect(() => {
    let live = true
    const measure = () => {
      if (live) setMetrics(measureFont(fontFamily, fontSize))
    }

    measure()
    void document.fonts?.ready.then(measure)
    window.addEventListener('resize', measure)
    return () => {
      live = false
      window.removeEventListener('resize', measure)
    }
  }, [fontFamily, fontSize])

  return metrics
}
