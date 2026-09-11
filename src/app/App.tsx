import { useCallback, useEffect, useReducer, useRef } from 'react'

import { Pane } from '../widgets/pane/ui/Pane'
import type { LaunchRequest } from '../features/launch/ui/Launcher'
import { TabStrip } from '../widgets/tab-strip/ui/TabStrip'
import {
  type Deck,
  type DeckAction,
  deckReducer,
  tabSession,
} from '../entities/tab/model/deck'
import { useSettings } from '../entities/preferences/model/useSettings'
import { useTabShortcuts } from './useTabShortcuts'
import { onPtyExit } from '../shared/ipc'
import { loadDeck, saveDeck } from '../entities/tab/model/persist'
import { decideBellResponse, notify } from '../shared/lib/notify'
import type { Settings } from '../entities/preferences/model/settings'

/**
 * Tab ids, which also key the backend's PTY map.
 *
 * Unique across runs on purpose: a counter restarts at 1 every launch, so a
 * restored tab and a later `⌘T` would eventually claim the same id — and the
 * spawn path reads a reused id as "end that session and take its place".
 */
const nextTabId = () => crypto.randomUUID()

/**
 * A session ending is worth the same interruption as one finishing a turn —
 * more so when it ended badly and the user is not looking.
 */
function announceExit(
  { deck, settings }: { deck: Deck; settings: Settings },
  id: string,
  code: number,
  dispatch: (action: DeckAction) => void,
) {
  const tab = deck.tabs.find((entry) => entry.id === id)
  if (!tab) return

  const { attention, notify: shouldNotify } = decideBellResponse({
    enabled: settings.notifyOnDone,
    onlyWhenUnfocused: settings.notifyOnlyWhenUnfocused,
    tabActive: deck.activeId === id,
    windowFocused: document.hasFocus(),
    lastNotifiedAt: null,
    now: Date.now(),
  })

  if (attention) dispatch({ type: 'attention', id })
  if (!shouldNotify) return
  const agent = tabSession(tab)?.agentName ?? 'Session'
  const body =
    code === 0 ? 'Session ended.' : `Session ended with code ${code}.`
  void notify(`${agent} · ${tab.title}`, body, settings.notifySound)
}

export function App() {
  const [deck, dispatch] = useReducer(deckReducer, nextTabId, loadDeck)

  // Remembered on every change rather than at quit: the window can be closed
  // by the OS, and `beforeunload` is not reliable in a webview.
  useEffect(() => saveDeck(deck), [deck])
  const { settings } = useSettings()
  // The exit listener is registered once, so it reads live state through refs.
  const current = useRef({ deck, settings })
  current.current = { deck, settings }

  const open = useCallback(
    () => dispatch({ type: 'open', id: nextTabId() }),
    [],
  )
  const close = useCallback(
    (id: string) => dispatch({ type: 'close', id, replacementId: nextTabId() }),
    [],
  )
  const closeActive = useCallback(
    () => close(deck.activeId),
    [close, deck.activeId],
  )
  const cycle = useCallback(
    (step: number) => dispatch({ type: 'cycle', step }),
    [],
  )
  const openSettings = useCallback(
    () => dispatch({ type: 'openSettings', id: nextTabId() }),
    [],
  )
  const toggleHistory = useCallback(
    () => dispatch({ type: 'toggleHistory', id: deck.activeId }),
    [deck.activeId],
  )
  const toggleReview = useCallback(
    () => dispatch({ type: 'toggleReview', id: deck.activeId }),
    [deck.activeId],
  )
  const find = useCallback(
    () => dispatch({ type: 'setFind', id: deck.activeId, open: true }),
    [deck.activeId],
  )
  const activateIndex = useCallback(
    (index: number) => dispatch({ type: 'activateIndex', index }),
    [],
  )

  useTabShortcuts({
    open,
    closeActive,
    cycle,
    activateIndex,
    toggleHistory,
    toggleReview,
    find,
    openSettings,
  })

  useEffect(() => {
    const unlisten = onPtyExit(({ id, code }) => {
      dispatch({ type: 'exited', id, code })
      announceExit(current.current, id, code, dispatch)
    })
    return () => void unlisten.then((stop) => stop())
  }, [])

  const launch = (id: string) => (request: LaunchRequest) =>
    dispatch({
      type: 'start',
      id,
      title: request.title,
      session: {
        agentId: request.agent.id,
        agentName: request.agent.name,
        accent: request.agent.accent,
        program: request.agent.command,
        args: request.args,
        cwd: request.cwd,
        backend: request.backend,
        distro: request.distro,
      },
    })

  return (
    <div className="flex h-full flex-col">
      <TabStrip
        tabs={deck.tabs}
        activeId={deck.activeId}
        onSelect={(id) => dispatch({ type: 'activate', id })}
        onClose={close}
        onOpen={open}
        onOpenSettings={openSettings}
      />
      <main className="relative min-h-0 flex-1">
        {deck.tabs.map((tab) => (
          <Pane
            key={tab.id}
            tab={tab}
            active={tab.id === deck.activeId}
            onLaunch={launch(tab.id)}
            dispatch={dispatch}
          />
        ))}
      </main>
    </div>
  )
}
