import { useCallback, useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { ImageAddon } from '@xterm/addon-image'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type ILink, Terminal } from '@xterm/xterm'

import { clipboardIntent } from '../clipboard'
import type { Session } from '../deck'
import { useBackground } from '../hooks/useBackground'
import { useSettings } from '../hooks/useSettings'
import { killPty, resizePty, spawnPty, writePty } from '../ipc'
import { IS_MAC } from '../platform'
import { flattenLogicalLine, rangeOf } from '../termcells'
import { themeFor } from '../themes'
import { findPaths, resolvePath } from '../termlinks'

export interface TerminalViewProps {
  sessionId: string
  session: Session
  active: boolean
  /** Fired when the session rings the terminal bell, i.e. it wants attention. */
  onBell(): void
  /** The session's live directory, for resolving a relative path in the output. */
  cwd: string
  home: string
  /** A path in the output was clicked. */
  onPath(path: string, line?: number): void
  /** A URL in the output was clicked. */
  onUrl(url: string): void
  /** Whether this tab's scrollback search bar is showing. */
  findOpen: boolean
  onCloseFind(): void
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
  cwd,
  home,
  onPath,
  onUrl,
  findOpen,
  onCloseFind,
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  const fit = useRef<FitAddon>(null)
  const search = useRef<SearchAddon>(null)
  const { settings } = useSettings()
  const background = useBackground(settings.backgroundImage)
  const bell = useRef(onBell)
  bell.current = onBell
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
      scrollback: latest.current.scrollback,
      macOptionIsMeta: true,
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
    term.loadAddon(new WebLinksAddon((_event, uri) => link.current!.onUrl(uri)))
    // Sixel and iTerm2 inline images, which is how terminal tools ship pictures.
    term.loadAddon(
      new ImageAddon({
        sixelSupport: true,
        iipSupport: true,
        // The default retains 128 MB of decoded images per terminal, and every
        // tab's pane stays mounted.
        storageLimit: 32,
      }),
    )
    term.registerLinkProvider({ provideLinks: pathLinks(term, link) })
    // Windows and Linux have no menu accelerator for copy, and Ctrl+C has to
    // stay SIGINT — so the Ctrl+Shift+C/V convention is ours to implement.
    term.attachCustomKeyEventHandler((event) => {
      const intent = clipboardIntent(event, IS_MAC)
      if (!intent) return true
      if (intent === 'copy') {
        void writeClipboard(term.getSelection())
      } else {
        void readClipboard().then((text) => {
          // Through the terminal, never straight to the PTY: `paste` wraps the
          // text in the bracketed-paste markers and normalises CRLF, so a
          // newline in the clipboard lands as editable text instead of
          // submitting the line. `onData` then forwards it to the PTY.
          if (text) term.paste(text)
        })
      }
      return false
    })
    term.open(element)
    // GPU rendering, since an agent redrawing its TUI at speed is the one place
    // the DOM renderer shows. The context can be lost — a GPU reset, a laptop
    // waking, a driver update — and the addon has to be dropped when it is, or
    // the terminal stops painting entirely rather than falling back.
    let webgl: WebglAddon | null = null
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl?.dispose()
        webgl = null
      })
      term.loadAddon(webgl)
    } catch {
      // No WebGL in this webview: the DOM renderer is already what is running.
      webgl = null
    }
    term.onData((data) => bestEffort(writePty(sessionId, data)))
    // Read through a ref so a new handler identity never re-runs the spawn.
    term.onBell(() => bell.current())
    terminal.current = term

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
      const { cwd, program, args, backend, distro } = launch.current
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
        },
        (bytes) => term.write(bytes),
      ).catch((error) =>
        term.writeln(`\r\n\x1b[31mfailed to start: ${error}\x1b[0m`),
      )
    }

    const observer = new ResizeObserver(sync)
    observer.observe(element)
    sync()

    return () => {
      observer.disconnect()
      bestEffort(killPty(sessionId))
      // Before the terminal, so the renderer releases its context first.
      webgl?.dispose()
      term.dispose()
      terminal.current = null
    }
    // Session identity is fixed for the life of the tab, so the spawn runs
    // once: everything else this effect reads comes through a ref.
  }, [sessionId])

  // A hidden pane keeps its DOM focus in xterm's helper textarea, which then
  // swallows typing meant for whatever the new tab put on screen, so the
  // terminal hands focus back on the way out.
  useEffect(() => {
    if (active) terminal.current?.focus()
    else terminal.current?.blur()
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
      {findOpen && search.current && (
        <FindBar search={search.current} onClose={closeFind} />
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
    <div className="absolute top-3 right-4 flex items-center gap-1 rounded-lg border border-line bg-chrome/95 px-1.5 py-1 shadow-lg backdrop-blur">
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
          activate: () => {
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

/** Fully transparent, so a background image shows through the grid. */
const CLEAR = '#00000000'

/**
 * The palette to hand xterm: the chosen theme, with its background dropped when
 * an image sits behind the grid.
 */
function paletteFor(themeId: string, hasBackground: boolean) {
  const { name: _name, ...colours } = themeFor(themeId)
  return hasBackground ? { ...colours, background: CLEAR } : colours
}
