import { describe, expect, test } from 'bun:test'

import type { ChangedFile, Changes } from '../../../shared/ipc'
import { type EditGit, MAX_READ, type Memory, readEdits } from './editpass'

const entry = (path: string, insertions = 1, deletions = 0): ChangedFile => ({
  path,
  status: 'modified',
  oldPath: null,
  insertions,
  deletions,
  binary: false,
  counted: true,
})

const patch = (...lines: string[]) =>
  `diff --git a/f b/f
--- a/f
+++ b/f
@@ -1,${lines.length} +1,${lines.length} @@
${lines.join('\n')}
`

/** A tree that can be edited between passes, and a git that reads it. */
function fakeTree() {
  const tree = {
    files: new Array<ChangedFile>(),
    patches: new Map<string, string>(),
    failing: new Set<string>(),
    head: 'c1',
    root: '/r',
    broken: false,
    gitError: false,
    patchesAt: new Map<string, string>(),
    onPatch: (): unknown => undefined,
  }
  const git: EditGit = {
    changes: () =>
      tree.broken
        ? Promise.reject(new Error('index.lock'))
        : Promise.resolve<Changes>({
            repo: true,
            root: tree.root,
            commonDir: '/r/.git',
            base: '',
            error: tree.gitError ? 'git could not list the changes' : null,
            head: tree.head,
            files: tree.gitError ? [] : tree.files,
          }),
    // A patch is measured from the head it is asked for: one measured from a
    // head the tree has since moved past reads as the tree's own, unless the
    // test has said what that older head would show.
    // Like git, a renamed file named without its old path reads as the
    // whole file added — the shape the reader must never ask for.
    patch: ({ path, head, oldPath }) => {
      tree.onPatch()
      if (tree.failing.has(path)) return Promise.reject(new Error('git failed'))
      const renamed = tree.files.find((file) => file.path === path)?.oldPath
      if (renamed && !oldPath) return Promise.resolve(patch('+whole', '+file'))
      return Promise.resolve(
        tree.patchesAt.get(`${head}:${path}`) ?? tree.patches.get(path) ?? '',
      )
    },
  }
  const memory: Memory = {
    seen: { current: null },
    patches: new Map(),
    nextId: { current: 1 },
  }
  const pass = async () => (await readEdits({ cwd: '/r', memory, git })).edits
  return { tree, pass }
}

describe('readEdits', () => {
  test('the first pass is a baseline, not an edit', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts')]
    tree.patches.set('a.ts', patch('+old'))
    expect(await pass()).toEqual([])
  })

  test('a line rewritten in place is an edit, though no count moved', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+first'))
    await pass()
    tree.patches.set('a.ts', patch('+second'))
    const [edit] = await pass()
    expect(edit.path).toBe('a.ts')
    expect(edit.lines.map((line) => [line.kind, line.text])).toEqual([
      ['add', 'second'],
      ['del', 'first'],
    ])
  })

  test('an edit longer than the drawn lines is still counted whole', async () => {
    const { tree, pass } = fakeTree()
    await pass()
    const body = Array.from({ length: 500 }, (_, index) => `+line ${index}`)
    tree.files = [entry('big.ts', 500)]
    tree.patches.set('big.ts', patch(...body))
    const [edit] = await pass()
    expect(edit.added).toBe(500)
    expect(edit.lines.length).toBeLessThan(500)
  })

  test('files past the read budget are reported by their counts', async () => {
    const { tree, pass } = fakeTree()
    await pass()
    const many = MAX_READ + 5
    tree.files = Array.from({ length: many }, (_, index) =>
      entry(`f${index}`, 3),
    )
    const edits = await pass()
    expect(edits).toHaveLength(many)
    expect(edits.at(-1)).toMatchObject({ added: 3, lines: [] })
  })

  test('a read that fails is not mistaken for a file emptied', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 2)]
    tree.patches.set('a.ts', patch('+one', '+two'))
    await pass()
    tree.failing.add('a.ts')
    expect(await pass()).toEqual([])
  })

  test('a commit is not an edit, though its files leave the list', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 2)]
    tree.patches.set('a.ts', patch('+one', '+two'))
    await pass()
    tree.files = []
    tree.patches.clear()
    tree.head = 'c2'
    expect(await pass()).toEqual([])
  })

  test('a file taken back with no commit is an edit', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+oops'))
    await pass()
    tree.files = []
    tree.patches.clear()
    const [edit] = await pass()
    expect(edit).toMatchObject({ path: 'a.ts', status: null, removed: 1 })
  })

  test('staging a new file changes its status and nothing else', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [{ ...entry('n.ts', 1), status: 'untracked' }]
    tree.patches.set('n.ts', patch('+new'))
    await pass()
    tree.files = [{ ...entry('n.ts', 1), status: 'added' }]
    expect(await pass()).toEqual([])
  })

  test('a failed read keeps the baseline, so the edit after it still shows', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+one'))
    await pass()
    tree.broken = true
    await pass()
    tree.broken = false
    tree.files = [entry('a.ts', 2)]
    tree.patches.set('a.ts', patch('+one', '+two'))
    const [edit] = await pass()
    expect(edit.lines.map((line) => line.text)).toEqual(['two'])
  })

  test('a partial commit is not an edit, though the file stays changed', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 2)]
    tree.patches.set('a.ts', patch('+one', '+two'))
    await pass()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+two'))
    tree.head = 'c2'
    expect(await pass()).toEqual([])
  })

  test('a HEAD that moves with the list unchanged does not swallow the next edit', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+one'))
    await pass()
    tree.head = 'c2'
    expect(await pass()).toEqual([])
    tree.files = [entry('a.ts', 2)]
    tree.patches.set('a.ts', patch('+one', '+two'))
    const [edit] = await pass()
    expect(edit.lines.map((line) => line.text)).toEqual(['two'])
  })

  test('staging files past the read budget makes no empty cards', async () => {
    const { tree, pass } = fakeTree()
    const many = MAX_READ + 3
    tree.files = Array.from({ length: many }, (_, index) => ({
      ...entry(`n${index}.ts`, 1),
      status: 'untracked' as const,
    }))
    await pass()
    tree.files = tree.files.map((file) => ({
      ...file,
      status: 'added' as const,
    }))
    expect(await pass()).toEqual([])
  })

  test('a git failure is not every file taken back', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+one'))
    await pass()
    tree.gitError = true
    expect(await pass()).toEqual([])
  })

  test('a patch is read against the head the list was read against', async () => {
    // The agent commits between the list and the patch: measured from the
    // new head the patch would be empty, and every line would read as removed.
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+one'))
    await pass()
    tree.files = [entry('a.ts', 2)]
    tree.patchesAt.set('c1:a.ts', patch('+one', '+two'))
    tree.patches.set('a.ts', '')
    const [edit] = await pass()
    expect(edit.lines.map((line) => [line.kind, line.text])).toEqual([
      ['add', 'two'],
    ])
  })

  test('an unprimed file whose additions shrink reads as lines removed', async () => {
    // Past the primed set nothing is known of its lines, only its counts.
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 10)]
    tree.failing.add('a.ts')
    await pass()
    tree.files = [entry('a.ts', 5)]
    const [edit] = await pass()
    expect(edit).toMatchObject({ added: 0, removed: 5 })
  })

  test('a rename shows nothing, and the next edit shows only itself', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+one'))
    await pass()
    tree.files = [{ ...entry('b.ts', 2), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('b.ts', patch('+one', '+two'))
    expect(await pass()).toEqual([])
    tree.files = [{ ...entry('b.ts', 3), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('b.ts', patch('+one', '+two', '+three'))
    const [edit] = await pass()
    expect(edit.lines.map((line) => line.text)).toEqual(['three'])
    expect(edit.oldPath).toBe('a.ts')
  })

  test('renaming twice shows nothing', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [{ ...entry('b.ts', 1), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('b.ts', patch('+one'))
    await pass()
    tree.files = [{ ...entry('c.ts', 1), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('c.ts', patch('+one'))
    expect(await pass()).toEqual([])
  })

  test('a move that git only later sees as a rename shows nothing', async () => {
    // `mv a b` leaves `b` untracked; `git add -A` turns it into a rename.
    const { tree, pass } = fakeTree()
    tree.files = [
      { ...entry('a.ts', 0, 3), status: 'deleted' },
      { ...entry('b.ts', 3), status: 'untracked' },
    ]
    tree.patches.set('a.ts', patch('-x', '-y', '-z'))
    tree.patches.set('b.ts', patch('+x', '+y', '+z'))
    await pass()
    tree.files = [{ ...entry('b.ts', 0), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('b.ts', '')
    expect(await pass()).toEqual([])
  })

  test('a renamed file is never re-read under its new name alone', async () => {
    // The re-check and a later baseline would otherwise read the whole file
    // added, and report it one poll after the rename.
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 1)]
    tree.patches.set('a.ts', patch('+one'))
    await pass()
    tree.files = [{ ...entry('b.ts', 1), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('b.ts', patch('+one'))
    expect(await pass()).toEqual([])
    expect(await pass()).toEqual([])
  })

  test('a counted file that goes uncounted is not lines removed', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [entry('a.ts', 4)]
    tree.failing.add('a.ts')
    await pass()
    tree.files = [{ ...entry('a.ts', 0), status: 'untracked', counted: false }]
    expect(await pass()).toEqual([])
  })

  test('a rename that changes source with the same counts shows nothing', async () => {
    const { tree, pass } = fakeTree()
    tree.files = [{ ...entry('b.ts', 2), status: 'renamed', oldPath: 'a.ts' }]
    tree.patches.set('b.ts', patch('+one', '+two'))
    await pass()
    tree.files = [{ ...entry('b.ts', 2), status: 'renamed', oldPath: 'x.ts' }]
    tree.patches.set('b.ts', patch('+uno', '+dos'))
    expect(await pass()).toEqual([])
  })

  test('a folder of renames reads no more than the priming budget', async () => {
    const { tree, pass } = fakeTree()
    let reads = 0
    const names = Array.from({ length: 40 }, (_, index) => `f${index}.ts`)
    tree.files = names.map((name) => entry(`old/${name}`, 1))
    await pass()
    tree.files = names.map((name) => ({
      ...entry(`new/${name}`, 1),
      status: 'renamed' as const,
      oldPath: `old/${name}`,
    }))
    tree.onPatch = () => (reads += 1)
    expect(await pass()).toEqual([])
    expect(reads).toBeLessThanOrEqual(20)
  })
})
