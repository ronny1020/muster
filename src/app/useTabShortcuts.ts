import { useEffect } from 'react'

import { IS_MAC } from '../shared/lib/platform'
import {
  matchShortcut,
  type ShortcutAction,
} from '../entities/preferences/model/shortcuts'

export interface TabShortcuts {
  open(): void
  openSettings(): void
  toggleHistory(): void
  find(): void
  closeActive(): void
  cycle(step: number): void
  activateIndex(index: number): void
}

/**
 * Chrome's tab shortcuts. Anything else — including every key the agent's TUI
 * cares about — falls through to the focused terminal.
 */
export function useTabShortcuts(handlers: TabShortcuts) {
  const {
    open,
    closeActive,
    cycle,
    activateIndex,
    toggleHistory,
    find,
    openSettings,
  } = handlers

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action = matchShortcut(event, IS_MAC)
      if (!action) return
      event.preventDefault()
      run(action, {
        open,
        closeActive,
        cycle,
        activateIndex,
        toggleHistory,
        find,
        openSettings,
      })
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    open,
    closeActive,
    cycle,
    activateIndex,
    toggleHistory,
    find,
    openSettings,
  ])
}

function run(action: ShortcutAction, handlers: TabShortcuts) {
  switch (action.type) {
    case 'open':
      return handlers.open()
    case 'openSettings':
      return handlers.openSettings()
    case 'toggleHistory':
      return handlers.toggleHistory()
    case 'find':
      return handlers.find()
    case 'closeActive':
      return handlers.closeActive()
    case 'cycle':
      return handlers.cycle(action.step)
    case 'activateIndex':
      return handlers.activateIndex(action.index)
  }
}
