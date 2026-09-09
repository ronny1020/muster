import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { type ILink, Terminal } from '@xterm/xterm'

import type { Session } from '../deck'
import { useSettings } from '../hooks/useSettings'
import { killPty, resizePty, spawnPty, writePty } from '../ipc'
import { flattenLogicalLine, rangeOf } from '../termcells'
import { findPaths, resolvePath } from '../termlinks'

const THEME = {
  background: '#171719',
  foreground: '#e6e6e8',
  cursor: '#d97757',
  cursorAccent: '#171719',
  selectionBackground: '#37414f',
  black: '#2a2a30',
  red: '#e26d63',
  green: '#7fb37a',
  yellow: '#d8b165',
  blue: '#6f9ede',
  magenta: '#b98adf',
  cyan: '#67b6bd',
  white: '#d5d5da',
  brightBlack: '#5c5c66',
  brightRed: '#f08a80',
  brightGreen: '#9bcf96',
  brightYellow: '#efcb82',
  brightBlue: '#8fb8f0',
  brightMagenta: '#cfa6f0',
  brightCyan: '#84d0d6',
  brightWhite: '#f2f2f4',
}

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
}

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
}: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal>(null)
  const fit = useRef<FitAddon>(null)
  const { settings } = useSettings()
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
      cursorBlink: latest.current.cursorBlink,
      fontFamily: latest.current.fontFamily,
      fontSize: latest.current.fontSize,
      lineHeight: latest.current.lineHeight,
      scrollback: latest.current.scrollback,
      macOptionIsMeta: true,
      theme: THEME,
    })
    const fitAddon = new FitAddon()
    fit.current = fitAddon
    term.loadAddon(fitAddon)
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
    term.open(element)
    term.onData((data) => void writePty(sessionId, data))
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
        void resizePty(sessionId, term.cols, term.rows)
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
      void killPty(sessionId)
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

  // Appearance changes apply to running sessions, not just the next one.
  useEffect(() => {
    const term = terminal.current
    if (!term) return
    term.options.fontFamily = settings.fontFamily
    term.options.fontSize = settings.fontSize
    term.options.lineHeight = settings.lineHeight
    term.options.scrollback = settings.scrollback
    term.options.cursorBlink = settings.cursorBlink
    if (host.current?.clientHeight) {
      fit.current?.fit()
      void resizePty(sessionId, term.cols, term.rows)
    }
  }, [
    sessionId,
    settings.fontFamily,
    settings.fontSize,
    settings.lineHeight,
    settings.scrollback,
    settings.cursorBlink,
  ])

  // No padding: the terminal grid runs edge to edge, like a native terminal.
  return (
    <div
      ref={host}
      className="min-h-0 min-w-0 flex-1 overflow-hidden [&_.xterm]:h-full"
    />
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
