import { expect, test } from 'bun:test'

import { fileAbove, findFileBlocks } from './codeblocks'
import type { MessageBuffer } from './messages'

/** A buffer from a list of rendered rows, top to bottom. */
const buffer = (rows: string[]): MessageBuffer => ({
  length: rows.length,
  getLine: (row) => ({
    getCell: () => ({ isBgDefault: () => true }),
    translateToString: (
      _t?: boolean,
      start = 0,
      end = rows[row]?.length ?? 0,
    ) => (rows[row] ?? '').slice(start, end),
  }),
})

test('the nearest file named above a row is the one it is about', () => {
  const rows = [
    '⏺ Update(src/app/main.tsx)',
    '  some output',
    '⏺ Write(src/features/terminal/model/messages.ts)',
    '  more output',
    '  and more',
  ]
  expect(fileAbove(buffer(rows), 4)?.label).toBe('model/messages.ts')
  expect(fileAbove(buffer(rows), 1)?.label).toBe('app/main.tsx')
})

test('a row that names the file itself counts as inside it', () => {
  expect(fileAbove(buffer(['⏺ Read(a/b/c.rs)']), 0)?.label).toBe('b/c.rs')
})

test('output with no file named above it has no path to show', () => {
  expect(fileAbove(buffer(['just output', 'more']), 1)).toBeNull()
})

test('a home-relative path is shown by its tail, like any other', () => {
  const rows = ['⏺ Update(~/Documents/GitHub/project/src/deep/thing.ts)']
  expect(fileAbove(buffer(rows), 0)?.label).toBe('deep/thing.ts')
})

test('every verb an agent uses to touch a file is recognised', () => {
  for (const verb of ['Update', 'Write', 'Edit', 'Read', 'Create', 'MultiEdit'])
    expect(fileAbove(buffer([`⏺ ${verb}(x/y.ts)`]), 0)?.label).toBe('x/y.ts')
})

test('a bare function call in the output is not a file', () => {
  expect(fileAbove(buffer(['  const x = compute(a, b)']), 0)).toBeNull()
})

test('a file named on screen is found, not stepped over', () => {
  // The viewport's last row is what is passed, so a file named in the middle
  // of what you are looking at counts — searching from the top would miss it.
  const rows = [
    '  older output',
    '⏺ Update(src/app/main.tsx)',
    '  the edit',
    '  still on screen',
  ]
  expect(fileAbove(buffer(rows), 3)?.label).toBe('app/main.tsx')
})

test('a file named on screen counts, not just one that scrolled away', () => {
  // Called with the viewport's bottom row: at the end of a session the line
  // naming the file is usually still visible, below the top row.
  const rows = ['old output', '⏺ Update(src/app/App.tsx)', 'fresh output']
  expect(fileAbove(buffer(rows), 2)?.label).toBe('app/App.tsx')
})

test('an elided path is skipped for a real one further up', () => {
  // Measured live: an agent prints `Read(…)` when the path is too long for its
  // own column, and that ellipsis labelled the strip with nothing readable.
  expect(
    fileAbove(buffer(['Read(src/app/main.tsx)', 'Read(…)']), 1)?.label,
  ).toBe('app/main.tsx')
})

test('an elided path with nothing above it names no file', () => {
  expect(fileAbove(buffer(['Read(…)']), 0)).toBeNull()
})

test('the shape Claude Code actually prints names the file', () => {
  // Measured over 4.1 MB of recorded sessions: this form appears 320 times and
  // `Update(…)` never does. Getting this wrong left the label blank all session.
  expect(
    fileAbove(buffer(['⏺ Updated src-tauri/src/pty.rs (+16 -0)']), 0)?.label,
  ).toBe('src/pty.rs')
})

test('a created and a deleted file are named the same way', () => {
  expect(
    fileAbove(buffer(['⏺ Created src/features/terminal/ui/rail.tsx']), 0)
      ?.label,
  ).toBe('ui/rail.tsx')
  expect(fileAbove(buffer(['⏺ Deleted docs/old.md']), 0)?.label).toBe(
    'docs/old.md',
  )
})

test('a shell command is not a file', () => {
  // `Bash(…)` is the one parenthesised header Claude Code does print, and it
  // names a command — labelling the strip with it would be a lie.
  expect(fileAbove(buffer(["⏺ Bash(python3 - <<'PY')"]), 0)).toBeNull()
})

test('prose about having updated something is not a path', () => {
  expect(fileAbove(buffer(['I updated the docs and the tests']), 0)).toBeNull()
  expect(fileAbove(buffer(['Updated the settings pane']), 0)).toBeNull()
})

test('a file mark spans the output it owns, not just its header', () => {
  // The bar has to be as tall as the block, and a block ends where the next
  // file is named — the same region `fileAbove` answers that file for, so the
  // bar and the label cannot disagree about where a file's output ends.
  const rows = [
    '⏺ Updated src/app/main.tsx (+2 -0)',
    '  output',
    '⏺ Created docs/notes.md',
    '  output',
  ]
  expect(findFileBlocks(buffer(rows))).toEqual([
    { row: 2, endRow: 3, label: 'docs/notes.md' },
    { row: 0, endRow: 1, label: 'app/main.tsx' },
  ])
})

test('the newest block runs to the end of the buffer', () => {
  const rows = ['x', '⏺ Updated a/b.ts', 'y', 'z']
  expect(findFileBlocks(buffer(rows))[0]).toEqual({
    row: 1,
    endRow: 3,
    label: 'a/b.ts',
  })
})

test('a block stops well short of the whole scrollback', () => {
  // Headers tile the buffer, so an unbounded block reaches the end of the
  // session and paints the bar in one colour.
  const rows = ['⏺ Updated a/b.ts', ...Array.from({ length: 900 }, () => 'x')]
  const [block] = findFileBlocks(buffer(rows))
  expect(block!.endRow).toBe(24)
})

test('a block is one row when the next file is named immediately below', () => {
  const rows = ['⏺ Updated a/b.ts', '⏺ Updated c/d.ts']
  expect(findFileBlocks(buffer(rows)).map((m) => [m.row, m.endRow])).toEqual([
    [1, 1],
    [0, 0],
  ])
})

test('one file touched twice is two places, not one', () => {
  // The marks say where the work happened, so the second edit to a file is a
  // second position in the session — deduping would hide it.
  const rows = ['⏺ Updated a/b.ts', 'x', '⏺ Updated a/b.ts']
  expect(findFileBlocks(buffer(rows)).map((m) => m.row)).toEqual([2, 0])
})

test('the limit keeps the newest marks', () => {
  const rows = Array.from({ length: 30 }, (_, i) => `⏺ Updated src/f${i}.ts`)
  expect(findFileBlocks(buffer(rows), 3).map((m) => m.label)).toEqual([
    'src/f29.ts',
    'src/f28.ts',
    'src/f27.ts',
  ])
})

test('output naming no file yields no marks', () => {
  expect(findFileBlocks(buffer(['just output', 'more output']))).toEqual([])
})

test('a home-relative path is named like any other', () => {
  expect(fileAbove(buffer(['⏺ Updated ~/proj/src/main.tsx']), 0)?.label).toBe(
    'src/main.tsx',
  )
})
