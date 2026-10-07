import { createRoot } from 'react-dom/client'

import { App } from './App'
import { loadAppState } from '../shared/lib/appstate'
import { adoptHandoffs } from './handoff'
import { GHOST_LABEL, windowLabel } from '../shared/ipc'
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
  await loadAppState()
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
}

void start()
