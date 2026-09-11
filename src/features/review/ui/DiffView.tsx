import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import {
  type DiffLine,
  type Hunk,
  hunksWithin,
  parsePatch,
  sideIndex,
  sideText,
  usedSides,
} from '../model/diff'
import {
  type HighlightedLines,
  highlight,
  languageFor,
} from '../model/highlight'
import { codeStyle } from '../model/codestyle'
import type { LineOpener } from '../model/openline'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { useFontMetrics } from '../../../shared/lib/fontmetrics'
import { useFileDiff } from '../model/useFileDiff'
import { TokenLine } from './TokenLine'

export interface DiffViewProps {
  cwd: string
  /** Repo-relative, which is how git names the file. */
  path: string
  /** Branch being compared against, or `''` for uncommitted work. */
  base: string
  /** Unchanged lines kept around each hunk. */
  context: number
  /** Changes whenever the tree may have moved, which re-reads the diff. */
  revision: string
  /** A line of the new file to scroll to, from a click in the terminal. */
  line: number | null
  wrap: boolean
  /** Set when an editor was found, which is what makes the gutter clickable. */
  opener: LineOpener | null
}

/** Colour per row kind: the tint is the whole point of a diff. */
const ROW_TONE: Record<DiffLine['kind'], string> = {
  add: 'bg-[#1e3024]',
  del: 'bg-[#33211f]',
  context: '',
  meta: 'text-faint italic',
}

/** What a screen reader hears instead of the tint. */
const SPOKEN: Record<DiffLine['kind'], string> = {
  add: 'added line',
  del: 'removed line',
  context: '',
  meta: '',
}

const MARKER: Record<DiffLine['kind'], string> = {
  add: '+',
  del: '-',
  context: ' ',
  meta: '\\',
}

/** One file's changes, read-only, in the terminal's own monospace. */
export function DiffView({
  cwd,
  path,
  base,
  context,
  revision,
  line,
  wrap,
  opener,
}: DiffViewProps) {
  const { settings } = useSettings()
  const metrics = useFontMetrics(settings.fontFamily, settings.fontSize)
  const { diff, error, loading } = useFileDiff(
    cwd,
    path,
    base,
    context,
    revision,
  )
  const parsed = useMemo(() => (diff ? parsePatch(diff.patch) : null), [diff])
  const highlighted = useHighlightedSides(parsed?.hunks, path)
  const sides = useMemo(() => usedSides(parsed?.hunks ?? []), [parsed])
  const budget = useMemo(() => hunksWithin(parsed?.hunks ?? []), [parsed])

  // Only when there is nothing to show yet: a re-read of the file already on
  // screen keeps its rows, and its scroll position with them.
  if (loading && !parsed) return <Notice>Reading the diff…</Notice>
  if (error) return <Notice tone="text-danger">{error}</Notice>
  if (!parsed) return null
  if (parsed.binary) return <Notice>Binary file — nothing to show.</Notice>
  if (parsed.hunks.length === 0) {
    // A rename or a mode change has no hunks, and neither does a file that
    // stopped differing between the list being read and the diff being asked
    // for — an agent reverting its own edit, or a commit landing.
    return <Notice>Nothing textual changed in this file.</Notice>
  }

  return (
    <div
      style={codeStyle(settings, metrics)}
      /* Tailwind's preflight gives `code` the theme's mono stack, which beats
         the family inherited from here — so the font chosen for the terminal
         would be ignored by exactly the elements that show code. */
      className="min-h-0 flex-1 overflow-auto [&_code]:[font-family:inherit]"
    >
      {budget.hunks.map((hunk, index) => (
        <HunkRows
          key={`${hunk.header}:${index}`}
          hunk={hunk}
          highlighted={highlighted}
          line={line}
          wrap={wrap}
          opener={opener}
          sides={sides}
        />
      ))}
      {budget.rows < budget.total && (
        <Notice tone="text-[#d8b165]">
          {`Showing ${budget.rows.toLocaleString()} of ${budget.total.toLocaleString()} rows — narrow the context to see the rest.`}
        </Notice>
      )}
      {diff?.truncated && (
        <Notice tone="text-[#d8b165]">
          Diff cut short — the rest is longer than this panel will read.
        </Notice>
      )}
    </div>
  )
}

interface Sides {
  old: HighlightedLines | null
  new: HighlightedLines | null
  index: { old: Map<DiffLine, number>; new: Map<DiffLine, number> }
}

/**
 * Tokens for both sides of the diff.
 *
 * Each side is highlighted as one document, because a grammar restarted per
 * hunk mis-colours anything that spans lines — a doc comment, a template
 * literal, an unterminated string the agent is halfway through writing.
 */
function useHighlightedSides(
  hunks: Hunk[] | undefined,
  path: string,
): Sides | null {
  const [sides, setSides] = useState<Sides | null>(null)

  useEffect(() => {
    if (!hunks) {
      setSides(null)
      return
    }
    const index = {
      old: sideIndex(hunks, 'old'),
      new: sideIndex(hunks, 'new'),
    }
    // Shown uncoloured first, so a large diff appears immediately and gains
    // its colours when the grammar is ready.
    setSides({ old: null, new: null, index })

    let live = true
    const language = languageFor(path)
    void Promise.all([
      highlight(sideText(hunks, 'old'), language),
      highlight(sideText(hunks, 'new'), language),
    ]).then(([oldSide, newSide]) => {
      if (live) setSides({ old: oldSide, new: newSide, index })
    })
    return () => {
      live = false
    }
  }, [hunks, path])

  return sides
}

interface HunkRowsProps {
  hunk: Hunk
  highlighted: Sides | null
  line: number | null
  wrap: boolean
  opener: LineOpener | null
  sides: { old: boolean; new: boolean }
}

function HunkRows({
  hunk,
  highlighted,
  line,
  wrap,
  opener,
  sides,
}: HunkRowsProps) {
  return (
    <>
      <div className="sticky top-0 flex gap-2 border-y border-line bg-chrome px-2 py-0.5 text-[10px] text-faint">
        <span className="truncate">{hunk.header}</span>
      </div>
      {hunk.lines.map((row, index) => (
        <Row
          key={index}
          row={row}
          tokens={tokensFor(highlighted, row)}
          wanted={line !== null && row.newLine === line}
          wrap={wrap}
          opener={opener}
          sides={sides}
        />
      ))}
    </>
  )
}

function tokensFor(sides: Sides | null, row: DiffLine) {
  if (!sides) return undefined
  const side = row.kind === 'del' ? 'old' : 'new'
  const at = sides.index[side].get(row)
  return at === undefined ? undefined : (sides[side]?.[at] ?? undefined)
}

interface RowProps {
  row: DiffLine
  tokens: ReturnType<typeof tokensFor>
  /** This is the line the terminal click named, so scroll it into view. */
  wanted: boolean
  wrap: boolean
  opener: LineOpener | null
  sides: { old: boolean; new: boolean }
}

function Row({ row, tokens, wanted, wrap, opener, sides }: RowProps) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (wanted) element.current?.scrollIntoView({ block: 'center' })
  }, [wanted])

  return (
    <div
      ref={element}
      className={`flex ${ROW_TONE[row.kind]} ${
        wanted ? 'outline outline-brand' : ''
      }`}
    >
      {/* The old side is never a link: that number names a line in the file as
          it was, which the editor has no way to open. */}
      {sides.old && <Gutter value={row.oldLine} />}
      {sides.new && <Gutter value={row.newLine} opener={opener} />}
      {/* The glyph is decorative; the word is what a screen reader gets, since
          the tint alone carries the meaning otherwise. */}
      {SPOKEN[row.kind] && (
        <span className="sr-only">{`${SPOKEN[row.kind]} `}</span>
      )}
      <span
        aria-hidden="true"
        className="flex-none text-center text-faint select-none"
        style={{ width: '1.5ch' }}
      >
        {MARKER[row.kind]}
      </span>
      <code
        className={`flex-1 pr-1.5 ${
          wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'
        }`}
      >
        <TokenLine tokens={tokens} text={row.text} />
      </code>
    </div>
  )
}

const GUTTER = 'flex-none pr-1.5 text-right tabular-nums select-none'

/** In characters, so the column follows the font rather than a pixel guess. */
const GUTTER_WIDTH = { minWidth: '4ch' }

/**
 * Both line numbers are shown, as every review tool does: a removed line has
 * no number on the new side, and an added one none on the old.
 *
 * A number with an opener is a button that opens the file there, which is the
 * shortest route from reading a change to editing it.
 */
const Gutter = ({
  value,
  opener,
}: {
  value: number | null
  opener?: LineOpener | null
}) =>
  value !== null && opener ? (
    <button
      type="button"
      title={`Open line ${value} in ${opener.editor}`}
      aria-label={`Open line ${value} in ${opener.editor}`}
      onClick={() => opener.open(value)}
      style={GUTTER_WIDTH}
      className={`${GUTTER} cursor-pointer text-faint hover:text-brand hover:underline`}
    >
      {value}
    </button>
  ) : (
    <span style={GUTTER_WIDTH} className={`${GUTTER} text-faint`}>
      {value ?? ''}
    </span>
  )

const Notice = ({
  children,
  tone = 'text-faint',
}: {
  children: ReactNode
  tone?: string
}) => (
  // A status region: these replace each other as reads land, and a change
  // nobody is told about is a change a screen reader never hears.
  <p role="status" className={`m-0 px-2.5 py-3 text-[11px] ${tone}`}>
    {children}
  </p>
)
