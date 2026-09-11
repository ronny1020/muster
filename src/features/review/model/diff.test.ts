import { describe, expect, test } from 'bun:test'

import { hunksWithin, parsePatch, sideIndex, sideText, usedSides } from './diff'

const PATCH = `diff --git a/src/deck.ts b/src/deck.ts
index 1111111..2222222 100644
--- a/src/deck.ts
+++ b/src/deck.ts
@@ -10,4 +10,5 @@ export function deckReducer(
   switch (action.type) {
-    case 'open':
+    case 'open':
+    case 'reopen':
       return open(deck)
`

describe('parsePatch', () => {
  test('each side keeps its own line numbering', () => {
    // The bug this guards against: counting one cursor for both sides, which
    // makes every number after the first change point at the wrong line.
    const [hunk] = parsePatch(PATCH).hunks

    expect(
      hunk!.lines.map((line) => [line.kind, line.oldLine, line.newLine]),
    ).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
    ])
  })

  test('a header that omits its counts still gives both starts', () => {
    // git writes `@@ -1 +1 @@` for a one-line hunk.
    const { hunks } = parsePatch('@@ -1 +1 @@\n-old\n+new\n')

    expect(hunks[0]!.oldStart).toBe(1)
    expect(hunks[0]!.newStart).toBe(1)
    expect(hunks[0]!.lines).toHaveLength(2)
  })

  test('the next file’s header ends the hunk rather than joining it', () => {
    const two = `@@ -1,1 +1,1 @@
-one
+uno
diff --git a/b.txt b/b.txt
--- a/b.txt
+++ b/b.txt
@@ -5,1 +5,1 @@
-five
+cinco
`
    const { hunks } = parsePatch(two)

    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.lines).toHaveLength(2)
    expect(hunks[1]!.oldStart).toBe(5)
  })

  test('a binary file reports itself rather than parsing to nothing', () => {
    // An empty hunk list would render as "no changes", which is a lie.
    const parsed = parsePatch(
      'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n',
    )

    expect(parsed.binary).toBe(true)
    expect(parsed.hunks).toEqual([])
  })

  test('the missing-newline note numbers no line of its own', () => {
    const { hunks } = parsePatch(
      '@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+one\n',
    )
    const meta = hunks[0]!.lines[1]!

    expect(meta.kind).toBe('meta')
    expect(meta.text).toBe('No newline at end of file')
    expect(hunks[0]!.lines[2]!.newLine).toBe(1)
  })

  test('the synthesised patch for a new file parses as all additions', () => {
    // This is the shape the backend builds for an untracked file, since git
    // has no diff to give for one.
    const { hunks } = parsePatch(
      '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n',
    )

    expect(hunks[0]!.lines.map((line) => line.newLine)).toEqual([1, 2])
    expect(hunks[0]!.lines.every((line) => line.kind === 'add')).toBe(true)
  })

  test('a patch with no hunks at all is empty, not an error', () => {
    expect(parsePatch('').hunks).toEqual([])
    expect(parsePatch('--- /dev/null\n+++ b/empty.txt\n').hunks).toEqual([])
  })
})

describe('highlighting input', () => {
  test('each side is reassembled whole, in file order', () => {
    // One string per side, so the grammar is never restarted mid-file.
    const { hunks } = parsePatch(PATCH)

    expect(sideText(hunks, 'old').split('\n')).toEqual([
      '  switch (action.type) {',
      "    case 'open':",
      '      return open(deck)',
    ])
    expect(sideText(hunks, 'new').split('\n')).toHaveLength(4)
  })

  test('a row’s index is where its text landed on that side', () => {
    const { hunks } = parsePatch(PATCH)
    const lines = hunks[0]!.lines
    const old = sideIndex(hunks, 'old')
    const fresh = sideIndex(hunks, 'new')

    // The removed line is on the old side only, the added ones on the new.
    expect(old.get(lines[1]!)).toBe(1)
    expect(fresh.has(lines[1]!)).toBe(false)
    expect(fresh.get(lines[3]!)).toBe(2)
    // The trailing context line follows both sides' additions.
    expect(old.get(lines[4]!)).toBe(2)
    expect(fresh.get(lines[4]!)).toBe(3)
  })
})

describe('usedSides', () => {
  test('an edit numbers both sides', () => {
    expect(usedSides(parsePatch(PATCH).hunks)).toEqual({ old: true, new: true })
  })

  test('a new file has no old side to number', () => {
    // Its gutter would be an empty column on every row.
    const { hunks } = parsePatch('@@ -0,0 +1,2 @@\n+alpha\n+beta\n')

    expect(usedSides(hunks)).toEqual({ old: false, new: true })
  })

  test('a deleted file has no new side', () => {
    const { hunks } = parsePatch('@@ -1,2 +0,0 @@\n-alpha\n-beta\n')

    expect(usedSides(hunks)).toEqual({ old: true, new: false })
  })
})

describe('hunksWithin', () => {
  const hunk = (rows: number) =>
    parsePatch(`@@ -1,${rows} +1,${rows} @@\n${'+line\n'.repeat(rows)}`)
      .hunks[0]!

  test('a diff inside the budget is drawn whole', () => {
    const { hunks, rows, total } = hunksWithin([hunk(3), hunk(4)], 100)

    expect(hunks).toHaveLength(2)
    expect([rows, total]).toEqual([7, 7])
  })

  test('whole hunks only, so no header promises rows that are missing', () => {
    const { hunks, rows, total } = hunksWithin([hunk(4), hunk(4), hunk(4)], 9)

    expect(hunks).toHaveLength(2)
    expect([rows, total]).toEqual([8, 12])
  })

  test('one hunk larger than the whole budget is cut, not admitted whole', () => {
    // `All` context asks git for the file as a single hunk, so admitting the
    // first one whole let every row through the budget untouched.
    const { hunks, rows, total } = hunksWithin([hunk(50)], 10)

    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.lines).toHaveLength(10)
    expect([rows, total]).toEqual([10, 50])
  })

  test('a cut hunk keeps the numbering of the rows it kept', () => {
    const { hunks } = hunksWithin([hunk(50)], 3)
    const kept = hunks[0]!.lines.map((line) => line.newLine)

    expect(kept).toEqual([1, 2, 3])
  })

  test('a later hunk that does not fit is dropped whole, not cut', () => {
    // Only the first is ever cut, and only because stopping there would show
    // nothing at all.
    const { hunks, rows } = hunksWithin([hunk(4), hunk(50)], 10)

    expect(hunks).toHaveLength(1)
    expect(rows).toBe(4)
  })
})
