import { type ReactNode, useEffect, useState } from 'react'

import {
  type HighlightedLines,
  highlight,
  languageFor,
} from '../model/highlight'
import { codeStyle } from '../model/codestyle'
import { useTextFile } from '../model/useTextFile'
import type { LineOpener } from '../model/openline'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { useFontMetrics } from '../../../shared/lib/fontmetrics'
import { TokenLine } from './TokenLine'
import { type ImagePreview, readImage } from '../../../shared/ipc'
import { formatBytes } from '../../../shared/lib/bytes'
import { isImagePath } from '../../../shared/lib/imagepaths'

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
}: CodePreviewProps) {
  if (!path) return <Notice>Pick a file to read it here.</Notice>
  return isImagePath(path) ? (
    <ImageBody key={path} path={path} />
  ) : (
    <TextBody
      key={path}
      path={path}
      wrap={wrap}
      revision={revision}
      opener={opener}
    />
  )
}

interface TextBodyProps {
  path: string
  wrap: boolean
  revision: string
  opener: LineOpener | null
}

function TextBody({ path, wrap, revision, opener }: TextBodyProps) {
  const { settings } = useSettings()
  const metrics = useFontMetrics(settings.fontFamily, settings.fontSize)
  const { file, error } = useTextFile(path, revision)
  const [tokens, setTokens] = useState<HighlightedLines | null>(null)

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
  if (!file) return <Notice>Reading…</Notice>

  const lines = file.text.split('\n')
  const rows = lines.slice(0, MAX_ROWS)

  return (
    <div
      style={codeStyle(settings, metrics)}
      /* Tailwind's preflight gives `code` the theme's mono stack, which beats
         the family inherited from here — so the font chosen for the terminal
         would be ignored by exactly the elements that show code. */
      className="min-h-0 flex-1 overflow-auto [&_code]:[font-family:inherit]"
    >
      {rows.map((text, index) => (
        <div key={index} className="flex">
          <Gutter line={index + 1} opener={opener} />
          <code
            className={`flex-1 pr-1.5 ${
              wrap ? 'break-words whitespace-pre-wrap' : 'whitespace-pre'
            }`}
          >
            <TokenLine tokens={tokens?.[index]} text={text} />
          </code>
        </div>
      ))}
      {lines.length > rows.length && (
        <Notice tone="text-[#d8b165]">
          {`Showing the first ${MAX_ROWS.toLocaleString()} of ${lines.length.toLocaleString()} lines.`}
        </Notice>
      )}
      {file.truncated && (
        <Notice tone="text-[#d8b165]">
          Only the first part of this file is shown; it is larger than the
          preview will read.
        </Notice>
      )}
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
  if (!image) return <Notice>Reading…</Notice>

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        {/* Checkered ground, so a transparent PNG is not invisible against a
            dark panel — which is most icons and every logo. */}
        <div className="bg-[repeating-conic-gradient(#2a2a30_0%_25%,#1d1d21_0%_50%)] bg-[length:16px_16px] p-1">
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

const GUTTER = 'flex-none pr-2 text-right tabular-nums select-none'

/** In characters, so the column follows the font rather than a pixel guess. */
const GUTTER_WIDTH = { minWidth: '4ch' }

/** The line number, and a way into the editor at it when there is one. */
const Gutter = ({
  line,
  opener,
}: {
  line: number
  opener: LineOpener | null
}) =>
  opener ? (
    <button
      type="button"
      title={`Open line ${line} in ${opener.editor}`}
      aria-label={`Open line ${line} in ${opener.editor}`}
      onClick={() => opener.open(line)}
      style={GUTTER_WIDTH}
      className={`${GUTTER} cursor-pointer text-faint hover:text-brand hover:underline`}
    >
      {line}
    </button>
  ) : (
    <span style={GUTTER_WIDTH} className={`${GUTTER} text-faint`}>
      {line}
    </span>
  )

const Notice = ({
  children,
  tone = 'text-faint',
}: {
  children: ReactNode
  tone?: string
}) => (
  // A status region: these replace each other as reads land.
  <p role="status" className={`m-0 px-2.5 py-3 text-[11px] ${tone}`}>
    {children}
  </p>
)
