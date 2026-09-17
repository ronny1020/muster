import {
  appState,
  forgetAppState,
  setAppState,
} from '../../../shared/lib/appstate'

const KEY = 'muster.recent-dirs'
const LIMIT = 8

export function recentDirs(): string[] {
  try {
    const parsed = JSON.parse(appState(KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((entry) => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

export function rememberDir(dir: string) {
  const next = [dir, ...recentDirs().filter((entry) => entry !== dir)].slice(
    0,
    LIMIT,
  )
  setAppState(KEY, JSON.stringify(next))
}

export function clearRecentDirs() {
  forgetAppState(KEY)
}
