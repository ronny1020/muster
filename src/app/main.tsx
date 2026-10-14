import { createRoot } from 'react-dom/client'

import { App } from './App'
import { loadAppState } from '../shared/lib/appstate'
import { adoptHandoffs } from './handoff'
import { syncCloseWords } from './closewords'
import {
  GHOST_LABEL,
  onStateChange,
  readAppState,
  systemLocales,
  windowLabel,
} from '../shared/ipc'
import { loadSystemLocales, setLanguage } from '../shared/i18n/i18n'
import {
  normalizeSettings,
  STORAGE_KEY as SETTINGS_KEY,
} from '../entities/preferences/model/settings'
import { DragGhost } from '../widgets/tab-strip/ui/DragGhost'

declare global {
  interface Window {
    /** The MCP plugin's own opt-out for its listener-recording patch. */
    __TAURI_MCP_LISTENER_PATCH__?: boolean
  }
}
import { SettingsProvider } from '../entities/preferences/model/useSettings'
import './index.css'

// Answers the MCP plugin's requests to read this webview and run script in it.
// Kept out of a release bundle by `build.ts`'s `define` — see AGENTS.md.
//
// Importing it is not free: its entry module patches
// `EventTarget.prototype.addEventListener` at module scope to record every
// click, pointer and key listener, which is the exact path xterm reads input
// through. Setting its own guard first declines that patch, so a development
// build keeps the same event plumbing a release has. What is lost is the
// plugin's listener enumeration, which nothing here drives.
const listenForMcp = async () => {
  try {
    window.__TAURI_MCP_LISTENER_PATCH__ = true
    const { setupPluginListeners } = await import('tauri-plugin-mcp')
    await setupPluginListeners()
  } catch {
    /* built without the feature, which is the usual case */
  }
}

if (import.meta.env.DEV) void listenForMcp()

/**
 * Fills the state cache, then draws.
 *
 * The order is the whole point: every caller of `appState` reads it
 * synchronously, so a component that mounted first would see an empty store —
 * restoring a blank deck over a real one, showing default settings, and
 * skipping the one-shot `localStorage` migration that brings an older
 * version's tabs across.
 *
 * A window opened to receive a tab takes it before drawing too, so it opens
 * showing that tab rather than a blank one that the tab then joins.
 *
 * No StrictMode either: terminals own PTY processes, and its double-mounted
 * effects would spawn each session twice in development.
 */
const start = async () => {
  if (windowLabel() === GHOST_LABEL) return drawGhost()
  await Promise.all([loadAppState(), loadSystemLocales(systemLocales)])
  syncCloseWords()
  const adopted = (await adoptHandoffs()).map(({ tab }) => tab)
  createRoot(document.querySelector('#root')!).render(
    <SettingsProvider>
      <App adopted={adopted} />
    </SettingsProvider>,
  )
}

/**
 * The drag label's window draws only the label, over a transparent page — it
 * has no tabs, no state and no sessions of its own.
 */
function drawGhost() {
  for (const element of [document.documentElement, document.body]) {
    element.style.background = 'transparent'
  }
  createRoot(document.querySelector('#root')!).render(<DragGhost />)
  void followLanguage()
}

/**
 * The label's window speaks the user's language without loading the app's
 * state, which would run the one-shot migration under the label's own name.
 * It asks the OS's languages for _Match system_, follows the other windows'
 * writes, then reads the setting directly. It subscribes first so a write
 * during the read is not missed, and a write it has heard is newer than the
 * read, which is then dropped.
 */
const followLanguage = async () => {
  try {
    await loadSystemLocales(systemLocales)
    let heard = false
    await onStateChange(({ key, value }) => {
      if (key !== SETTINGS_KEY) return
      heard = true
      applyLanguage(value)
    })
    const stored = (await readAppState())[SETTINGS_KEY]
    if (!heard) applyLanguage(stored)
  } catch {
    /* no backend, so the label stays in the default language */
  }
}

function applyLanguage(stored: string | null | undefined) {
  let raw: unknown = {}
  try {
    raw = JSON.parse(stored ?? '{}')
  } catch {
    /* a corrupt record reads as defaults, as it does in every window */
  }
  setLanguage(normalizeSettings(raw).language)
}

void start()
