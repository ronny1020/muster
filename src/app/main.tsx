import { createRoot } from 'react-dom/client'

import { App } from './App'
import { loadAppState } from '../shared/lib/appstate'

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
 * No StrictMode either: terminals own PTY processes, and its double-mounted
 * effects would spawn each session twice in development.
 */
const start = async () => {
  await loadAppState()
  createRoot(document.querySelector('#root')!).render(
    <SettingsProvider>
      <App />
    </SettingsProvider>,
  )
}

void start()
