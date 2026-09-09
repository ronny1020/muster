import type { Backend } from './platform'

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
  fontFamily: string
  fontSize: number
  lineHeight: number
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
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgentId: 'claude',
  defaultDirectory: '',
  defaultBackend: 'native',
  defaultDistro: '',
  fontFamily:
    '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  scrollback: 20000,
  cursorBlink: true,
  gitPollSeconds: 4,
  historyLimit: 60,
  editorCommand: '',
  notifyOnDone: true,
  notifyOnlyWhenUnfocused: true,
  notifySound: true,
}

export const LIMITS = {
  fontSize: { min: 9, max: 28, step: 1 },
  lineHeight: { min: 1, max: 2, step: 0.05 },
  scrollback: { min: 1000, max: 200000, step: 1000 },
  gitPollSeconds: { min: 1, max: 60, step: 1 },
  historyLimit: { min: 10, max: 500, step: 10 },
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
    fontFamily: text(raw.fontFamily, DEFAULT_SETTINGS.fontFamily),
    fontSize: number(raw.fontSize, DEFAULT_SETTINGS.fontSize, LIMITS.fontSize),
    lineHeight: number(
      raw.lineHeight,
      DEFAULT_SETTINGS.lineHeight,
      LIMITS.lineHeight,
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
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}
