import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import {
  type HighlightedLines,
  highlight,
  languageFor,
} from '../model/highlight'
import { relativeTo } from '../model/changes'
import { changedLines } from '../model/diff'
import { codeStyle } from '../model/codestyle'
import { useFileDiff } from '../model/useFileDiff'
import { useTextFile } from '../model/useTextFile'
import type { LineOpener } from '../model/openline'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { useFontMetrics } from '../../../shared/lib/fontmetrics'
import { ChangeRuler } from './ChangeRuler'
import { TokenLine } from './TokenLine'
import { type ImagePreview, readImage } from '../../../shared/ipc'
import { formatBytes } from '../../../shared/lib/bytes'
import { isImagePath } from '../../../shared/lib/imagepaths'
import { currentLocale } from '../../../shared/i18n/i18n'
import { Notice } from './Notice'

/**
 * Rows drawn at once. The backend caps a read at two megabytes, which is some
 * fifty thousand lines and a quarter of a million DOM nodes — enough to lock
 * the window for seconds when someone clicks a log or a minified bundle.
 */
const MAX_ROWS = 5000

export interface CodePreviewProps {
  /** Absolute path of the file to show, or `null` for nothing selected. */
  path: string | null
  wrap: boolean
  /** Changes when the tree may have moved, which re-reads the file. */
  revision: string
  /** Set when an editor was found, which is what makes the gutter clickable. */
  opener: LineOpener | null
  /**
   * The repository and the revision to compare against, for the change marks.
   * Left out — reading a file from outside a working tree — the file is shown
   * with no marks rather than with wrong ones.
   */
  cwd?: string
  base?: string
}

/**
 * A file, read-only: shown as a picture if it is one, otherwise as
 * syntax-highlighted text.
 *
 * Read-only is the design rather than a limitation. The agent in the tab beside
 * it is what edits files, and a second editable copy of a file being rewritten
 * underneath you is a merge conflict waiting to happen. Editing stays one click
 * away in the real editor.
 *
 * The two bodies are separate components, keyed on the path, so switching files
 * starts each read from nothing instead of showing the last file's contents
 * under the new file's name.
 */
export function CodePreview({
  path,
  wrap,
  revision,
  opener,
  cwd,
  base,
}: CodePreviewProps) {
  const { t } = useTranslation('review')
  if (!path) return <Notice>{t('code.pick')}</Notice>
  return isImagePath(path) ? (
    <ImageBody key={path} path={path} />
  ) : (
    <TextBody
      key={path}
      path={path}
      wrap={wrap}
      revision={revision}
      opener={opener}
      cwd={cwd}
      base={base}
    />
  )
}

interface TextBodyProps {
  path: string
  wrap: boolean
  revision: string
  opener: LineOpener | null
  cwd?: string
  base?: string
}

function TextBody({ path, wrap, revision, opener, cwd, base }: TextBodyProps) {
  const { t } = useTranslation('review')
  const { settings } = useSettings()
  const metrics = useFontMetrics(settings.fontFamily, settings.fontSize)
  const { file, error } = useTextFile(path, revision)
  const [tokens, setTokens] = useState<HighlightedLines | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  // Reading a file says nothing about what changed in it, so the same patch
  // the diff view reads is what puts the marks in the gutter.
  //
  // The pathspec has to be repo-relative: an absolute one matches no tracked
  // file, the whole file comes back as added, and every line was then marked
  // changed. A path outside the tree relativises to null, which gives the same
  // no marks as a missing `cwd`. No context either — the line numbers are all
  // this needs, and a wide one is rows of unchanged file for git to write and
  // for this to parse.
  const { diff } = useFileDiff({
    cwd: cwd ?? '',
    path: cwd ? relativeTo(path, cwd) : null,
    base: base ?? '',
    context: 0,
    revision,
  })
  const changed = useMemo(
    () => (diff ? changedLines(diff.patch) : new Set<number>()),
    [diff],
  )

  useEffect(() => {
    if (!file) return
    let live = true
    // Shown plain first: a long file should appear at once and gain its
    // colours a moment later.
    void highlight(file.text, languageFor(file.path)).then((lines) => {
      if (live) setTokens(lines)
    })
    return () => {
      live = false
    }
  }, [file])

  if (error) return <Notice tone="text-danger">{error}</Notice>
  if (!file) return <Notice>{t('code.reading')}</Notice>

  const lines = file.text.split('\n')
  const rows = lines.slice(0, MAX_ROWS)

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChangeRuler host={scroller} revision={`${revision}:${wrap}`} />
      <div
        ref={setScroller}
        style={codeStyle(settings, metrics)}
        /* Tailwind's preflight gives `code` the theme's mono stack, which beats
           the family inherited from here — so the font chosen for the terminal
           would be ignored by exactly the elements that show code. */
        className="min-h-0 flex-1 overflow-auto select-text [&_code]:font-[inherit]"
      >
        {rows.map((text, index) => (
          <div
            key={index}
            // The bar an editor draws beside a changed line, and what
            // `ChangeRuler` measures — one attribute serves both.
            data-change={changed.has(index + 1) ? 'add' : undefined}
            // Which line of the file this row is, for a selection sent to the
            // session.
            data-line={index + 1}
            className={`flex ${
              changed.has(index + 1)
                ? 'border-l-2 border-l-[#3f6f4a]'
                : 'border-l-2 border-l-transparent'
            }`}
          >
            <Gutter line={index + 1} opener={opener} t={t} />
            <code
              className={`min-w-0 flex-1 pr-1.5 ${
                wrap ? 'wrap-anywhere whitespace-pre-wrap' : 'whitespace-pre'
              }`}
            >
              <TokenLine tokens={tokens?.[index]} text={text} />
            </code>
          </div>
        ))}
        {lines.length > rows.length && (
          <Notice tone="text-[#d8b165]">
            {t('code.linesCapped', {
              shown: MAX_ROWS.toLocaleString(currentLocale()),
              total: lines.length.toLocaleString(currentLocale()),
            })}
          </Notice>
        )}
        {file.truncated && (
          <Notice tone="text-[#d8b165]">{t('code.truncated')}</Notice>
        )}
      </div>
    </div>
  )
}

/**
 * An image, as a `data:` URI read through Rust.
 *
 * The webview never fetches it: the policy allows `data:` images and little
 * else, which is also what stops a repository's `diagram.svg` reaching the
 * network on the strength of its name.
 */
function ImageBody({ path }: { path: string }) {
  const { t } = useTranslation('review')
  const [image, setImage] = useState<ImagePreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void readImage(path).then(
      (image) => live && setImage(image),
      (error: unknown) => live && setError(String(error)),
    )
    return () => {
      live = false
    }
  }, [path])

  if (error) return <Notice tone="text-danger">{error}</Notice>
  if (!image) return <Notice>{t('code.reading')}</Notice>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        {/* Checkered ground, so a transparent PNG is not invisible against a
            dark panel — which is most icons and every logo. */}
        <div className="bg-[repeating-conic-gradient(#2a2a30_0%_25%,#1d1d21_0%_50%)] bg-size-[16px_16px] p-1">
          <img
            src={image.dataUrl}
            alt={path}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      </div>
      <p className="m-0 flex-none border-t border-line px-2.5 py-1 text-[10px] text-faint">
        {formatBytes(image.bytes)}
      </p>
    </div>
  )
}

const GUTTER = 'flex-none self-start pr-2 text-right tabular-nums select-none'

/** In characters, so the column follows the font rather than a pixel guess. */
const GUTTER_WIDTH = { minWidth: '4ch' }

/** The line number, and a way into the editor at it when there is one. */
const Gutter = ({
  line,
  opener,
  t,
}: {
  line: number
  opener: LineOpener | null
  t: TFunction<'review'>
}) =>
  opener ? (
    <button
      type="button"
      title={t('code.openLine', { line, editor: opener.editor })}
      aria-label={t('code.openLine', { line, editor: opener.editor })}
      onClick={() => opener.open(line)}
      style={GUTTER_WIDTH}
      className={`${GUTTER} cursor-pointer text-faint hover:text-primary hover:underline`}
    >
      {line}
    </button>
  ) : (
    <span style={GUTTER_WIDTH} className={`${GUTTER} text-faint`}>
      {line}
    </span>
  )
