import { describe, expect, test } from 'bun:test'

import {
  currentMessage,
  findMessageRows,
  type Message,
  type MessageBuffer,
  nextMessage,
  previousMessage,
} from './messages'

/**
 * A buffer from a picture of one: `#` is a tinted row, `.` a plain one, read
 * top to bottom. Keeping the fixture visual is the point — the thing being
 * tested is which row a block *starts* on, and that is easy to miscount in
 * prose and obvious in a diagram.
 */
const bufferOf = (rows: string): MessageBuffer => {
  const lines = rows.trim().split('\n')
  return {
    length: lines.length,
    getLine: (row) => {
      const line = lines[row]
      if (line === undefined) return undefined
      return {
        getCell: () => ({ isBgDefault: () => line !== '#' }),
        translateToString: () => (line === '#' ? `> message ${row}` : ''),
      }
    },
  }
}

const rowsOf = (buffer: MessageBuffer, limit?: number) =>
  findMessageRows(buffer, limit).map((message) => message.row)

test('a tinted row is where a message starts', () => {
  expect(rowsOf(bufferOf('.\n#\n.'))).toEqual([1])
})

test('a message spanning several rows is one place to jump to', () => {
  // The whole point of tracking runs: a five-line prompt is one message, and
  // five marks would say the user wrote five things.
  expect(rowsOf(bufferOf('.\n#\n#\n#\n.'))).toEqual([1])
})

test('every message gets a mark, newest first', () => {
  expect(rowsOf(bufferOf('#\n.\n#\n#\n.\n#'))).toEqual([5, 2, 0])
})

test('a message still being written at the end of the buffer is found', () => {
  expect(rowsOf(bufferOf('.\n.\n#\n#'))).toEqual([2])
})

test('a buffer that is entirely one message starts at the top', () => {
  // The upward walk never sees the tint stop, so the run's start is row 0 —
  // the case the check after the loop exists to catch.
  expect(rowsOf(bufferOf('#\n#\n#'))).toEqual([0])
})

test('output with no tinted row yields nothing rather than a mark per line', () => {
  expect(rowsOf(bufferOf('.\n.\n.'))).toEqual([])
  expect(rowsOf({ length: 0, getLine: () => undefined })).toEqual([])
})

test('the limit bounds the walk, keeping the newest', () => {
  // A long session must not put a thousand marks in the DOM, and the ones
  // worth keeping are the recent ones.
  const alternating = Array.from({ length: 40 }, (_, i) =>
    i % 2 === 0 ? '#' : '.',
  ).join('\n')
  expect(rowsOf(bufferOf(alternating), 3)).toEqual([38, 36, 34])
})

test('a row the buffer cannot supply is not a message', () => {
  // `getLine` answers undefined for a row trimmed away under us.
  expect(rowsOf({ length: 3, getLine: () => undefined })).toEqual([])
})

test('a mark is labelled with the message, without the prompt glyph', () => {
  // The label is what tells one mark from another on hover, so the agent's
  // decoration has to come off — every message starts with it otherwise.
  const [message] = findMessageRows(bufferOf('.\n#\n.'))
  expect(message?.label).toBe('message 1')
})

describe('stepping between messages', () => {
  const rows: Message[] = [
    { row: 900, label: 'fourth' },
    { row: 600, label: 'third' },
    { row: 300, label: 'second' },
    { row: 10, label: 'first' },
  ]

  test('previous finds the nearest message above the screen', () => {
    expect(previousMessage(rows, 650)?.row).toBe(600)
  })

  test('next finds the nearest message below the screen', () => {
    expect(nextMessage(rows, 650)?.row).toBe(900)
  })

  test('a message already on screen is not somewhere to go next', () => {
    // Viewport bottom past the last message: there is nothing below it, so the
    // caller falls through to the end of the scrollback instead of a no-op
    // scroll onto a row xterm would clamp away.
    expect(nextMessage(rows, 950)).toBeNull()
  })

  test('a message at the top of the screen is not the previous one', () => {
    expect(previousMessage(rows, 600)?.row).toBe(300)
  })

  test('the ends answer nothing rather than wrapping round', () => {
    expect(previousMessage(rows, 0)).toBeNull()
    expect(nextMessage(rows, 900)).toBeNull()
  })

  test('no messages at all is not an error', () => {
    expect(previousMessage([], 42)).toBeNull()
    expect(nextMessage([], 42)).toBeNull()
  })
})

describe('currentMessage', () => {
  const rows: Message[] = [
    { row: 900, label: 'fourth' },
    { row: 600, label: 'third' },
    { row: 300, label: 'second' },
    { row: 10, label: 'first' },
  ]

  test('the newest message on screen is the current one', () => {
    expect(currentMessage(rows, 650)?.label).toBe('third')
  })

  test('a message just sent is current while it is still near the bottom', () => {
    // xterm clamps the viewport's top row, so a fresh message sits below it
    // for its whole first screenful; measuring from the bottom is what makes
    // its dot fill immediately.
    expect(currentMessage(rows, 900)?.label).toBe('fourth')
  })

  test("a message's own first row counts as being inside it", () => {
    expect(currentMessage(rows, 600)?.label).toBe('third')
  })

  test('scrolling through its output keeps that message current', () => {
    expect(currentMessage(rows, 899)?.label).toBe('third')
  })

  test('above the first message nothing is current', () => {
    expect(currentMessage(rows, 9)).toBeNull()
  })

  test('no messages at all is not an error', () => {
    expect(currentMessage([], 42)).toBeNull()
  })
})

describe('a label the row itself chose', () => {
  /** One tinted row carrying `text`, with a plain row above it. */
  const buffer = (text: string): MessageBuffer => ({
    length: 2,
    getLine: (row) => ({
      getCell: () => ({ isBgDefault: () => row === 0 }),
      translateToString: (_trim?: boolean, start = 0, end = text.length) =>
        text.slice(start, end),
    }),
  })

  test('a run of zero-width characters is not a usable name', () => {
    expect(findMessageRows(buffer('​​​'))[0]!.label).toBe('')
  })

  test('a braille blank is not a usable name either', () => {
    expect(findMessageRows(buffer('⠀⠀'))[0]!.label).toBe('')
  })

  test('an orphaned surrogate is dropped rather than carried', () => {
    const label = findMessageRows(buffer(`${'x'.repeat(79)}\u{1F600}`))[0]!
      .label
    expect(label).toBe('x'.repeat(79))
  })

  test('ordinary text survives intact', () => {
    expect(findMessageRows(buffer('fix the parser'))[0]!.label).toBe(
      'fix the parser',
    )
  })
})

describe('the label a mark carries', () => {
  const rowOf = (text: string): string => {
    const line = {
      getCell: () => ({ isBgDefault: () => false }),
      translateToString: () => text,
    }
    const buffer: MessageBuffer = {
      length: 2,
      getLine: (row: number) => (row === 0 ? line : undefined),
    }
    return findMessageRows(buffer)[0]?.label ?? '(no message found)'
  }

  test('the prompt glyph and its padding are not part of the message', () => {
    expect(rowOf('❯  run the tests')).toBe('run the tests')
  })

  test('a label of only zero-width characters is refused, not carried', () => {
    // `\s` does not match these, so the prompt strip leaves them and a naive
    // emptiness test would pass a control with nothing readable in its name.
    expect(rowOf('\u200b\u200b\u200b')).toBe('')
    expect(rowOf('\u2800\u2800')).toBe('')
    expect(rowOf('\u3164')).toBe('')
  })

  test('real text beside a zero-width character is kept whole', () => {
    expect(rowOf('deploy\u200bnow')).toBe('deploy\u200bnow')
  })

  test('a cut landing inside a surrogate pair drops the orphan', () => {
    const label = rowOf(`${'x'.repeat(79)}\u{1F600}tail`)
    expect(label).toBe('x'.repeat(79))
  })
})

test('a run still open when the walk stops belongs to the row it stopped on', () => {
  // The scan is bounded, so a tinted block straddling that bound must be
  // recorded where the walk reached — row 0 is thousands of rows away and its
  // text has nothing to do with the message.
  const rows = ['.', ...Array.from({ length: 4200 }, () => '#')]
  const found = findMessageRows(bufferOf(rows.join('\n')))
  expect(found.every(({ row }) => row > 0)).toBe(true)
})
