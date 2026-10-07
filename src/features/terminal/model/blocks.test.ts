import { describe, expect, it } from 'bun:test'

import {
  type BlockBuffer,
  commandOf,
  outputOf,
  parseShellEvent,
  textBetween,
  typedAt,
} from './blocks'

/** A buffer of drawn rows, `>` marking one that wrapped from the row above. */
const bufferOf = (rows: string[]): BlockBuffer => {
  const lines = rows.map((row) => ({
    isWrapped: row.startsWith('>'),
    text: row.replace(/^>/, ''),
  }))
  return {
    length: lines.length,
    getLine: (row: number) => {
      const line = lines[row]
      if (!line) return undefined
      return {
        isWrapped: line.isWrapped,
        translateToString: (trimRight = false, start = 0, end?: number) => {
          const slice = line.text.slice(start, end)
          return trimRight ? slice.replace(/\s+$/, '') : slice
        },
      }
    },
  }
}

describe('parseShellEvent', () => {
  it('reads the four boundaries a shell reports', () => {
    expect(parseShellEvent('A')).toEqual({ kind: 'promptStart' })
    expect(parseShellEvent('B')).toEqual({ kind: 'promptEnd' })
    expect(parseShellEvent('C')).toEqual({ kind: 'outputStart' })
    expect(parseShellEvent('D;0')).toEqual({ kind: 'commandEnd' })
  })

  it('ends the command however the shell spells the status', () => {
    // The status is part of the sequence and nothing here shows it, so both
    // spellings have to end the command rather than one of them being missed.
    expect(parseShellEvent('D;130')).toEqual({ kind: 'commandEnd' })
    expect(parseShellEvent('D')).toEqual({ kind: 'commandEnd' })
  })

  it('takes the history file back through its escaping', () => {
    // `;` would end the field, so the shell writes it as hex.
    expect(parseShellEvent('P;HistFile=/home/a\\x3bb/.zsh_history')).toEqual({
      kind: 'historyFile',
      path: '/home/a;b/.zsh_history',
    })
  })

  it('reads the command the shell says it is about to run', () => {
    // Reported rather than read off the row, because a right prompt is drawn
    // on that same row — see the shell scripts.
    expect(parseShellEvent('P;Cmd=echo hi\\x3b echo two')).toEqual({
      kind: 'command',
      text: 'echo hi; echo two',
    })
  })

  it('refuses a command longer than anyone types at a prompt', () => {
    expect(parseShellEvent(`P;Cmd=${'x'.repeat(5000)}`)).toBeNull()
  })

  it('refuses a reported path carrying a control byte', () => {
    // It becomes a filesystem read, and anything that can print to the
    // session can write this sequence.
    expect(parseShellEvent('P;HistFile=/tmp/\\x1bx')).toBeNull()
  })

  it('answers nothing for a sequence it does not know', () => {
    // Another terminal's private codes travel in the same stream, and a throw
    // here would happen inside xterm's parser.
    expect(parseShellEvent('Q;something')).toBeNull()
    expect(parseShellEvent('P;Cwd=/tmp')).toBeNull()
    expect(parseShellEvent('')).toBeNull()
  })
})

describe('textBetween', () => {
  it('joins a wrapped row to the one above without a break', () => {
    // The break is the terminal's, not the text's: a path copied out of a
    // narrow pane would otherwise arrive in two pieces.
    const buffer = bufferOf(['echo one', '>two', 'done'])
    expect(textBetween(buffer, { row: 0, col: 0 }, { row: 2, col: 0 })).toBe(
      'echo onetwo',
    )
  })

  it('starts where it is told, so the prompt is not part of the command', () => {
    const buffer = bufferOf(['~/code ❯ git status', 'on main'])
    expect(textBetween(buffer, { row: 0, col: 9 }, { row: 1, col: 0 })).toBe(
      'git status',
    )
  })

  it('is empty when the two places are the same', () => {
    const buffer = bufferOf(['ls'])
    expect(textBetween(buffer, { row: 0, col: 2 }, { row: 0, col: 2 })).toBe('')
  })

  it('reads nothing from a row that has left the scrollback', () => {
    // A trimmed marker answers -1, and xterm's buffer has no bounds check:
    // once its circular list has wrapped, -1 resolves to a real stale row, so
    // walking from there returns the whole session instead of one command.
    const buffer = bufferOf(['one', 'two', 'three'])
    expect(textBetween(buffer, { row: -1, col: 0 }, { row: 2, col: 0 })).toBe(
      '',
    )
  })
})

const block = {
  key: 1,
  input: { row: 0, col: 9 },
  output: { row: 1, col: 0 },
  end: { row: 3, col: 0 },
}

describe('a reported command', () => {
  const buffer = bufferOf(['~/code ❯ ls -la', 'one', 'two', '~/code ❯ '])

  it('knows what was typed at its prompt', () => {
    expect(commandOf(buffer, block)).toBe('ls -la')
  })

  it('knows what it printed, and stops before the next prompt', () => {
    expect(outputOf(buffer, block)).toBe('one\ntwo')
  })

  it('has no output while it is still running', () => {
    expect(outputOf(buffer, { ...block, end: null })).toBe('')
  })
})

describe('typedAt', () => {
  it('reads what has been typed since the prompt ended', () => {
    const buffer = bufferOf(['~/code ❯ git pu'])
    expect(typedAt(buffer, { row: 0, col: 9 }, { row: 0, col: 15 })).toBe(
      'git pu',
    )
  })

  it('answers nothing when the cursor is not at the end of the line', () => {
    // Anything completed there would be pushed along by the text after it.
    const buffer = bufferOf(['~/code ❯ git push'])
    expect(typedAt(buffer, { row: 0, col: 9 }, { row: 0, col: 13 })).toBeNull()
  })

  it('answers nothing above the row typing started on', () => {
    // The shell is drawing something of its own over the prompt — a
    // completion menu, a reverse search — and that is not a line to complete.
    const buffer = bufferOf(['searching…', '~/code ❯ git'])
    expect(typedAt(buffer, { row: 1, col: 9 }, { row: 0, col: 3 })).toBeNull()
  })
})
