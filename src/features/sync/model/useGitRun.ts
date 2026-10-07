import { useCallback, useRef, useState } from 'react'

import { gitCancel } from '../../../shared/ipc'

export interface Notice {
  failed: boolean
  text: string
}

export interface GitRun {
  /** The op id of the command in flight, or `null`. */
  running: string | null
  /** The last result in this tab, whichever drawer asked for it. */
  notice: Notice | null
  /** The commit message being written. */
  draft: string
  setDraft(update: string | ((draft: string) => string)): void
  /** Runs `action` under a fresh op id, reporting `done` when git says nothing. */
  run(action: (op: string) => Promise<string>, done: string): Promise<boolean>
  cancel(): void
}

/**
 * One git write at a time for a tab, whichever drawer started it.
 *
 * Held by the pane rather than by either drawer, so the review drawer's commit
 * and the history drawer's push share one busy state and one Cancel, closing a
 * drawer mid-run does not orphan a command nothing can stop, and the commit
 * draft survives the drawer closing, its Files view and a `cd`.
 */
export function useGitRun(onDone: () => void): GitRun {
  const [running, setRunning] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [draft, setDraft] = useState('')
  // `running` disables the buttons only once React has re-rendered, so two
  // clicks inside one frame would both start; a ref answers at once.
  const inFlight = useRef(false)

  const run = useCallback(
    async (action: (op: string) => Promise<string>, done: string) => {
      if (inFlight.current) return false
      inFlight.current = true
      const op = crypto.randomUUID()
      setRunning(op)
      setNotice(null)
      try {
        const out = await action(op)
        setNotice({ failed: false, text: firstLine(out) || done })
        return true
      } catch (error) {
        setNotice({ failed: true, text: lastLines(String(error)) })
        return false
      } finally {
        inFlight.current = false
        setRunning(null)
        onDone()
      }
    },
    [onDone],
  )

  const cancel = useCallback(() => {
    if (running) void gitCancel(running)
  }, [running])

  return { running, notice, draft, setDraft, run, cancel }
}

/** Git's success output leads with the line worth reading. */
const firstLine = (text: string) => text.trim().split('\n')[0] ?? ''

/** A refusal ends with the line worth reading, after whatever a hook printed. */
const lastLines = (text: string) =>
  text.trim().split('\n').slice(-12).join('\n')
