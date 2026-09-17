import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { ImageAddon } from '@xterm/addon-image'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type ILink, Terminal } from '@xterm/xterm'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import { routePaste } from '../model/paste'
import { clipboardIntent } from '../model/clipboard'
import type { Session } from '../../../entities/tab/model/deck'
import { useBackground } from '../../../shared/lib/useBackground'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import {
  attachText,
  dropPaths,
  killPty,
  report,
  resizePty,
  spawnPty,
  writePty,
} from '../../../shared/ipc'
import { IS_MAC } from '../../../shared/lib/platform'
import { flattenLogicalLine, rangeOf } from '../model/termcells'
import { paletteFor } from '../../../shared/lib/themes'
import { findPaths, resolvePath } from '../model/termlinks'
import { QUIET_MS } from '../model/working'
import {
  currentMessage,
  type Message,
  nextMessage,
  previousMessage,
} from '../model/messages'
import { type AgentEvent, parseAgentEvent } from '../model/agentevents'
import { useMessages } from './useMessages'
import { useViewportRow } from './useViewportRow'
import { useRulerMarks } from './useRulerMarks'

export interface TerminalViewProps {
  sessionId: string
  session: Session
  active: boolean
  /** Fired when the session rings the terminal bell, i.e. it wants attention. */
  onBell(): void
  /**
   * Fired for each turn boundary the agent announces over `OSC 777`. Claude
   * Code never rings the bell, so this is the only signal it hands back.
   */
  onAgentEvent(event: AgentEvent): void
  /** The session's live directory, for resolving a relative path in the output. */
  cwd: string
  home: string
  /** A path in the output was clicked. */
  onPath(path: string, line?: number): void
  /** A URL in the output was clicked. */
  onUrl(url: string): void
  /** Whether the session is still printing, i.e. still working. */
  onWorking(working: boolean): void
  /** Whether this tab's scrollback search bar is showing. */
  findOpen: boolean
  onCloseFind(): void
  /**
   * Filled in with a function that types text into this session, for the
   * surfaces outside the terminal that need to — the review panel handing a
   * path to the agent. It goes through xterm's own `paste`, so the text
   * arrives bracketed rather than as a submitted line.
   */
  paste?: RefObject<((text: string) => void) | null>
}

/**
 * Fires a PTY call that may lose the race with its own session ending.
 *
 * A pane can be typed into, resized or torn down after its process has gone,
 * and the backend rightly answers that there is no such session. There is
 * nothing to report: the exit already arrived over `pty://exit` and the pane is
 * showing it. Left unhandled these surface as an unhandled rejection, which in
 * development is a full-window error overlay over a working app.
 */
const bestEffort = (call: Promise<unknown>) => void call.catch(() => {})

/**
 * An xterm view bound to a backend PTY. Mounted once per tab and kept alive
 * while hidden, so switching tabs never restarts the agent.
 */
export function TerminalView({
  sessionId,
  session,
  active,
  onBell,
  onAgentEvent,
  cwd,
  home,
  onPath,
  onUrl,
  onWorking,
  findOpen,
  onCloseFind,
  paste,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  /** The same terminal as state, so what renders beside it can mount with it. */
  const [mounted, setMounted] = useState<Terminal | null>(null)
  const messages = useMessages(mounted, active)
  useRulerMarks(mounted, messages)
  const viewportRow = useViewportRow(mounted, active)
  /** The last row on screen: what "which message am I in" is measured against. */
  const viewportBottom = viewportRow + (mounted?.rows ?? 0) - 1
  const fit = useRef<FitAddon>(null)
  const search = useRef<SearchAddon>(null)
  const { settings } = useSettings()
  const background = useBackground(settings.backgroundImage)
  const bell = useRef(onBell)
  bell.current = onBell
  const agentEvent = useRef(onAgentEvent)
  agentEvent.current = onAgentEvent
  const working = useRef(onWorking)
  working.current = onWorking
  /** Re-runs the scroll-area sync; see `resyncScrollbar` for why a hidden
      pane cannot do it for itself. */
  const resync = useRef<(() => void) | null>(null)
  const showing = useRef(active)
  showing.current = active
  // Read through refs: these change with every poll, and the terminal is built
  // once. A dependency on them would tear the session down.
  const link = useRef({ cwd, home, onPath, onUrl })
  link.current = { cwd, home, onPath, onUrl }
  // Read through a ref so changing a setting never re-runs the spawn effect.
  const latest = useRef(settings)
  latest.current = settings
  // The session is fixed for the life of the tab, but reading it through a ref
  // keeps it out of the spawn effect's dependencies all the same.
  const launch = useRef(session)

  useEffect(() => {
    const element = host.current!
    const term = new Terminal({
      allowProposedApi: true,
      // Init-only in xterm, and changing it needs `open()` again — which would
      // respawn the PTY. So it is always on, and whether the grid is actually
      // transparent is decided by the theme's alpha below.
      allowTransparency: true,
      cursorBlink: latest.current.cursorBlink,
      fontFamily: latest.current.fontFamily,
      fontSize: latest.current.fontSize,
      lineHeight: latest.current.lineHeight,
      letterSpacing: latest.current.letterSpacing,
      scrollback: latest.current.scrollback,
      macOptionIsMeta: true,
      // The find bar's match marks live in xterm's overview ruler, and
      // without a width that ruler is not drawn at all — every decoration
      // asking for a mark in it is silently dropped.
      overviewRulerWidth: 10,
      theme: paletteFor(
        latest.current.themeId,
        Boolean(latest.current.backgroundImage),
      ),
    })
    const fitAddon = new FitAddon()
    fit.current = fitAddon
    term.loadAddon(fitAddon)
    // Agents print hundreds of lines and the interesting error is always above
    // the fold, so the scrollback has to be searchable.
    const searchAddon = new SearchAddon()
    search.current = searchAddon
    term.loadAddon(searchAddon)
    // A click opens a preview card rather than the browser: the card is what
    // makes the network fetch deliberate, and it carries the Open button.
    const linksAddon = new WebLinksAddon((_event, uri) =>
      link.current!.onUrl(uri),
    )
    term.loadAddon(linksAddon)
    // Sixel and iTerm2 inline images, which is how terminal tools ship pictures.
    const imageAddon = new ImageAddon({
      sixelSupport: true,
      iipSupport: true,
      // The default retains 128 MB of decoded images per terminal, and every
      // tab's pane stays mounted.
      storageLimit: 32,
    })
    term.loadAddon(imageAddon)
    term.registerLinkProvider({ provideLinks: pathLinks(term, link) })
    // Windows and Linux have no menu accelerator for copy, and Ctrl+C has to
    // stay SIGINT — so the Ctrl+Shift+C/V convention is ours to implement.
    /**
     * Puts pasted text in front of the agent, as text or as a path.
     *
     * Always through `term.paste`, never straight to the PTY: it wraps the
     * text in the bracketed-paste markers and normalises CRLF, so a newline
     * lands as editable text instead of submitting the line. A path is quoted
     * by `dropPaths` — the session's shell's quoting, and a WSL session needs
     * the path translated the way `--cd` translates it at launch.
     */
    const deliverPaste = async (text: string) => {
      if (routePaste(text).kind === 'inline') {
        if (text) term.paste(text)
        return
      }
      try {
        const path = await attachText(text)
        const quoted = await dropPaths([path], launch.current.backend)
        term.paste(quoted)
      } catch {
        // Better the old behaviour than no paste at all — a full disk must not
        // swallow what the user was trying to hand over.
        term.paste(text)
      }
    }

    // macOS routes Cmd+V through the native menu, so the key handler below
    // never sees it and this is the only place an oversized paste can be
    // caught there. Capture phase, on the host rather than xterm's own
    // textarea: the textarea is created by `open()` and replaced on a reset.
    const onDomPaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text') ?? ''
      // Left entirely alone unless it is going to become a file: claiming an
      // ordinary paste would take over bracketed-paste handling xterm already
      // has right.
      if (routePaste(text).kind === 'inline') return
      // `stopPropagation`, not `preventDefault`. xterm registers its own paste
      // listener on both its textarea and its element — descendants of this
      // host — and `handlePasteEvent` never consults `defaultPrevented`: it
      // reads the clipboard and sends it to the PTY itself. Preventing default
      // only suppresses the browser's own insertion, which xterm does not rely
      // on, so the giant paste still arrived as keystrokes *and* the path did.
      // Stopping propagation in the capture phase is what keeps the event from
      // ever reaching those listeners.
      event.stopPropagation()
      event.preventDefault()
      void deliverPaste(text)
    }
    element.addEventListener('paste', onDomPaste, true)

    term.attachCustomKeyEventHandler((event) => {
      const intent = clipboardIntent(event, IS_MAC)
      if (!intent) return true
      if (intent === 'copy') {
        void writeClipboard(term.getSelection())
      } else {
        // Prevented as well as claimed: returning false stops xterm, not the
        // browser, and `Ctrl+Shift+V` is a paste accelerator in its own right
        // — so the DOM listener would see the same text and attach it a second
        // time, writing two files and typing two paths.
        event.preventDefault()
        void readClipboard().then((text) => void deliverPaste(text))
      }
      return false
    })
    term.open(element)
    // GPU rendering, since an agent redrawing its TUI at speed is the one place
    // the DOM renderer shows. The context can be lost — a GPU reset, a laptop
    // waking, a driver update — and the addon has to be dropped when it is, or
    // the terminal stops painting entirely rather than falling back.
    //
    // Its version is pinned rather than ranged: the addon restores the DOM
    // renderer through `terminal._core`, so a build made for a newer core
    // throws on every dispose and nothing before that notices.
    // `test/xterm.test.ts` is what holds the pairing.
    let webgl: WebglAddon | null = null
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        webgl = null
      })
      // Held from here, not after `loadAddon` returns. `loadAddon` pushes the
      // addon onto the terminal's list *before* calling `activate`, so an
      // `activate` that throws — WebGL unavailable behind software rendering,
      // a remote desktop, a GPU blocklist — leaves xterm holding an addon this
      // cleanup would skip, and `term.dispose()` would then dispose it after
      // `_core` is gone. That is the crash this whole ordering exists to
      // prevent, reachable on exactly the hosts least able to report it.
      webgl = addon
      term.loadAddon(addon)
    } catch {
      // No WebGL here: the DOM renderer is already what is running. The handle
      // stays, because xterm may already have registered the addon.
    }
    // xterm records the scroll area's height alongside writing it, and skips
    // the write when its record already matches — so an inline height reset
    // behind its back is never repaired and the scrollbar keeps the size it
    // had when the session was one screen tall. Re-asserting the height it
    // already computed costs nothing when nothing is wrong.
    //
    // A hidden pane is `display: none`, where every height reads 0 — so this
    // can only measure while the pane is on screen, and writes that arrive
    // behind a hidden tab would otherwise leave the scrollbar stale with
    // nothing to repair it. The pane runs it again on the way back in, and
    // skipping it while hidden also keeps a layout flush out of every write
    // in every tab.
    const resyncScrollbar = () => {
      if (!showing.current) return
      const viewport = term.buffer.active
      const area = element.querySelector<HTMLElement>('.xterm-scroll-area')
      if (!area || viewport.length <= term.rows) return
      // Row height from the screen's own layout rather than a cell metric:
      // the WebGL renderer draws to a canvas and leaves no per-row element to
      // measure, while the screen is always `rows` tall.
      const screen = element.querySelector<HTMLElement>('.xterm-screen')
      const rowHeight = (screen?.offsetHeight ?? 0) / term.rows
      const expected = Math.round(rowHeight * viewport.length)
      if (expected > 0 && area.offsetHeight < expected) {
        area.style.height = `${expected}px`
      }
    }
    term.onWriteParsed(resyncScrollbar)
    resync.current = resyncScrollbar

    // Output is the one "is it working" signal every agent and every shell
    // has: a CLI prints while it thinks and goes quiet when it wants you.
    // Reported on the edges only, so a busy session is not a render per chunk.
    let quiet: ReturnType<typeof setTimeout> | undefined
    let printing = false
    const markWorking = () => {
      if (!printing) {
        printing = true
        working.current(true)
      }
      clearTimeout(quiet)
      quiet = setTimeout(() => {
        printing = false
        working.current(false)
      }, QUIET_MS)
    }

    term.onData((data) => bestEffort(writePty(sessionId, data)))
    // Read through a ref so a new handler identity never re-runs the spawn.
    term.onBell(() => bell.current())
    // The other half of "the session wants you": an agent CLI announces its
    // turn boundaries here instead of ringing the bell. Claimed rather than
    // passed on, since nothing else in the app reads `OSC 777`.
    term.parser.registerOscHandler(777, (data) => {
      const event = parseAgentEvent(data)
      if (event) agentEvent.current(event)
      return true
    })
    terminal.current = term
    setMounted(term)
    if (paste) paste.current = (text: string) => term.paste(text)

    // The PTY is spawned only once the pane has real dimensions, so the
    // agent's TUI draws at the right size from its first frame.
    let started = false
    const sync = () => {
      if (element.clientHeight === 0) return
      fitAddon.fit()
      if (started) {
        bestEffort(resizePty(sessionId, term.cols, term.rows))
        return
      }
      started = true
      const { agentId, cwd, program, args, backend, distro } = launch.current
      void spawnPty(
        {
          id: sessionId,
          cwd,
          program,
          args,
          backend,
          distro,
          cols: term.cols,
          rows: term.rows,
          loginShell: true,
          // Read through the ref, like every other setting here: flipping it
          // must never re-run the spawn effect and start a second PTY.
          journal: latest.current.journalEnabled,
          // So a record remembers which agent wrote it, and the panel can
          // offer that agent's own resume for the conversation.
          agentId,
        },
        (bytes) => {
          markWorking()
          term.write(bytes)
        },
      ).catch((error) =>
        term.writeln(`\r\n\x1b[31mfailed to start: ${error}\x1b[0m`),
      )
    }

    const observer = new ResizeObserver(sync)
    observer.observe(element)
    sync()

    return () => {
      observer.disconnect()
      clearTimeout(quiet)
      element.removeEventListener('paste', onDomPaste, true)
      bestEffort(killPty(sessionId))
      // Every addon before the terminal, not just the renderer. `dispose` on
      // the Terminal tears `_core` down and only then lets its addon manager
      // dispose what is still registered — and an addon that reaches through
      // `_terminal._core` (the image addon reads `_renderService`,
      // `_inputHandler` and `screenElement`; fit reads the render service)
      // then dereferences what has just been freed and throws. Disposing an
      // addon here runs xterm's own wrapper, which unregisters it, so the
      // terminal does not dispose it a second time.
      for (const addon of [
        webgl,
        imageAddon,
        linksAddon,
        searchAddon,
        fitAddon,
      ]) {
        addon?.dispose()
      }
      term.dispose()
      terminal.current = null
      resync.current = null
      setMounted(null)
      if (paste) paste.current = null
    }
    // Session identity is fixed for the life of the tab, so the spawn runs
    // once: everything else this effect reads comes through a ref. `paste` is
    // a ref object too, so it is stable by construction.
  }, [paste, sessionId])

  /**
   * Scrolls to the message before or after the one at the top of the screen.
   *
   * The marks in the overview ruler cannot take a click — xterm attaches no
   * pointer handler to that canvas — so stepping through them is what makes
   * them reachable at all.
   */
  const stepMessage = useCallback(
    (direction: -1 | 1) => {
      const term = terminal.current
      if (!term) return
      const top = term.buffer.active.viewportY
      const target =
        direction === -1
          ? previousMessage(messages, top)
          : nextMessage(messages, top + term.rows - 1)
      // Past the last message in either direction, go to the end of the
      // scrollback: the gesture means "further this way", and the output after
      // the final message would otherwise be unreachable by the buttons.
      if (target) term.scrollToLine(target.row)
      else if (direction === 1) term.scrollToBottom()
      else term.scrollToTop()
      term.focus()
    },
    [messages],
  )

  /** Scrolls straight to one message, from a click on its dot. */
  const jumpToMessage = useCallback((row: number) => {
    const term = terminal.current
    if (!term) return
    term.scrollToLine(row)
    term.focus()
  }, [])

  const [dropping, setDropping] = useState(false)

  /**
   * Files dropped on the window are typed into the session, quoted — what
   * every terminal has done with a dropped file for decades, and the shortest
   * path from "that file" to a prompt.
   *
   * Only the active pane listens. The event is the window's, not an element's:
   * Tauri intercepts the drop before the DOM sees it, so there is no target to
   * hang a handler on, and every mounted pane would otherwise answer one drop.
   */
  useEffect(() => {
    if (!active) return
    let unlisten: (() => void) | null = null
    let live = true

    // Guarded because reaching the webview is what fails when this runs
    // outside Tauri — `bun run serve` — and a throw inside an effect takes the
    // whole tree down, where a rejected call would only lose the feature.
    try {
      void getCurrentWebview()
        .onDragDropEvent(({ payload }) => {
          if (payload.type === 'leave') {
            setDropping(false)
            return
          }
          if (payload.type !== 'drop') {
            setDropping(true)
            return
          }
          setDropping(false)
          if (payload.paths.length === 0) return
          void dropPaths(payload.paths, launch.current.backend)
            .then((text) => {
              // Through `paste`, so the text arrives bracketed: an agent's TUI
              // then treats it as text rather than as a submitted line.
              if (text) terminal.current?.paste(text)
            })
            .catch(report)
        })
        .then((stop) => {
          if (live) unlisten = stop
          // Unsubscribed before the listener was even registered: drop it now,
          // or this pane keeps answering drops meant for another tab.
          else stop()
        })
        // Reaching the webview fails by rejection as often as by throwing —
        // `bun run serve`, where there is no Tauri at all — and an unhandled
        // rejection is a full-window overlay in development.
        .catch(report)
    } catch (error) {
      report(error)
    }

    return () => {
      live = false
      unlisten?.()
      setDropping(false)
    }
  }, [active])

  // A hidden pane keeps its DOM focus in xterm's helper textarea, which then
  // swallows typing meant for whatever the new tab put on screen, so the
  // terminal hands focus back on the way out.
  useEffect(() => {
    if (!active) {
      terminal.current?.blur()
      return
    }
    terminal.current?.focus()
    // Whatever arrived while this pane was hidden could not be measured then.
    resync.current?.()
  }, [active])

  const closeFind = useCallback(() => {
    search.current?.clearDecorations()
    onCloseFind()
    terminal.current?.focus()
  }, [onCloseFind])

  // Appearance changes apply to running sessions, not just the next one.
  useEffect(() => {
    const term = terminal.current
    if (!term) return
    term.options.fontFamily = settings.fontFamily
    term.options.fontSize = settings.fontSize
    term.options.lineHeight = settings.lineHeight
    term.options.letterSpacing = settings.letterSpacing
    term.options.scrollback = settings.scrollback
    term.options.cursorBlink = settings.cursorBlink
    term.options.theme = paletteFor(settings.themeId, Boolean(background))
    if (host.current?.clientHeight) {
      fit.current?.fit()
      bestEffort(resizePty(sessionId, term.cols, term.rows))
    }
  }, [
    sessionId,
    settings.fontFamily,
    settings.fontSize,
    settings.letterSpacing,
    settings.lineHeight,
    settings.scrollback,
    settings.cursorBlink,
    background,
    settings.themeId,
  ])

  // The grid is inset, the background is not: the image fills the pane and the
  // text sits inside it. The fit addon measures the inset host, so the column
  // count follows the padding rather than overflowing behind it.
  return (
    <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-canvas">
      {background && (
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{
            backgroundImage: `url("${background}")`,
            filter: `brightness(${settings.backgroundBrightness}%)`,
          }}
        />
      )}
      <div
        ref={host}
        className="absolute inset-2 [&_.xterm]:h-full [&_.xterm-viewport]:!bg-transparent"
      />
      {messages.length > 0 && (
        <MessageRail
          messages={messages}
          current={currentMessage(messages, viewportBottom)?.row ?? null}
          onJump={jumpToMessage}
        />
      )}
      {messages.length > 1 && (
        <MessageSteps messages={messages} onStep={stepMessage} />
      )}
      {findOpen && search.current && (
        <FindBar search={search.current} onClose={closeFind} />
      )}
      {dropping && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-1 flex items-end justify-center rounded-lg border-2 border-dashed border-brand/70 p-4"
        >
          <span className="rounded bg-chrome/95 px-2 py-1 text-[11px] text-muted">
            Drop to type the path
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * One dot per message you sent, down the right edge, oldest at the top, with
 * the one the viewport is inside drawn filled.
 *
 * Evenly spaced rather than placed in proportion to the scroll extent, and
 * clear of the scrollbar rather than over it — AGENTS.md's message-marks
 * invariant has the reasons for both, and for why this exists beside xterm's
 * own ruler rather than instead of it.
 *
 * `MessageSteps` walks this identical list, so the number of dots and the
 * number of presses are always the same.
 */
function MessageRail({
  messages,
  current,
  onJump,
}: {
  messages: Message[]
  /** The row of the message the viewport is inside, drawn filled. */
  current: number | null
  onJump(row: number): void
}) {
  const oldestFirst = [...messages].reverse()
  return (
    <div
      // `z-10` is load-bearing: xterm's render layers are positioned with a
      // positive z-index inside the host, so a later sibling at `auto` paints
      // *under* them and the link-layer canvas swallows every click. DOM order
      // does not decide this.
      //
      // Centred as a group with a fixed gap rather than stretched down the
      // edge: the rail is a short list of places, and spreading a handful of
      // dots over the full height reads as a scale rather than a menu.
      className="pointer-events-none absolute top-1/2 right-[18px] z-10 flex w-4 -translate-y-1/2 flex-col items-center gap-[11px]"
      role="group"
      aria-label="Your messages in the scrollback"
    >
      {oldestFirst.map(({ row, label }) => (
        <button
          key={row}
          type="button"
          title={label || `Line ${row}`}
          aria-label={`Scroll to your message: ${label || `line ${row}`}`}
          onClick={() => onJump(row)}
          // The button is the hit box and the ring is the mark: 7px of dot is
          // not a target, so the pointer gets the rail's full width and 12px
          // of height around it.
          aria-current={row === current ? 'true' : undefined}
          className="group pointer-events-auto flex h-3 w-4 flex-none items-center justify-center"
        >
          <span
            className={`rounded-full border border-brand/70 group-hover:border-brand group-hover:bg-brand ${
              row === current
                ? 'h-[9px] w-[9px] border-brand bg-brand'
                : 'h-[7px] w-[7px]'
            }`}
          />
        </button>
      ))}
    </div>
  )
}

/**
 * Steps through your own messages in the scrollback.
 *
 * Bottom right rather than top right: the find bar owns that corner, and both
 * can be open at once. It hides itself below two messages, where "previous"
 * and "next" have nothing to say.
 */
function MessageSteps({
  messages,
  onStep,
}: {
  messages: Message[]
  onStep(direction: -1 | 1): void
}) {
  return (
    <div // Left of the rail's own 16px lane rather than sharing it: both hug the
      // right edge, and stacked they took the clicks meant for the newest dots.
      className="absolute right-10 bottom-3 z-20 flex flex-col overflow-hidden rounded-lg border border-line bg-chrome/95 shadow-lg backdrop-blur"
    >
      <button
        type="button"
        title="Previous message"
        aria-label="Scroll to the previous message you sent"
        onClick={() => onStep(-1)}
        className="h-6 w-6 text-muted hover:bg-surface-hover hover:text-ink"
      >
        ↑
      </button>
      <span className="sr-only" role="status">
        {messages.length} messages in the scrollback
      </span>
      <button
        type="button"
        title="Next message"
        aria-label="Scroll to the next message you sent"
        onClick={() => onStep(1)}
        className="h-6 w-6 border-t border-line text-muted hover:bg-surface-hover hover:text-ink"
      >
        ↓
      </button>
    </div>
  )
}

/** Search options shared by every call, so highlights stay consistent. */
const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: '#4a4632',
    matchBorder: '#6b6440',
    matchOverviewRuler: '#d8b165',
    activeMatchBackground: '#d97757',
    activeMatchBorder: '#f0906f',
    activeMatchColorOverviewRuler: '#d97757',
  },
} as const

/**
 * Scrollback search, floating over the grid.
 *
 * Escape closes rather than toggling, and Enter walks the matches, because
 * that is what every terminal's find bar does and muscle memory is the whole
 * value of the feature.
 */
function FindBar({
  search,
  onClose,
}: {
  search: SearchAddon
  onClose(): void
}) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState({ index: -1, count: 0 })
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  useEffect(() => {
    const results = search.onDidChangeResults(({ resultIndex, resultCount }) =>
      setFound({ index: resultIndex, count: resultCount }),
    )
    return () => results.dispose()
  }, [search])

  // Incremental on the way in, so the first match is highlighted as you type.
  useEffect(() => {
    if (!query) {
      search.clearDecorations()
      setFound({ index: -1, count: 0 })
      return
    }
    search.findNext(query, { ...SEARCH_OPTIONS, incremental: true })
  }, [search, query])

  const step = (forward: boolean) => {
    if (!query) return
    if (forward) search.findNext(query, SEARCH_OPTIONS)
    else search.findPrevious(query, SEARCH_OPTIONS)
  }

  return (
    <div className="absolute top-3 right-4 z-20 flex items-center gap-1 rounded-lg border border-line bg-chrome/95 px-1.5 py-1 shadow-lg backdrop-blur">
      <input
        ref={input}
        value={query}
        spellCheck={false}
        placeholder="Find in scrollback"
        aria-label="Find in scrollback"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            step(!event.shiftKey)
          }
        }}
        className="h-6 w-[200px] rounded bg-surface px-2 font-mono text-xs text-ink select-text placeholder:text-faint focus:outline-none"
      />
      <span className="w-[68px] text-center font-mono text-[10px] text-faint">
        {query === ''
          ? ''
          : found.count === 0
            ? 'no matches'
            : `${found.index + 1} of ${found.count}`}
      </span>
      <button
        type="button"
        title="Previous match (⇧Enter)"
        aria-label="Previous match"
        onClick={() => step(false)}
        className="h-6 w-6 rounded text-muted hover:bg-surface-hover hover:text-ink"
      >
        ↑
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        aria-label="Next match"
        onClick={() => step(true)}
        className="h-6 w-6 rounded text-muted hover:bg-surface-hover hover:text-ink"
      >
        ↓
      </button>
      <button
        type="button"
        title="Close search (Esc)"
        aria-label="Close search"
        onClick={onClose}
        className="h-6 w-6 rounded text-muted hover:bg-surface-hover hover:text-ink"
      >
        ×
      </button>
    </div>
  )
}

/**
 * Underlines the file paths in one row and hands a click back to the pane.
 *
 * Paths are found per row on demand rather than scanned as output arrives —
 * xterm asks only about the row under the pointer, so a busy session costs
 * nothing.
 */
function pathLinks(
  term: Terminal,
  link: React.RefObject<{
    cwd: string
    home: string
    onPath(path: string, line?: number): void
    onUrl(url: string): void
  }>,
) {
  return (row: number, callback: (links: ILink[] | undefined) => void) => {
    // The whole logical line, with each character mapped back to its cell —
    // a string offset is not a column once a wide glyph or a wrap is involved.
    const flat = flattenLogicalLine(term.buffer.active, row - 1)
    const links = findPaths(flat.text).flatMap((match) => {
      const range = rangeOf(flat, match.start, match.end)
      if (!range) return []
      return [
        {
          range,
          text: match.path,
          activate: (event) => {
            // Claimed here, or the same click also reaches the pane beneath,
            // which treats it as a click on the terminal.
            event.preventDefault()
            event.stopPropagation()
            // xterm arms a selection drag on mousedown and tears it down from
            // a listener on the *document* — an ancestor, so the line above
            // stops that listener running and the drag stays armed: the grid
            // then draws a selection that follows the pointer with no button
            // held, and leaks the 50ms drag-scroll interval. `clearSelection`
            // is what xterm's own mouseup path calls to undo it.
            term.clearSelection()
            const { cwd, home, onPath } = link.current!
            onPath(resolvePath(match.path, cwd, home), match.line)
          },
        } satisfies ILink,
      ]
    })

    callback(links.length > 0 ? links : undefined)
  }
}

/**
 * Puts `text` on the system clipboard.
 *
 * The async API is the only one that can see xterm's selection: xterm draws its
 * own, so there is no DOM selection for `execCommand` to copy. A hidden
 * textarea is the fallback for a webview that refuses the permission.
 */
async function writeClipboard(text: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    /* fall through to the selection-based route */
  }
  const staging = document.createElement('textarea')
  staging.value = text
  staging.setAttribute('aria-hidden', 'true')
  staging.style.position = 'fixed'
  staging.style.opacity = '0'
  document.body.appendChild(staging)
  staging.select()
  try {
    document.execCommand('copy')
  } catch {
    /* nothing left to try; better than throwing into a keypress */
  }
  staging.remove()
}

/** The clipboard's text, or empty when the webview will not hand it over. */
async function readClipboard(): Promise<string> {
  try {
    return await navigator.clipboard.readText()
  } catch {
    return ''
  }
}
