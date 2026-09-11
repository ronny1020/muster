import type { Backend } from '../../../shared/lib/platform'
import { DEFAULT_THEME_ID, THEMES } from '../../../shared/lib/themes'

/**
 * User settings, persisted in `localStorage`. Loading is total: anything
 * missing, mistyped or out of range falls back to the default rather than
 * breaking the window, since a bad value here would leave nothing to fix it in.
 */
export interface Settings {
  /** Agent selected when a new tab opens. */
  defaultAgentId: string
  /** Directory a new tab starts on; empty means the last used, then home. */
  defaultDirectory: string
  /** Where a new tab's session runs. Only Windows offers anything but the host. */
  defaultBackend: Backend
  /** Which WSL distro a `wsl` session uses; empty means the default one. */
  defaultDistro: string
  /** Terminal colour scheme, by id. */
  themeId: string
  fontFamily: string
  fontSize: number
  lineHeight: number
  /**
   * Extra width given to every character, in whole pixels. xterm calls it
   * letter spacing; it is the horizontal partner of line height, and the
   * settings pane says "Text width" because that is what it looks like.
   */
  letterSpacing: number
  scrollback: number
  cursorBlink: boolean
  /** How often a tab re-reads its git state, in seconds. */
  gitPollSeconds: number
  /** Commits the history drawer fetches. */
  historyLimit: number
  /** Editor command the status bar opens a directory with; empty means the
   *  first one this machine has. */
  editorCommand: string
  /** Raise a desktop notification when a session signals it is done. */
  notifyOnDone: boolean
  /** Stay quiet while the user is already looking at that very tab. */
  notifyOnlyWhenUnfocused: boolean
  notifySound: boolean
  /** Image drawn behind the terminal; empty for the plain background. */
  backgroundImage: string
  /** Brightness applied to that image, as a percentage. */
  backgroundBrightness: number
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgentId: 'claude',
  defaultDirectory: '',
  defaultBackend: 'native',
  defaultDistro: '',
  themeId: DEFAULT_THEME_ID,
  fontFamily:
    '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  letterSpacing: 0,
  scrollback: 20000,
  cursorBlink: true,
  gitPollSeconds: 4,
  historyLimit: 60,
  editorCommand: '',
  notifyOnDone: true,
  notifyOnlyWhenUnfocused: true,
  notifySound: true,
  backgroundImage: '',
  // Wallpaper at full brightness makes terminal text unreadable, so the
  // default is already dimmed — the setting is there to bring it back up.
  backgroundBrightness: 35,
}

export const LIMITS = {
  fontSize: { min: 9, max: 28, step: 1 },
  lineHeight: { min: 1, max: 2, step: 0.05 },
  // Whole pixels only: xterm rounds, so a half-pixel would read as no change.
  letterSpacing: { min: -2, max: 8, step: 1 },
  scrollback: { min: 1000, max: 200000, step: 1000 },
  gitPollSeconds: { min: 1, max: 60, step: 1 },
  historyLimit: { min: 10, max: 500, step: 10 },
  backgroundBrightness: { min: 5, max: 100, step: 5 },
} as const

const STORAGE_KEY = 'muster.settings'

export function normalizeSettings(input: unknown): Settings {
  const raw = (
    typeof input === 'object' && input !== null ? input : {}
  ) as Record<string, unknown>

  return {
    defaultAgentId: text(raw.defaultAgentId, DEFAULT_SETTINGS.defaultAgentId),
    defaultDirectory: text(
      raw.defaultDirectory,
      DEFAULT_SETTINGS.defaultDirectory,
      true,
    ),
    defaultBackend: raw.defaultBackend === 'wsl' ? 'wsl' : 'native',
    defaultDistro: text(
      raw.defaultDistro,
      DEFAULT_SETTINGS.defaultDistro,
      true,
    ),
    // Validated against the table rather than kept as typed: a stored id for a
    // theme that no longer exists must not leave the terminal unstyled.
    themeId:
      typeof raw.themeId === 'string' && raw.themeId in THEMES
        ? raw.themeId
        : DEFAULT_SETTINGS.themeId,
    fontFamily: text(raw.fontFamily, DEFAULT_SETTINGS.fontFamily),
    fontSize: number(raw.fontSize, DEFAULT_SETTINGS.fontSize, LIMITS.fontSize),
    lineHeight: number(
      raw.lineHeight,
      DEFAULT_SETTINGS.lineHeight,
      LIMITS.lineHeight,
    ),
    letterSpacing: number(
      raw.letterSpacing,
      DEFAULT_SETTINGS.letterSpacing,
      LIMITS.letterSpacing,
    ),
    scrollback: number(
      raw.scrollback,
      DEFAULT_SETTINGS.scrollback,
      LIMITS.scrollback,
    ),
    cursorBlink: flag(raw.cursorBlink, DEFAULT_SETTINGS.cursorBlink),
    gitPollSeconds: number(
      raw.gitPollSeconds,
      DEFAULT_SETTINGS.gitPollSeconds,
      LIMITS.gitPollSeconds,
    ),
    historyLimit: number(
      raw.historyLimit,
      DEFAULT_SETTINGS.historyLimit,
      LIMITS.historyLimit,
    ),
    editorCommand: text(
      raw.editorCommand,
      DEFAULT_SETTINGS.editorCommand,
      true,
    ),
    notifyOnDone: flag(raw.notifyOnDone, DEFAULT_SETTINGS.notifyOnDone),
    notifyOnlyWhenUnfocused: flag(
      raw.notifyOnlyWhenUnfocused,
      DEFAULT_SETTINGS.notifyOnlyWhenUnfocused,
    ),
    notifySound: flag(raw.notifySound, DEFAULT_SETTINGS.notifySound),
    // Not through `text()`: it trims, and a filename may legally end in a
    // space — trimming would silently point at a different file.
    backgroundImage:
      typeof raw.backgroundImage === 'string'
        ? raw.backgroundImage
        : DEFAULT_SETTINGS.backgroundImage,
    backgroundBrightness: number(
      raw.backgroundBrightness,
      DEFAULT_SETTINGS.backgroundBrightness,
      LIMITS.backgroundBrightness,
    ),
  }
}

export function loadSettings(): Settings {
  try {
    return normalizeSettings(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'),
    )
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* private browsing or a full quota: the session keeps its settings anyway */
  }
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function text(value: unknown, fallback: string, allowEmpty = false): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || allowEmpty ? trimmed : fallback
}

function number(
  value: unknown,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  // Coerced on purpose: a hand-edited `"15"` is repaired rather than discarded,
  // which is the same "loading must be total" rule the rest of this file
  // follows. `a_numeric_string_is_accepted` pins it.
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
