import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { absolutePath, basename, folderOf } from '../model/changes'
import { isMarkdownPath } from '../model/markdown'
import { tableDelimiter } from '../model/table'
import type { LineOpener } from '../model/openline'
import type { Viewed } from '../model/viewed'
import { lineSuffix } from '../model/reference'
import { selectedLines } from './selectedLines'
import { CodePreview } from './CodePreview'
import { DiffView } from './DiffView'
import { FileHistory } from './FileHistory'
import { Notice } from './Notice'
import { MarkdownView } from './MarkdownView'
import { TableView } from './TableView'
import { Icon } from '../../../shared/ui/Icon'
import { DragEdge } from '../../../shared/ui/DragEdge'
import { fileIcon } from '../../../shared/ui/fileicon'
import { usePanelWidth } from '../../../shared/lib/usePanelWidth'
import { isImagePath } from '../../../shared/lib/imagepaths'
import { useKeyChange } from '../../../shared/lib/useKeyChange'
import { copyPath } from './copyPath'
import { isPlainPath } from '../../../shared/lib/paste'

export interface FileViewerProps {
  viewed: Viewed
  cwd: string
  /** Branch being compared against, or `''` for uncommitted work. */
  base: string
  /** Changes whenever the tree may have moved, which re-reads the diff. */
  revision: string
  /** Only the tab on screen may answer Escape; every pane stays mounted. */
  active: boolean
  opener: LineOpener | null
  /** A link in a rendered document was clicked. */
  onUrl: (url: string) => void
  /** Show something else in the column — a commit picked from the history. */
  onView: (viewed: Viewed) => void
  /**
   * Types a path into the session, with a `:12-30` suffix when lines are
   * selected. Absent when there is no session to type into.
   */
  onSend?: (path: string, suffix: string) => void
  onClose: () => void
}

/** Wide enough for real source, narrow enough to leave a terminal beside it. */
const DEFAULT_WIDTH = 560

/** How much unchanged code to keep around each hunk, as the header offers it. */
const contextSteps = (t: TFunction<'review'>) => [
  { label: '3', value: 3, title: t('viewer.contextThree') },
  { label: '12', value: 12, title: t('viewer.contextTwelve') },
  {
    label: t('viewer.contextAll'),
    value: 100_000,
    title: t('viewer.contextWhole'),
  },
]

/**
 * One file, read-only: its diff, or its contents.
 *
 * A column of its own rather than an overlay, because reading what an agent
 * changed and typing the next instruction are the same activity — covering the
 * terminal to show a diff would make you close it again to answer. The drawer
 * beside it is a list; this is where anything you actually read goes, since a
 * 300-pixel column wraps or truncates most real source.
 */
export function FileViewer({
  viewed,
  cwd,
  base,
  revision,
  active,
  opener,
  onUrl,
  onView,
  onSend,
  onClose,
}: FileViewerProps) {
  const { t } = useTranslation('review')
  const [wrap, setWrap] = useState(false)
  const [context, setContext] = useState(3)
  /**
   * Markdown and tables open rendered when a file was picked to read, and as
   * a diff when a change was: what you asked to see decides, not the file type.
   */
  const [preview, setPreview] = useState(viewed.kind === 'file')

  // Re-derived per selection, not just at mount: the column is not remounted
  // between files, so the mode from the last one would decide this one's.
  useKeyChange([viewed], () => setPreview(viewed.kind === 'file'))
  /**
   * The file whose history is listed, and what the column showed when the list
   * last chose it. The list stays while you step through its commits — each
   * one under the name the file had then — and goes the moment anything else
   * picks what the column shows, since it would describe another file.
   */
  const [history, setHistory] = useState<{
    of: string
    shown: Viewed
    open: boolean
  } | null>(null)
  const ownsView = history?.shown === viewed
  const historyOf = ownsView && history.open ? history.of : null
  const size = usePanelWidth('muster.viewerWidth', DEFAULT_WIDTH)
  const body = useRef<HTMLDivElement>(null)

  const path = viewed.absolute
  const commit = viewed.kind === 'diff' ? viewed.commit : undefined
  // A commit's line numbers are that commit's, not the file on disk's.
  const editor = commit ? null : opener
  const icon = fileIcon(path)
  // An image has no diff worth reading: what the agent did to it is visible
  // only by looking at it.
  const asDiff = viewed.kind === 'diff' && !isImagePath(path)
  const delimiter = tableDelimiter(path)
  // A commit's version of the file is not on disk, and the renderers read disk.
  const renderable = !commit && (isMarkdownPath(path) || delimiter !== null)
  const rendered = renderable && preview

  /**
   * Escape closes the column — but only in the tab you are looking at.
   *
   * Panes stay mounted for every tab, so mounting only while a file is open
   * narrows this without fixing it: with a file open in two tabs, one Escape
   * closed both, and an Escape typed at a TUI in one tab closed the other's.
   */
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onClose])

  return (
    <section
      style={{ width: size.width, maxWidth: '80%' }}
      // Not `flex-none`: with the drawer open too, the flex row is the only
      // thing left that can keep the terminal on screen.
      className="relative flex flex-col border-l border-line bg-canvas"
    >
      <DragEdge size={size} label={t('viewer.resize')} />

      {/*
        Close must survive a narrow panel, so it sits outside the group that
        clips. Every `Action` is `flex-none`, so without this the row overflowed
        and the last control — the close button — was the first one pushed out
        of sight, leaving Escape the only way back.
      */}
      <header className="flex h-8 flex-none items-center gap-1.5 overflow-hidden border-b border-line bg-chrome px-2">
        <Icon name={icon.name} className={`size-3.5 flex-none ${icon.tone}`} />
        <span className="min-w-0 shrink truncate text-xs text-ink">
          {basename(path)}
        </span>
        {commit && (
          <span
            title={t('history.commitDiff', {
              short: commit.short,
              subject: commit.subject,
            })}
            className="flex-none rounded-sm border border-line bg-surface px-1 font-mono text-[10px] text-muted"
          >
            {commit.short}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
          {folderOf(path)}
        </span>
        <div className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          {renderable && (
            <Action
              label={
                rendered
                  ? viewed.kind === 'diff'
                    ? t('viewer.showDiff')
                    : t('viewer.showSource')
                  : delimiter
                    ? t('viewer.renderTable')
                    : t('viewer.renderMarkdown')
              }
              // The button says where a click goes, not where you already are:
              // reading a rendered document, the useful word is what you would
              // switch back to.
              text={
                rendered
                  ? viewed.kind === 'diff'
                    ? t('viewer.diff')
                    : t('viewer.raw')
                  : t('viewer.preview')
              }
              onClick={() => setPreview((was) => !was)}
            >
              <Icon
                name={
                  rendered
                    ? viewed.kind === 'diff'
                      ? 'difference'
                      : 'code'
                    : delimiter
                      ? 'table'
                      : 'description'
                }
                className="size-3.5"
              />
            </Action>
          )}

          {asDiff && !rendered && (
            <>
              <span className="flex-none text-[10px] text-faint">
                {t('viewer.contextLabel')}
              </span>
              {contextSteps(t).map((step) => (
                <button
                  key={step.value}
                  type="button"
                  title={step.title}
                  aria-label={step.title}
                  aria-pressed={context === step.value}
                  onClick={() => setContext(step.value)}
                  className={`h-5 flex-none rounded-sm px-1 text-[11px] ${
                    context === step.value
                      ? 'bg-surface text-ink'
                      : 'text-muted hover:bg-surface-hover hover:text-ink'
                  }`}
                >
                  {step.label}
                </button>
              ))}
            </>
          )}

          {!rendered && (
            <Action
              label={wrap ? t('viewer.unwrapLines') : t('viewer.wrapLines')}
              text={t('viewer.wrap')}
              active={wrap}
              onClick={() => setWrap((was) => !was)}
            >
              <Icon name="wrap_text" className="size-3.5" />
            </Action>
          )}
          {onSend && !commit && isPlainPath(path) && (
            <Action
              label={t('viewer.send')}
              // Keeps the text selection, which is the lines it sends.
              keepSelection
              onClick={() =>
                onSend(
                  path,
                  lineSuffix(body.current ? selectedLines(body.current) : []),
                )
              }
            >
              <Icon name="send" className="size-3.5" />
            </Action>
          )}
          <Action
            label={historyOf ? t('history.hide') : t('history.show')}
            active={historyOf !== null}
            // Hidden and shown again, the list keeps the file it was opened
            // for: a commit's path is the name the file had then.
            onClick={() =>
              setHistory(
                ownsView
                  ? { ...history, open: !history.open }
                  : { of: path, shown: viewed, open: true },
              )
            }
          >
            <Icon name="history" className="size-3.5" />
          </Action>
          {!commit && isPlainPath(path) && (
            <Action
              label={t('viewer.copyPath')}
              onClick={() => void copyPath(path)}
            >
              <Icon name="content_copy" className="size-3.5" />
            </Action>
          )}
          {editor && (
            <Action
              label={t('viewer.openIn', { editor: editor.editor })}
              onClick={() => editor.open(viewed.line ?? 1)}
            >
              <Icon name="open_in_new" className="size-3.5" />
            </Action>
          )}
        </div>
        <Action label={t('viewer.close')} onClick={onClose}>
          <Icon name="close" className="size-3.5" />
        </Action>
      </header>

      {historyOf && (
        <FileHistory
          cwd={cwd}
          path={historyOf}
          revision={revision}
          selected={commit?.sha ?? null}
          onPick={(entry, root) => {
            const shown: Viewed = {
              kind: 'diff',
              relative: entry.path,
              absolute: absolutePath(root, entry.path),
              line: null,
              commit: entry,
              oldPath: entry.oldPath ?? undefined,
              root,
            }
            setHistory({ of: historyOf, shown, open: true })
            onView(shown)
          }}
        />
      )}

      <div ref={body} className="flex min-h-0 flex-1 flex-col">
        {rendered && delimiter ? (
          <TableView path={path} delimiter={delimiter} revision={revision} />
        ) : rendered ? (
          <MarkdownView path={path} revision={revision} onUrl={onUrl} />
        ) : asDiff && viewed.kind === 'diff' ? (
          <DiffView
            cwd={(commit && viewed.root) || cwd}
            path={viewed.relative}
            base={base}
            commit={commit?.sha}
            oldPath={viewed.oldPath}
            context={context}
            revision={revision}
            line={viewed.line}
            wrap={wrap}
            opener={editor}
          />
        ) : commit ? (
          // Only an image reaches here, and the preview reads today's.
          <Notice>{t('commit.imageNotShown')}</Notice>
        ) : (
          <CodePreview
            path={path}
            wrap={wrap}
            revision={revision}
            opener={editor}
            cwd={cwd}
            base={base}
          />
        )}
      </div>
    </section>
  )
}

interface ActionProps {
  label: string
  /** Shown beside the icon. Worth it for a control nobody would go looking for. */
  text?: string
  active?: boolean
  /** Pressing it leaves the text selection alone. */
  keepSelection?: boolean
  onClick: () => void
  children: ReactNode
}

const Action = ({
  label,
  text,
  active,
  keepSelection,
  onClick,
  children,
}: ActionProps) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
    onMouseDown={keepSelection ? (event) => event.preventDefault() : undefined}
    onClick={onClick}
    className={`flex h-5 flex-none items-center gap-1 rounded-sm text-[11px] ${
      text ? 'px-1.5' : 'w-5 justify-center'
    } ${
      active
        ? 'bg-surface text-ink'
        : 'text-muted hover:bg-surface-hover hover:text-ink'
    }`}
  >
    {children}
    {text}
  </button>
)
