import type { CSSProperties } from 'react'

import type { Settings } from '../../../entities/preferences/model/settings'
import {
  cellHeight,
  cellSpacing,
  type FontMetrics,
} from '../../../shared/lib/fontmetrics'

/**
 * The terminal's own type, for the code the review panel draws.
 *
 * A diff sitting beside the output it describes has to be the same text: a
 * different font or size makes the column read as another application, and
 * anyone who has set a font for reading code has already chosen the one they
 * want a diff in. The theme is Shiki's rather than xterm's, because a diff
 * needs tints the terminal palette has no colours for.
 *
 * Line height and letter spacing go through the measured metrics rather than
 * straight into CSS: xterm derives both from the font it measured and from
 * device pixels, so the same numbers written as plain CSS give visibly
 * different rows. Without metrics — nothing painted yet — the settings are
 * used as CSS means them, which is close enough to read while they arrive.
 */
export function codeStyle(
  settings: Settings,
  metrics: FontMetrics | null,
): CSSProperties {
  return {
    fontFamily: settings.fontFamily,
    fontSize: `${settings.fontSize}px`,
    lineHeight: metrics
      ? `${cellHeight(metrics, settings.lineHeight)}px`
      : settings.lineHeight,
    letterSpacing: `${
      metrics
        ? cellSpacing(metrics, settings.letterSpacing)
        : settings.letterSpacing
    }px`,
  }
}
