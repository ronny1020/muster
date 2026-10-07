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

interface SettingsStore {
  settings: Settings
  /** Applies and persists a change immediately; there is no save button. */
  update(change: Partial<Settings>): void
  reset(): void
}

const SettingsContext = createContext<SettingsStore | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState(loadSettings)

  // Another window's settings pane, which writes the same store.
  useEffect(() => watchSettings(() => setSettings(loadSettings())), [])

  const persist = useCallback((next: Settings) => {
    setSettings(next)
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

export function useSettings(): SettingsStore {
  const store = useContext(SettingsContext)
  if (!store)
    throw new Error('useSettings must be used inside a SettingsProvider')
  return store
}
