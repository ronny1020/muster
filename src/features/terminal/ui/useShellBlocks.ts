import { useCallback, useEffect, useRef, useState } from 'react'
import type { IMarker, Terminal } from '@xterm/xterm'

import {
  commandOf,
  outputOf,
  type Position,
  type ShellBlock,
  type ShellEvent,
  typedAt,
} from '../model/blocks'
import { completionFor, type History, matchesFor } from '../model/suggest'
import { report, shellHistory, writePty } from '../../../shared/ipc'

/**
 * A place the shell reported, held as one of xterm's own markers.
 *
 * A row number goes stale the moment the scrollback is trimmed — every row
 * above shifts and the number then names someone else's output. A marker is
 * what xterm moves for us, and what says the row has gone.
 */
interface Tracked {
  marker: IMarker
  col: number
}

interface TrackedBlock {
  key: number
  input: Tracked
  output: Tracked | null
  end: Tracked | null
  /** What ran, as the shell reported it; empty until the command starts. */
  command: string
}

/** A block with its rows read back, which is how everything outside uses one. */
export interface ResolvedBlock extends ShellBlock {
  key: number
  /** What ran, as the shell reported it. */
  command: string
}

/**
 * How many commands to keep markers for.
 *
 * Each block holds up to three, and a marker is a live object xterm moves on
 * every scroll — so this is what stops a day-long session from carrying a
 * marker per command it ever ran. The oldest are dropped, and the rows they
 * named usually left the scrollback long before.
 */
const MAX_BLOCKS = 200

/**
 * How many of this session's own commands to suggest from.
 *
 * The list is walked on every frame a prefix changes, so an all-day shell
 * would otherwise pay for every command it ever ran on every keystroke — and
 * hold them all. The history file covers anything older.
 */
const MAX_RAN = 500

/** What the open prompt could become, and where to draw the offer. */
export interface Suggestions {
  /** Where the cursor is, which is where the offer is anchored. */
  at: Position
  /** What has been typed, so a row can show only what it adds. */
  typed: string
  /** Past commands that carry on from it, newest first. */
  matches: string[]
}

export interface ShellSurface {
  /** Whether this session's shell reports boundaries at all. */
  reporting: boolean
  /** What the open prompt could become, or `null` when nothing does. */
  suggestions: Suggestions | null
  /** Which row of the list is chosen, or -1 while it is only a hint. */
  selected: number
  /** Moves through the list, or answers `false` when there is none. */
  move(step: -1 | 1): boolean
  /** Puts the list away until something else is typed. */
  dismiss(): boolean
  /**
   * Fills the prompt in from `index`, or from the chosen row, or from the top
   * match. Answers `false` when there was nothing to fill in.
   */
  accept(index?: number): boolean
  /** The command whose rows cover `row`, or `null`. */
  blockAt(row: number): ResolvedBlock | null
  /** The newest command that has finished, for the keyboard route. */
  lastFinished(): ResolvedBlock | null
  /** Everything `block` printed. */
  outputText(block: ResolvedBlock): string
}

const resolve = (tracked: Tracked): Position => ({
  row: tracked.marker.line,
  col: tracked.col,
})

const resolveBlock = (block: TrackedBlock): ResolvedBlock => ({
  key: block.key,
  input: resolve(block.input),
  output: block.output && resolve(block.output),
  end: block.end && resolve(block.end),
  command: block.command,
})

/**
 * The commands a shell has reported in this session, and the completion for
 * whatever is being typed at its prompt.
 *
 * The `OSC 133` handler is registered by the terminal's own effect rather than
 * here — see `TerminalView` — and hands its events over through `sink`, so no
 * boundary can arrive before this is listening.
 *
 * Gated on `active` for the reason every timer and scan in a pane is: each
 * tab stays mounted, and reading the cursor on every write in a tab nobody is
 * looking at buys nothing.
 */
export function useShellBlocks({
  term,
  sessionId,
  active,
  live,
  sink,
}: {
  term: Terminal | null
  sessionId: string
  active: boolean
  /** Whether the session's process is still there to type into. */
  live: boolean
  /** Filled in with the handler the terminal's OSC 133 route calls. */
  sink: React.RefObject<((event: ShellEvent, at: Position) => void) | null>
}): ShellSurface {
  const blocks = useRef<TrackedBlock[]>([])
  const openPrompt = useRef<TrackedBlock | null>(null)
  /** Names each block for React, since two can start on the same row. */
  const keys = useRef(0)
  const history = useRef<string[]>([])
  const ran = useRef<string[]>([])
  /** What the reader put away, so it does not come back on the next frame. */
  const dismissed = useRef<string | null>(null)
  const [reporting, setReporting] = useState(false)
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null)
  const [selected, setSelected] = useState(-1)

  useEffect(() => {
    if (!term) return
    const mark = (at: Position): Tracked | null => {
      const marker = term.registerMarker(0)
      return marker ? { marker, col: at.col } : null
    }

    // What the shell said it was about to run, which arrives just before the
    // output starts.
    let announced: string | null = null
    let asked = ''
    const loadHistory = async (path: string) => {
      if (asked === path) return
      const found = await shellHistory(path)
      // Marked only once it answered: setting it before the await leaves a
      // read that failed — an unreadable moment, a path that has gone — as a
      // tab with no completions for the rest of the session.
      asked = path
      history.current = found
    }

    sink.current = (event, at) => {
      setReporting(true)
      switch (event.kind) {
        case 'promptStart': {
          forget(openPrompt.current)
          openPrompt.current = null
          // A command reported with no prompt open belongs to nothing — a
          // startup file's own lines reach bash's DEBUG trap — and must not
          // be attributed to whatever runs next.
          announced = null
          return
        }
        case 'promptEnd': {
          // Taken again rather than kept: a multi-line prompt is redrawn by
          // the line editor, which reports its end a second time — and the
          // later one is where typing actually starts.
          const input = mark(at)
          if (input) {
            // The block it replaces never became a command — a prompt
            // redrawn reports its end again — so its marker is released
            // here. `MAX_BLOCKS` bounds the ones that did; nothing else
            // bounds these, and a redrawn prompt is the normal case.
            forget(openPrompt.current)
            openPrompt.current = {
              key: (keys.current += 1),
              input,
              output: null,
              end: null,
              command: '',
            }
          }
          return
        }
        case 'outputStart': {
          const block = openPrompt.current
          if (!block) return
          block.output = mark(at)
          // The shell's own answer first: read off the grid instead, a
          // session with a right prompt captured the command, its padding and
          // the right prompt as one string — and accepting a suggestion typed
          // all three back. The rendered row is the fallback for a shell that
          // reports no command.
          // The shell's answer is preferred, but only where the grid agrees
          // something was typed. Both scripts open the output section with no
          // command report when Enter is taken on an empty line, so a report
          // that arrived from anywhere else — anything can print one — would
          // otherwise be attributed to that line as if it had been typed.
          const drawn = commandOf(term.buffer.active, resolveBlock(block))
          const typed = drawn ? (announced ?? drawn) : ''
          announced = null
          block.command = typed
          if (typed) {
            ran.current.push(typed)
            if (ran.current.length > MAX_RAN) ran.current.shift()
          }
          blocks.current.push(block)
          // The prompt is closed the moment its command starts: what the
          // cursor is on from here is output, and a completion offered
          // against it would be drawn over the program that is running.
          openPrompt.current = null
          for (const dropped of blocks.current.splice(
            0,
            Math.max(0, blocks.current.length - MAX_BLOCKS),
          )) {
            forget(dropped)
          }
          return
        }
        case 'commandEnd': {
          forget(openPrompt.current)
          openPrompt.current = null
          const block = blocks.current.at(-1)
          if (!block || block.end) return
          block.end = mark(at)
          return
        }
        case 'command':
          announced = event.text
          return
        case 'historyFile':
          void loadHistory(event.path).catch(report)
      }
    }

    return () => {
      sink.current = null
      for (const block of blocks.current) forget(block)
      forget(openPrompt.current)
      blocks.current = []
      openPrompt.current = null
    }
  }, [term, sink])

  // The offer follows the cursor, which nothing in the component tree owns —
  // so it is read from the terminal on the events that move it, and coalesced
  // into a frame because a held key moves the cursor faster than React can
  // usefully re-render.
  useEffect(() => {
    if (!term || !active || !live) {
      setSuggestions(null)
      return
    }
    let frame = 0
    const read = () => {
      frame = 0
      const found = suggestionsIn(term, openPrompt.current, {
        ran: ran.current,
        stored: history.current,
      })
      if (found && found.typed === dismissed.current)
        return setSuggestions(null)
      dismissed.current = null
      setSuggestions((previous) => (same(previous, found) ? previous : found))
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read)
    }
    read()
    const moved = term.onCursorMove(schedule)
    const written = term.onWriteParsed(schedule)
    return () => {
      moved.dispose()
      written.dispose()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [term, active, live])

  // Any new prefix is a new list, so nothing can stay chosen across one.
  const typed = suggestions?.typed
  const walked = useRef<string | undefined>(undefined)
  if (walked.current !== typed) {
    walked.current = typed
    if (selected !== -1) setSelected(-1)
  }

  const accept = useCallback(
    (index?: number) => {
      if (!suggestions || !term) return false
      const chosen = suggestions.matches[Math.max(0, index ?? selected)]
      if (!chosen) return false
      // Re-read rather than trusted: this state is a frame behind the
      // keyboard — it is set from a `requestAnimationFrame` hung off the
      // cursor — so a key pressed inside that window would have the rest
      // computed against a prefix that is already short. Measured shape:
      // type `git s`, then `t`, then press → before the echo lands, and the
      // line becomes `git sttatus`.
      const prompt = openPrompt.current
      const typed =
        prompt && prompt.input.marker.line >= 0
          ? typedAt(term.buffer.active, resolve(prompt.input), {
              row: term.buffer.active.baseY + term.buffer.active.cursorY,
              col: term.buffer.active.cursorX,
            })
          : null
      if (typed === null || !chosen.startsWith(typed)) return false
      const rest = completionFor(typed, [chosen])
      if (!rest) return false
      // Straight to the pty rather than through `term.paste`: this is a
      // keystroke the reader made, and bracketing it would have the shell treat
      // it as pasted text — which some line editors then refuse to run. The
      // line is filled in and left there: running it is still a press of Enter
      // the reader makes, having read it.
      void writePty(sessionId, rest).catch(report)
      // A row of the list is a real button outside the grid, so a click on
      // one takes DOM focus off xterm's textarea; without this the line is
      // filled in and the next thing typed goes nowhere.
      term.focus()
      setSuggestions(null)
      dismissed.current = typed
      return true
    },
    [selected, sessionId, suggestions, term],
  )

  const move = useCallback(
    (step: -1 | 1) => {
      const count = suggestions?.matches.length ?? 0
      if (count === 0) return false
      // Up out of the first row hands the key back to the shell, whose own
      // history recall is what it does at a prompt — the list is an offer,
      // never a mode the reader has to escape.
      if (step === -1 && selected <= 0) return false
      setSelected((at) => Math.min(count - 1, at + step))
      return true
    },
    [selected, suggestions],
  )

  const dismiss = useCallback(() => {
    if (!suggestions) return false
    dismissed.current = suggestions.typed
    setSuggestions(null)
    return true
  }, [suggestions])

  const blockAt = useCallback((row: number): ResolvedBlock | null => {
    for (let index = blocks.current.length - 1; index >= 0; index -= 1) {
      const block = resolveBlock(blocks.current[index]!)
      if (block.input.row < 0) continue
      const last = block.end?.row ?? Infinity
      if (row >= block.input.row && row <= last) return block
    }
    return null
  }, [])

  const lastFinished = useCallback((): ResolvedBlock | null => {
    for (let index = blocks.current.length - 1; index >= 0; index -= 1) {
      const block = resolveBlock(blocks.current[index]!)
      // Where the output starts has to still be in the scrollback: a trimmed
      // marker answers -1, and `textBetween` refuses it, so a block trimmed
      // at that end would copy nothing rather than what the reader asked for.
      // `end` needs no test of its own — it is registered at or below
      // `output` and trimmed by the same amount.
      if (block.end && block.output && block.output.row >= 0) return block
    }
    return null
  }, [])

  const outputText = useCallback(
    (block: ResolvedBlock) => (term ? outputOf(term.buffer.active, block) : ''),
    [term],
  )
  return {
    reporting,
    suggestions,
    selected,
    move,
    dismiss,
    accept,
    blockAt,
    lastFinished,
    outputText,
  }
}

/** Releases the markers a block held, so xterm stops moving them. */
function forget(block: TrackedBlock | null) {
  if (!block) return
  for (const tracked of [block.input, block.output, block.end]) {
    tracked?.marker.dispose()
  }
}

/**
 * What the open prompt could become, or `null`.
 *
 * The alternate buffer answers nothing: a full-screen program draws its own
 * input, and the last prompt this saw is behind it.
 */
function suggestionsIn(
  term: Terminal,
  prompt: TrackedBlock | null,
  history: History,
): Suggestions | null {
  const buffer = term.buffer.active
  if (!prompt || buffer.type !== 'normal') return null
  const input = resolve(prompt.input)
  if (input.row < 0) return null
  const cursor = { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX }
  const typed = typedAt(buffer, input, cursor)
  if (typed === null) return null
  const matches = matchesFor(typed, history)
  return matches.length > 0 ? { at: cursor, typed, matches } : null
}

/**
 * Whether two reads found the same offer in the same place.
 *
 * Identity is kept when they did, because this is read on every write batch
 * and a fresh object per frame would re-render the list under the pointer.
 */
function same(a: Suggestions | null, b: Suggestions | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.typed === b.typed &&
    a.at.row === b.at.row &&
    a.at.col === b.at.col &&
    a.matches.length === b.matches.length &&
    a.matches.every((match, index) => match === b.matches[index])
  )
}
