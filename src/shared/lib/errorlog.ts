import type { RootOptions } from 'react-dom/client'

import { describeError, logHeartbeat, logWrite } from '../ipc'

/** Often enough to stay well inside the backend's 10s limit. */
const HEARTBEAT_MS = 2_000

/**
 * Sends every error this window's page does not handle to the log file, and
 * keeps telling the backend the page is alive, so a frozen window is recorded
 * by the watchdog even though it can no longer record anything itself.
 */
export const recordErrors = () => {
  window.addEventListener('error', (event) => {
    void logWrite('error', describeError(event.error ?? event.message))
  })
  window.addEventListener('unhandledrejection', (event) => {
    void logWrite(
      'error',
      `unhandled rejection: ${describeError(event.reason)}`,
    )
  })
  // One now, because the watch starts when the window takes the keyboard,
  // which can be well before this page is running.
  void logHeartbeat()
  setInterval(() => void logHeartbeat(), HEARTBEAT_MS)
}

/**
 * React's own error hooks. An uncaught render error unmounts the whole tree —
 * the window goes blank — so it is the one most worth a line.
 */
export const rootErrorOptions: RootOptions = {
  // Replacing React's default handler takes the error off the console too.
  onUncaughtError: (error, info) => {
    console.error(error)
    void logWrite(
      'error',
      `render failed, window cleared: ${describeError(error)}${info.componentStack ?? ''}`,
    )
  },
  onCaughtError: (error) => {
    void logWrite('warn', `render error caught: ${describeError(error)}`)
  },
}
