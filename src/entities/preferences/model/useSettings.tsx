import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
  watchSettings,
} from './settings'
import { setLanguage } from '../../../shared/i18n/i18n'

interface SettingsStore {
  settings: Settings
  /** Applies and persists a change immediately; there is no save button. */
  update(change: Partial<Settings>): void
  reset(): void
}

const SettingsContext = createContext<SettingsStore | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState(() => adopt(loadSettings()))

  // Another window's settings pane, which writes the same store.
  useEffect(() => watchSettings(() => setSettings(adopt(loadSettings()))), [])

  const persist = useCallback((next: Settings) => {
    setSettings(adopt(next))
    saveSettings(next)
  }, [])

  const store = useMemo<SettingsStore>(
    () => ({
      settings,
      update: (change) => persist({ ...settings, ...change }),
      reset: () => persist(DEFAULT_SETTINGS),
    }),
    [settings, persist],
  )

  return <SettingsContext value={store}>{children}</SettingsContext>
}

/**
 * Applies the part of the settings that lives outside React before the
 * settings themselves land, so the first render is already in the right
 * language.
 */
function adopt(settings: Settings): Settings {
  setLanguage(settings.language)
  return settings
}

export function useSettings(): SettingsStore {
  const store = useContext(SettingsContext)
  if (!store)
    throw new Error('useSettings must be used inside a SettingsProvider')
  return store
}
