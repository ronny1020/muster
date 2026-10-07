import { useCallback, useEffect, useReducer, useRef } from 'react'

import { Pane } from '../widgets/pane/ui/Pane'
import {
  CollisionProvider,
  type FleetTab,
} from '../features/fleet/model/useCollisions'
import type { LaunchRequest } from '../features/launch/ui/Launcher'
import { TabStrip } from '../widgets/tab-strip/ui/TabStrip'
import {
  type Deck,
  type DeckAction,
  deckReducer,
  type Tab,
  tabSession,
} from '../entities/tab/model/deck'
import { useSettings } from '../entities/preferences/model/useSettings'
import { useTabShortcuts } from './useTabShortcuts'
import {
  attachSweep,
  closeWindow,
  dropTarget,
  journalSweep,
  onHandoff,
  onOpenDirectory,
  onPtyExit,
  openWindow,
  report,
  type Point,
  sendToWindow,
} from '../shared/ipc'
import type { Grab } from '../widgets/tab-strip/model/useTabDrag'
import { stripIndexAt } from '../widgets/tab-strip/ui/TabStrip'
import {
  detachTerminal,
  resumeTerminal,
} from '../features/terminal/model/handoff'
import { adoptHandoffs, writeHandoff } from './handoff'
import { loadDeck, saveDeck } from '../entities/tab/model/persist'
import { decideBellResponse, notify } from '../shared/lib/notify'
import type { Settings } from '../entities/preferences/model/settings'
import { runningAgent } from '../entities/agent/model/agents'

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
  const session = tabSession(tab)
  const agent = session
    ? (runningAgent(session.agentId, tab.handedBack)?.name ?? session.agentName)
    : 'Session'
  const body =
    code === 0 ? 'Session ended.' : `Session ended with code ${code}.`
  void notify(`${agent} · ${tab.title}`, body, settings.notifySound)
}

export interface AppProps {
  /** Tabs another window sent this one before it first drew. */
  adopted: Tab[]
}

export function App({ adopted }: AppProps) {
  const [deck, dispatch] = useReducer(deckReducer, adopted, initialTabs)

  // Remembered on every change rather than at quit: the window can be closed
  // by the OS, and `beforeunload` is not reliable in a webview.
  useEffect(() => saveDeck(deck), [deck])

  const { settings } = useSettings()
  // Retention is enforced here rather than in Rust because both of its inputs
  // are the frontend's: the period is a user setting, and the list of tabs
  // currently recording — which the sweep must not delete out from under — is
  // the deck. Re-runs when either changes, which is rare: records expire by
  // the day.
  const retention = settings.journalRetentionDays
  // Serialised so the effect does not restart on every unrelated render.
  // Gated on the exit code as well as the session: a tab keeps its session
  // after the process ends, and treating those as live would protect their
  // records from the sweep forever, so nothing would ever expire.
  const liveTabs = JSON.stringify(
    deck.tabs
      .filter((tab) => tabSession(tab) && tab.exitCode === null)
      .map((tab) => tab.id),
  )
  useEffect(() => {
    // Attachments expire on the same setting: both are records of a session,
    // and a second retention preference would be a second thing to explain.
    void Promise.all([
      journalSweep(retention, JSON.parse(liveTabs) as string[]),
      attachSweep(retention),
    ]).catch(() => {
      /* a sweep that cannot run is not worth interrupting a launch for */
    })
  }, [retention, liveTabs])
  // The exit listener is registered once, so it reads live state through refs.
  const current = useRef({ deck, settings })
  current.current = { deck, settings }

  const open = useCallback(
    () => dispatch({ type: 'open', id: nextTabId() }),
    [],
  )
  // Closing the last tab closes the window, as in Chrome — through the same
  // prompt as its close button, so running sessions are still asked about.
  const close = useCallback((id: string) => {
    const { deck } = current.current
    if (deck.tabs.length === 1 && deck.tabs[0]!.id === id) {
      // Stored empty first, so a closed tab does not come back on the next
      // launch. A prompt the user cancels hands focus back to the window,
      // which stores the tab again — see the focus listener below.
      saveDeck({ tabs: [], activeId: '' })
      void closeWindow()
    } else dispatch({ type: 'close', id, replacementId: nextTabId() })
  }, [])

  /**
   * Hands a tab to another window, or to a new one. A live session keeps
   * running: the other window takes over its output, and this one lets go
   * without killing it. A session whose terminal cannot hand over stays put,
   * since adopting it without one would start the agent again.
   */
  const handOff = useCallback(
    async (id: string, destination: Destination) => {
      const tab = current.current.deck.tabs.find((entry) => entry.id === id)
      if (!tab) return
      const terminal = await detachTerminal(id)
      if (tabSession(tab) && !terminal) return
      // An ended session has nothing left to hand over but its screen.
      const session = terminal && tab.exitCode === null ? id : null
      try {
        if (destination.kind === 'window') {
          const handoff = writeHandoff({ tab, terminal, dropX: destination.x })
          await sendToWindow(destination.label, handoff, session)
        } else {
          const handoff = writeHandoff({ tab, terminal, dropX: null })
          await openWindow({ handoff, session, grab: destination.grab })
        }
      } catch (error) {
        report(error)
        resumeTerminal(id)
        return
      }
      close(id)
    },
    [close],
  )

  // A lone tab has nowhere to move to: its window would be left empty.
  const moveToNewWindow = useCallback(
    async (id: string) => {
      if (current.current.deck.tabs.length < 2) return
      await handOff(id, { kind: 'new' })
    },
    [handOff],
  )

  /**
   * A tab dragged off the strip and released. Where it lands is the
   * backend's answer, from the cursor's place on the desktop: another
   * window's strip takes it, and anywhere else gets a new window under the
   * cursor. A window's only tab has carried its window along all the drag,
   * so for it anywhere but a strip is already where it belongs.
   */
  const tearOff = useCallback(
    async (id: string, grab: Grab) => {
      // Off the strip is out of it, as in Chrome — over its own window too.
      // Escape, or bringing the tab back to the strip, is how to keep it.
      const lone = current.current.deck.tabs.length === 1
      const target = await dropTarget(lone).catch(() => null)
      if (target?.kind === 'strip') {
        await handOff(id, { kind: 'window', label: target.label, x: target.x })
      } else if (!lone) {
        await handOff(id, { kind: 'new', grab: grab.inNewWindow })
      }
    },
    [handOff],
  )
  const closeActive = useCallback(
    () => close(deck.activeId),
    [close, deck.activeId],
  )
  const cycle = useCallback(
    (step: number) => dispatch({ type: 'cycle', step }),
    [],
  )
  const moveActive = useCallback(
    (step: number) => {
      const index = deck.tabs.findIndex((tab) => tab.id === deck.activeId)
      dispatch({ type: 'move', id: deck.activeId, index: index + step })
    },
    [deck.tabs, deck.activeId],
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
    moveActive,
    activateIndex,
    toggleHistory,
    toggleReview,
    find,
    openSettings,
  })

  // The window regaining focus is how a cancelled close prompt is noticed:
  // `close` stored an empty deck before asking, and the tabs are still here.
  useEffect(() => {
    const restore = () => saveDeck(current.current.deck)
    window.addEventListener('focus', restore)
    return () => window.removeEventListener('focus', restore)
  }, [])

  // Tabs sent here after this window drew. Taken once on subscribing as well,
  // for any that arrived between the first take and the listener.
  useEffect(() => {
    const adoptSent = async () => {
      for (const { tab, dropX } of await adoptHandoffs()) {
        const index = dropX === null ? undefined : stripIndexAt(dropX)
        dispatch({ type: 'adopt', tab, index })
      }
    }
    const unlisten = onHandoff(() => void adoptSent())
    void adoptSent()
    return () => void unlisten.then((stop) => stop())
  }, [])

  useEffect(() => {
    const unlisten = onPtyExit(({ id, code }) => {
      dispatch({ type: 'exited', id, code })
      announceExit(current.current, id, code, dispatch)
    })
    return () => void unlisten.then((stop) => stop())
  }, [])

  // A second launch was turned away and handed its directory here. It opens a
  // tab ready to start rather than started: the shell that ran `muster ~/proj`
  // asked for a place to work, not for an agent to be running in it.
  const defaults = useRef(settings)
  defaults.current = settings
  useEffect(() => {
    const unlisten = onOpenDirectory((cwd) =>
      dispatch({
        type: 'open',
        id: nextTabId(),
        start: {
          agentId: defaults.current.defaultAgentId,
          cwd,
          backend: defaults.current.defaultBackend,
          distro: defaults.current.defaultDistro,
          flags: '',
        },
      }),
    )
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
        // The setting is the default and the request is the override: the
        // status bar's control and an in-tab resume both name the mode they
        // want, and everything else — the launcher, a record reopened on a
        // launcher tab — takes the preference.
        scrollback:
          request.scrollback ?? settings.terminalMode === 'scrollback',
      },
    })

  // Every tab with a session, for the one comparison no tab can make about
  // itself. Built here because this is the only place that holds the deck.
  const watched: FleetTab[] = deck.tabs.flatMap((tab) => {
    const session = tabSession(tab)
    // A tab keeps its session after the process exits, so gate on the exit
    // code too: a dead tab has no working tree anyone is racing for, and it
    // would otherwise keep warning about a file nothing is editing.
    return session && tab.exitCode === null
      ? [{ id: tab.id, title: tab.title, cwd: session.cwd }]
      : []
  })

  return (
    <div className="flex h-full flex-col">
      <TabStrip
        tabs={deck.tabs}
        activeId={deck.activeId}
        onSelect={(id) => dispatch({ type: 'activate', id })}
        onMove={(id, index) => dispatch({ type: 'move', id, index })}
        onMoveToNewWindow={(id) => void moveToNewWindow(id)}
        onTearOff={tearOff}
        onClose={close}
        onOpen={open}
      />
      <main className="relative min-h-0 flex-1">
        <CollisionProvider tabs={watched} pollSeconds={settings.gitPollSeconds}>
          {byId(deck.tabs).map((tab) => (
            <Pane
              key={tab.id}
              tab={tab}
              active={tab.id === deck.activeId}
              onLaunch={launch(tab.id)}
              onOpenSettings={openSettings}
              dispatch={dispatch}
            />
          ))}
        </CollisionProvider>
      </main>
    </div>
  )
}

/**
 * The panes in an order no drag can change. Reordering keyed children makes
 * React move their DOM nodes, and a moved node loses its scroll position and
 * focus — every pane is mounted, so a drag in the strip would disturb
 * terminals nobody touched. Panes are stacked and hidden, so their order shows
 * nowhere.
 */
const byId = (tabs: Tab[]) =>
  [...tabs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Where a tab is handed: a new window, or a point on another one's strip. */
type Destination =
  { kind: 'new'; grab?: Point } | { kind: 'window'; label: string; x: number }

/** The tabs a window opens with: any sent to it, else what it last showed. */
const initialTabs = (adopted: Tab[]): Deck =>
  adopted.length > 0
    ? { tabs: adopted, activeId: adopted.at(-1)!.id }
    : loadDeck(nextTabId)
