import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { ImageAddon } from '@xterm/addon-image'
import { LigaturesAddon } from '@xterm/addon-ligatures'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type ILink, type ILinkProvider, Terminal } from '@xterm/xterm'
import { getCurrentWebview } from '@tauri-apps/api/webview'

import type { Turn } from '../../../shared/ipc'
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
import { surfacesFor } from '../model/surfaces'
import {
  MAX_LOOKS,
  MAX_STALLS,
  moved,
  needleFor,
  NOTCHES_PER_LOOK,
  onScreen,
  rowsOf,
} from '../model/seek'
import {
  messagesIn,
  type Place,
} from '../../../entities/transcript/model/turns'
import { QUIET_MS } from '../model/working'
import { SHELL_AGENT } from '../../../entities/agent/model/agents'
import { fileAbove, type NamedFile } from '../model/codeblocks'
import { currentMessage, nextMessage, previousMessage } from '../model/messages'
import { type AgentEvent, parseAgentEvent } from '../model/agentevents'
import { useFileMarks } from './useFileMarks'
import { useMessages } from './useMessages'
import { useViewportRow } from './useViewportRow'
import { FILE_MARK, MESSAGE_MARK, useRulerMarks } from './useRulerMarks'

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
  /**
   * Reopen this session's conversation, which is the only way back from the
   * clear a width change forces. Absent when there is nothing to reopen — a
   * launcher tab, or a session whose agent has no `continue`.
   */
  onReplay?: () => void
  /** Whether the session is still printing, i.e. still working. */
  onWorking(working: boolean): void
  /**
   * Whether the session's process has gone. Only the mouse gate reads it —
   * see `agentReadsMouse`.
   */
  ended: boolean
  /**
   * The turns of this tab's conversation, from the agent's own transcript.
   * Empty where there is none — see `agentTurns`.
   */
  turns: Turn[]
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
  onReplay,
  onWorking,
  ended,
  turns,
  findOpen,
  onCloseFind,
  paste,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  /** The grid's last column count, so either re-fit path can spot a change. */
  const lastCols = useRef(0)
  /** The same terminal as state, so what renders beside it can mount with it. */
  const [mounted, setMounted] = useState<Terminal | null>(null)
  const messages = useMessages(mounted, active)
  /**
   * Whether the agent is holding the alternate buffer, from xterm's own
   * event rather than read while rendering.
   *
   * Nothing about a buffer switch re-renders this component, so a value read
   * during render is whatever was true at the last one — and the switch
   * happens seconds after mount, when the agent starts. Measured: the bar and
   * the rail never appeared at all, because the render that would have drawn
   * them had already happened.
   */
  const [alternate, setAlternate] = useState(false)
  /**
   * What this session's view supports — the rail's source, whether xterm
   * draws a scrollbar, and whether a width change has anything to repair.
   * One decision rather than three: `surfaces.ts` has what went wrong when
   * they were gated separately.
   */
  const surfaces = surfacesFor({
    buffer: alternate ? 'alternate' : 'normal',
    bufferRows: mounted?.buffer.active.length ?? 0,
    screenRows: mounted?.rows ?? 0,
    turns: turns.length,
  })
  const fromTranscript = surfaces.rail === 'transcript'
  const said = useMemo(() => messagesIn(turns), [turns])
  /**
   * Which of the transcript's messages the step buttons are on.
   *
   * The scan's marks are stepped by comparing the viewport to their rows;
   * these have no rows, so the walk has to be remembered. Held past the end
   * so the first ↑ goes to the newest — and put back there whenever the
   * transcript grows, since the turns arrive after the first render and a
   * new message is the newest thing to walk back from.
   */
  const stepped = useRef(said.length)
  // Keyed on the newest turn, not the count: the list is a window on the last
  // dozen, so past a dozen messages its length stops changing and a reset
  // that watched the length would never fire again.
  // A sentinel rather than the first value: a turn the agent wrote no
  // timestamp for reads as the empty string, which would match a ref seeded
  // with one and leave the walk at the mount-time zero.
  const newest = said.at(-1)?.at ?? ''
  const walked = useRef<string | null>(null)
  // Skipped while the list is empty, which is every first render: the agent
  // may write a turn with no timestamp, and `at` is then the same empty
  // string the empty list produces — so a sentinel alone would call the two
  // states equal and leave the walk at zero, sending the first ↑ to the
  // oldest message instead of the newest.
  if (said.length > 0 && walked.current !== newest) {
    walked.current = newest
    stepped.current = said.length
  }
  /** Walks the transcript's messages with the step buttons, newest last. */
  const stepThrough = useCallback(
    (direction: -1 | 1) => {
      if (said.length === 0) return
      const next = Math.max(
        0,
        Math.min(said.length - 1, stepped.current + direction),
      )
      stepped.current = next
      void seekTo(said[next]!)
    },
    // `seekTo` is stable, and `said` changes only when the transcript does.
    [said],
  )

  /** Which seek owns the view: a later click supersedes an unfinished one. */
  const seeking = useRef(0)
  /**
   * Scrolls the agent's own view back to one of its messages.
   *
   * The wheel is the only thing that moves a view the agent owns, so this
   * sends notches the way a hand would and reads the screen between them —
   * see `seek.ts`. Dispatched on xterm's own element rather than encoded
   * here: the report's shape is the terminal's business, and it is already
   * right.
   *
   * It gives up the moment the view stops moving, which is what makes it
   * usable — the agent pins its view to the bottom while it is printing, and
   * a seek that kept trying through that spent the better part of a minute
   * going nowhere. Not finding it leaves the view where it started.
   *
   * And it sends nothing at all unless the agent is reading the mouse, which
   * is not a tidy guard but the whole safety of the gesture. xterm answers a
   * wheel nobody asked to hear on a buffer with no scrollback by **typing**:
   * it turns each line the notch would have scrolled into `ESC[A` or `ESC[B`
   * and writes them to the pty. A burst is eight notches of roughly seven
   * lines, so one stalled seek is around a hundred arrow presses into a live
   * agent — and Up recalls the previous prompt in Claude Code, so a click
   * meant to scroll would overwrite a draft and leave nothing looking wrong.
   * The rail is drawn from the buffer and the turns, neither of which says
   * whether tracking is armed, so the check has to be here.
   */
  const seekTo = useCallback(async (place: Place) => {
    const term = terminal.current
    const element = host.current?.querySelector<HTMLElement>('.xterm-screen')
    const needle = needleFor(place.label)
    if (!term || !element || !needle) return
    if (!agentReadsMouse(term, live.current)) return
    // A second dot clicked mid-seek supersedes the first: two loops sending
    // bursts at one view, each undoing its own count afterwards, leave it
    // somewhere neither click asked for.
    const mine = (seeking.current += 1)
    const screen = screenOf(term)
    const notch = (up: boolean) => sendNotches(element, up ? -1 : 1)
    // Only the bursts that moved the view are worth undoing. A burst the
    // agent absorbed — at the top of what it kept, or while it was printing
    // — scrolled nothing, so counting it into the way back drives the view
    // past where it started and pins it to the bottom.
    let travelled = 0
    let stalls = 0
    // Read before the first burst, not left empty: `moved` calls two empty
    // screens moved so a seek always gets its first burst, and seeding this
    // with one would bill that burst to the way back even when it scrolled
    // nothing.
    let before = rowsOf(screen)
    for (let look = 0; look < MAX_LOOKS; look += 1) {
      if (onScreen(screen, needle)) return
      for (let i = 0; i < NOTCHES_PER_LOOK; i += 1) notch(true)
      // The agent answers a burst by repainting over the pty, so the screen
      // read next is only current once that has arrived.
      await new Promise((settle) => setTimeout(settle, SEEK_SETTLE_MS))
      // Re-checked, not just tested once: a TUI can drop tracking mid-seek,
      // and every later notch would then be typed rather than reported.
      if (seeking.current !== mine || !agentReadsMouse(term, live.current)) {
        return
      }
      const after = rowsOf(screen)
      const shifted = moved(before, after)
      if (shifted) travelled += NOTCHES_PER_LOOK
      stalls = shifted ? 0 : stalls + 1
      before = after
      if (stalls >= MAX_STALLS) break
    }
    if (onScreen(screen, needle) || seeking.current !== mine) return
    // Put the view back as far as it actually came.
    for (let i = 0; i < travelled; i += 1) notch(false)
  }, [])

  useRulerMarks(mounted, messages, MESSAGE_MARK)
  const fileMarks = useFileMarks(mounted, active)
  useRulerMarks(mounted, fileMarks, FILE_MARK)
  const viewportRow = useViewportRow(mounted, active)
  /** The last row on screen: what "which message am I in" is measured against. */
  const viewportBottom = viewportRow + (mounted?.rows ?? 0) - 1
  /**
   * The file the output on screen is about, if anything above names one.
   *
   * The normal buffer only, for the reason `useBufferMarks` gives: a live TUI
   * frame has no scroll extent, so a row of it that happens to match reads as
   * a label on history that is not there — and parks at the top of the bar,
   * since `baseY` is 0.
   */
  const openFileHere =
    mounted && mounted.buffer.active.type === 'normal'
      ? fileAbove(mounted.buffer.active, viewportBottom)
      : null

  /** Where the viewport sits in the scrollback, as the scrollbar reads it. */
  const scrolledFraction = mounted
    ? Math.min(1, viewportRow / Math.max(1, mounted.buffer.active.baseY))
    : 0
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
  /**
   * Re-runs the selection-modifier sync, for the one moment no write does.
   *
   * It otherwise rides `onWriteParsed`, and a session that ends prints
   * nothing more — so a TUI killed with tracking armed would keep
   * Option-drag block selection off over its own dead scrollback.
   */
  const releaseSelection = useRef<(() => void) | null>(null)
  const showing = useRef(active)
  showing.current = active
  // Read through refs: these change with every poll, and the terminal is built
  // once. A dependency on them would tear the session down.
  const link = useRef({ cwd, home, onPath, onUrl })
  link.current = { cwd, home, onPath, onUrl }
  // Read through a ref so changing a setting never re-runs the spawn effect.
  const latest = useRef(settings)
  latest.current = settings
  // Read the same way, by the link providers the spawn effect registers.
  const live = useRef(!ended)
  live.current = !ended
  // The session is fixed for the life of the tab, but reading it through a ref
  // keeps it out of the spawn effect's dependencies all the same.
  const launch = useRef(session)
  /**
   * Drops the history a new column count would ruin, and remembers the count.
   *
   * Called after **every** re-fit, because two paths change the grid's width:
   * a pane or window resize, and a change to the font, its size, line height
   * or letter spacing. The first fit only records — there is no history to
   * lose before the session has printed anything.
   */
  const settleCols = useCallback((term: Terminal) => {
    if (term.cols === lastCols.current) return
    if (lastCols.current !== 0 && reflowRuins(term, launch.current.agentId))
      term.clear()
    lastCols.current = term.cols
  }, [])

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
    /**
     * Registers a link provider that offers nothing while the agent is
     * reading the mouse — see `agentReadsMouse`.
     *
     * Wrapping `provideLinks` rather than the activation: a link that is not
     * offered draws no underline and no pointer cursor, so the output stops
     * *claiming* to be clickable instead of quietly ignoring the click.
     */
    const gateLinks = (provider: ILinkProvider): ILinkProvider => ({
      provideLinks: (row, callback) =>
        agentReadsMouse(term, live.current)
          ? callback(undefined)
          : provider.provideLinks(row, callback),
    })
    // A click opens a preview card rather than the browser: the card is what
    // makes the network fetch deliberate, and it carries the Open button.
    const linksAddon = new WebLinksAddon((_event, uri) =>
      link.current!.onUrl(uri),
    )
    // The addon registers its own provider, so the gate has to meet it at the
    // one call it makes — the same shape as `withoutLocalFonts` below, and for
    // the same reason: the addon offers no hook of its own.
    const register = term.registerLinkProvider.bind(term)
    term.registerLinkProvider = (provider) => register(gateLinks(provider))
    try {
      term.loadAddon(linksAddon)
    } finally {
      Reflect.deleteProperty(term, 'registerLinkProvider')
    }
    // Sixel and iTerm2 inline images, which is how terminal tools ship pictures.
    const imageAddon = new ImageAddon({
      sixelSupport: true,
      iipSupport: true,
      // The default retains 128 MB of decoded images per terminal, and every
      // tab's pane stays mounted.
      storageLimit: 32,
    })
    term.loadAddon(imageAddon)
    term.registerLinkProvider(
      gateLinks({ provideLinks: pathLinks(term, link) }),
    )
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
    // `->`, `=>`, `!==` drawn as the single glyph the font has for them, for
    // the fonts that carry one, through xterm's character-joiner API — which
    // the WebGL renderer honours.
    //
    // Loaded *after* `open`, and that is not a preference: `activate` calls
    // `registerCharacterJoiner`, which throws "Terminal must be opened first"
    // against a terminal that has no renderer yet. Nothing types it — the
    // addon's `activate` is `(terminal: Terminal) => void` like every other —
    // so only this comment and the order stand between here and a pane that
    // throws on mount.
    const ligaturesAddon = new LigaturesAddon()
    withoutLocalFonts(() => term.loadAddon(ligaturesAddon))
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
    /**
     * Keeps the Option-drag escape hatch on only while the agent has the
     * mouse.
     *
     * `macOptionClickForcesSelection` is what lets a macOS user select output
     * a tracking CLI would otherwise take every drag of — but xterm reads the
     * same option in `shouldColumnSelect`, so leaving it on permanently trades
     * block selection away in every session, tracking or not. The mode only
     * ever changes through a written sequence, so this rides the same write
     * batch the scrollbar does.
     */
    const syncSelectionModifier = () => {
      // `live` for the reason `agentReadsMouse` reads it: a TUI killed with
      // tracking armed would otherwise leave block selection off for good.
      const needed = live.current && term.modes.mouseTrackingMode !== 'none'
      if (term.options.macOptionClickForcesSelection !== needed) {
        term.options.macOptionClickForcesSelection = needed
      }
    }
    term.onWriteParsed(() => {
      resyncScrollbar()
      syncSelectionModifier()
    })
    resync.current = resyncScrollbar
    releaseSelection.current = syncSelectionModifier

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
    setAlternate(term.buffer.active.type === 'alternate')
    term.buffer.onBufferChange((buffer) =>
      setAlternate(buffer.type === 'alternate'),
    )
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
      settleCols(term)
      if (started) {
        bestEffort(resizePty(sessionId, term.cols, term.rows))
        return
      }
      started = true
      const { agentId, cwd, program, args, backend, distro, scrollback } =
        launch.current
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
          // Fixed for the life of the session: the agent reads it once, at
          // start, so a tab changes mode by reopening the conversation.
          scrollback,
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
        ligaturesAddon,
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
      releaseSelection.current = null
      setMounted(null)
      if (paste) paste.current = null
    }
    // Session identity is fixed for the life of the tab, so the spawn runs
    // once: everything else this effect reads comes through a ref. `paste` is
    // a ref object too, so it is stable by construction.
  }, [paste, sessionId, settleCols])

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

  // The child is gone, so nothing will clear the mouse mode it left armed and
  // no further write will notice. Synchronising with the terminal outside
  // React's control is what an effect is for.
  useEffect(() => {
    releaseSelection.current?.()
  }, [ended])

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
      settleCols(term)
      bestEffort(resizePty(sessionId, term.cols, term.rows))
    }
  }, [
    sessionId,
    settleCols,
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
      {openFileHere && (
        <ScrollPath
          file={openFileHere}
          fraction={scrolledFraction}
          onOpen={() => onPath(resolvePath(openFileHere.path, cwd, home))}
        />
      )}
      {fromTranscript ? (
        <>
          {said.length > 0 && (
            <Rail
              entries={said.map((place: Place, index: number) => ({
                key: `said-${index}`,
                label: place.label,
                open: () => void seekTo(place),
              }))}
              current={null}
              label="Your messages in this conversation"
              className="right-[18px] text-brand"
            />
          )}
          <MessageSteps
            count={said.length}
            onStep={stepThrough}
            // Nothing to redraw: a clicks session keeps no scrollback for a
            // width change to ruin, so the ⟳ has no work here.
          />
        </>
      ) : (
        <>
          {messages.length > 0 && (
            <Rail
              // `useMessages` answers newest first, and the rail reads down
              // the conversation — so the two rails would otherwise run in
              // opposite directions on the same edge.
              entries={[...messages].reverse().map((message) => ({
                key: String(message.row),
                label: message.label || `Line ${message.row}`,
                open: () => jumpToMessage(message.row),
              }))}
              current={
                currentMessage(messages, viewportBottom)?.row.toString() ?? null
              }
              label="Your messages in the scrollback"
              className="right-[18px] text-brand"
            />
          )}
          <MessageSteps
            count={messages.length}
            onStep={stepMessage}
            // The live buffer, never the tab's mode: `reflowRuins` clears
            // on the same test, so gating the only way back on anything else
            // leaves a session cleared with no ⟳ to reopen it — which a
            // clicks tab reaches whenever the agent runs its classic
            // renderer.
            onReplay={surfaces.replay ? onReplay : undefined}
          />
        </>
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

/** One dot on a rail: what it says, and what a click on it does. */
interface RailEntry {
  key: string
  label: string
  open(): void
}

/**
 * A column of dots down the right edge, oldest at the top.
 *
 * Evenly spaced rather than placed in proportion to the scroll extent — see
 * AGENTS.md's message-marks invariant — which is also what lets the same
 * component draw places that have no row at all, from a transcript.
 */
function Rail({
  entries,
  current,
  label,
  className,
}: {
  entries: RailEntry[]
  /** The key of the entry the viewport is inside, drawn filled. */
  current: string | null
  label: string
  /** Where the column sits, and what colour its dots are. */
  className: string
}) {
  return (
    <div
      // `z-10` is load-bearing — see AGENTS.md's message-marks invariant for
      // why a later sibling still loses to xterm's canvases.
      // The colour rides on `text-*` here and each dot asks for `current`:
      // `border-color` is not inherited, so a dot asking to inherit one
      // resolves against its own button — which preflight leaves at
      // `currentcolor` — and both rails come out the same colour.
      className={`pointer-events-none absolute top-1/2 z-10 flex w-4 -translate-y-1/2 flex-col items-center gap-[11px] ${className}`}
      role="group"
      aria-label={label}
    >
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          title={entry.label}
          aria-label={`${label}: ${entry.label}`}
          onClick={entry.open}
          aria-current={entry.key === current ? 'true' : undefined}
          className="group pointer-events-auto flex h-3 w-4 flex-none items-center justify-center"
        >
          <span
            className={`rounded-full border border-current group-hover:bg-current ${
              entry.key === current
                ? 'h-[9px] w-[9px] bg-current'
                : 'h-[7px] w-[7px]'
            }`}
          />
        </button>
      ))}
    </div>
  )
}

/**
 * How much of the pane's bottom edge the step buttons occupy, so the label
 * rides up the scrollbar without ever coming to rest on top of them.
 *
 * Their stack is three 24px buttons sitting 12px off the bottom, so it owns
 * the last 84px. The label is centred on its position, so at the bottom of the
 * scrollback — where a live session sits — its lower edge reaches
 * `reserve - 12 - half its height`, and that has to clear 84. At roughly 18px
 * tall it wants 105px, so `7rem` with a few pixels to spare.
 *
 * It is worth being exact: the label is `z-10` against the buttons' `z-20`, so
 * an overlap does not look like an overlap. It renders behind them and simply
 * appears to be missing.
 */
const STEPS_RESERVE = '7rem'

/**
 * The file the output on screen is about, riding the scrollbar's thumb.
 *
 * A long session scrolls through many files, and the scrollbar says only how
 * far along you are. This says *where*: the nearest `Updated …` line above
 * whatever is on screen, read as you scroll rather than marked up front.
 *
 * It tracks `fraction` — how far down the scrollback the viewport sits — so it
 * reads as a label on the bar rather than a caption pinned to the pane, and it
 * sits left of the dot rail's own lane so the two never stack.
 *
 * Clicking it opens the file, through the same `onPath` a path clicked in the
 * output goes through — which is why it carries the printed path beside the
 * shortened label. It stays clear of the scrollbar rather than over it, so a
 * click here can never be a drag meant for the bar.
 */
function ScrollPath({
  file,
  fraction,
  onOpen,
}: {
  file: NamedFile
  fraction: number
  onOpen(): void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open ${file.path}`}
      className="absolute right-10 z-10 max-w-[45%] -translate-y-1/2 truncate rounded border border-line bg-chrome/90 px-1.5 py-0.5 font-mono text-[10px] text-muted backdrop-blur hover:border-brand hover:text-ink"
      style={{
        top: `calc(0.75rem + ${fraction} * (100% - ${STEPS_RESERVE}))`,
      }}
      aria-label={`Showing output about ${file.path} — open it`}
    >
      {file.label}
    </button>
  )
}

/**
 * Runs `activate` with the Local Font Access API hidden.
 *
 * The ligatures addon reads a font's real ligature set through
 * `queryLocalFonts` when the browser has it, and falls back to a fixed list of
 * programming ligatures when it does not. WebView2 has it and WKWebView does
 * not, so on Windows alone activating the addon would raise a font permission
 * dialog at startup — something the user did nothing to cause, and a reflexive
 * "Don't Allow" is remembered. Fonts are answered natively for exactly that
 * reason; see AGENTS.md's font-enumeration note. Taking the fallback on every
 * platform also makes one host's ligatures the same as another's.
 */
function withoutLocalFonts(activate: () => void) {
  const query = Reflect.get(window, 'queryLocalFonts')
  if (query === undefined) return activate()
  Reflect.deleteProperty(window, 'queryLocalFonts')
  try {
    activate()
  } finally {
    Reflect.set(window, 'queryLocalFonts', query)
  }
}

/**
 * Whether re-wrapping this session's scrollback would destroy it — see
 * AGENTS.md's reflow invariant for why nothing can repair it.
 *
 * Both exclusions matter because `clear()` keeps **only the cursor's line**,
 * not the visible screen: a plain shell's wraps are genuine, so it reflows
 * correctly and is the one session that will not repaint on `SIGWINCH`, and an
 * agent in the alternate buffer has no scrollback to lose, only its frame.
 */
const reflowRuins = (term: Terminal, agentId: string) =>
  agentId !== SHELL_AGENT.id && term.buffer.active.type === 'normal'

/**
 * Steps through your own messages in the scrollback.
 *
 * Bottom right rather than top right: the find bar owns that corner, and both
 * can be open at once. It hides itself below two messages, where "previous"
 * and "next" have nothing to say.
 */
function MessageSteps({
  count,
  onStep,
  onReplay,
}: {
  /** How many places there are to walk, from whichever source found them. */
  count: number
  onStep(direction: -1 | 1): void
  /** Set when there is a session to reopen; absent on a launcher tab. */
  onReplay?: () => void
}) {
  const steppable = count > 1
  if (!steppable && !onReplay) return null
  return (
    <div // Left of the rail's own 16px lane rather than sharing it: both hug the
      // right edge, and stacked they took the clicks meant for the newest dots.
      className="absolute right-10 bottom-3 z-20 flex flex-col overflow-hidden rounded-lg border border-line bg-chrome/95 shadow-lg backdrop-blur"
    >
      {steppable && (
        <>
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
            {count} messages in this session
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
        </>
      )}
      {onReplay && (
        <button
          type="button"
          title="Redraw the conversation at this width — reopens the session with continue"
          aria-label="Redraw the conversation at this width by reopening the session"
          onClick={onReplay}
          className={`h-6 w-6 text-muted hover:bg-surface-hover hover:text-ink ${
            steppable ? 'border-t border-line' : ''
          }`}
        >
          ⟳
        </button>
      )}
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

/** What the agent is showing right now, for the seek and the bar to read. */
const screenOf = (term: Terminal) => ({
  get rows() {
    return term.rows
  },
  row: (index: number) =>
    term.buffer.active.getLine(index)?.translateToString(true) ?? '',
})

/** One wheel notch, in the units a browser reports for a line-mode wheel. */
const WHEEL_DELTA = 120

/**
 * Turns the wheel on the agent's behalf, `count` notches, negative for up.
 *
 * Dispatched on xterm's own element rather than encoded here: a mouse report
 * is the terminal's business and it already builds the right one. This is the
 * only way to move a view the agent owns — see `seek.ts`.
 */
function sendNotches(element: HTMLElement, count: number) {
  const box = element.getBoundingClientRect()
  for (let sent = 0; sent < Math.abs(count); sent += 1) {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: count < 0 ? -WHEEL_DELTA : WHEEL_DELTA,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    )
  }
}

/**
 * How long to let a burst land before reading the screen again.
 *
 * The agent repaints over the pty, so a read taken in the same frame still
 * sees the screen from before the scroll.
 */
const SEEK_SETTLE_MS = 40

/**
 * Whether a live session is having the mouse sent to it.
 *
 * xterm forwards a click to the child the moment a CLI turns tracking on, and
 * its `Linkifier` activates a link from the same mouseup without consulting
 * that — so a path under the pointer opened the file column *and* reached the
 * agent, from one click. The app's own links stand down while the agent is
 * listening: what is under the pointer then is the agent's control, and it is
 * the one that should answer.
 *
 * `live` is the other half, and it is not belt-and-braces: xterm clears the
 * mode only when the child asks it to, so an agent that is killed rather than
 * closed leaves tracking armed for good. Its output stays on screen under the
 * ended-session bar, and without this every path and URL in it would be dead
 * until the tab closed.
 *
 * It answers for the **session's** process, which is the agent, because the
 * session is an `exec` and the login shell goes with it. A TUI killed inside a
 * still-running shell — `vim` with `set mouse=a` — leaves that tab's links off
 * until something resets the terminal, and nothing here can see that it died.
 */
const agentReadsMouse = (term: Terminal, live: boolean) =>
  live && term.modes.mouseTrackingMode !== 'none'

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
