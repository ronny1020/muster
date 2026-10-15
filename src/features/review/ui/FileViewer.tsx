import { type ReactNode, useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { basename, folderOf } from '../model/changes'
import { isMarkdownPath } from '../model/markdown'
import type { LineOpener } from '../model/openline'
import type { Viewed } from '../model/viewed'
import { CodePreview } from './CodePreview'
import { DiffView } from './DiffView'
import { MarkdownView } from './MarkdownView'
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
  onClose,
}: FileViewerProps) {
  const { t } = useTranslation('review')
  const [wrap, setWrap] = useState(false)
  const [context, setContext] = useState(3)
  /**
   * Markdown opens rendered when a file was picked to read, and as its diff
   * when a change was: what you asked to see decides, not the file type.
   */
  const [preview, setPreview] = useState(viewed.kind === 'file')

  // Re-derived per selection, not just at mount: the column is not remounted
  // between files, so the mode from the last one would decide this one's.
  useKeyChange([viewed], () => setPreview(viewed.kind === 'file'))
  const size = usePanelWidth('muster.viewerWidth', DEFAULT_WIDTH)

  const path = viewed.absolute
  const icon = fileIcon(path)
  // An image has no diff worth reading: what the agent did to it is visible
  // only by looking at it.
  const asDiff = viewed.kind === 'diff' && !isImagePath(path)
  const markdown = isMarkdownPath(path)
  const rendered = markdown && preview

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
        <span className="min-w-0 flex-1 truncate text-[10px] text-faint">
          {folderOf(path)}
        </span>
        <div className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden">
          {markdown && (
            <Action
              label={
                rendered
                  ? viewed.kind === 'diff'
                    ? t('viewer.showDiff')
                    : t('viewer.showSource')
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
          {isPlainPath(path) && (
            <Action
              label={t('viewer.copyPath')}
              onClick={() => void copyPath(path)}
            >
              <Icon name="content_copy" className="size-3.5" />
            </Action>
          )}
          {opener && (
            <Action
              label={t('viewer.openIn', { editor: opener.editor })}
              onClick={() => opener.open(viewed.line ?? 1)}
            >
              <Icon name="open_in_new" className="size-3.5" />
            </Action>
          )}
        </div>
        <Action label={t('viewer.close')} onClick={onClose}>
          <Icon name="close" className="size-3.5" />
        </Action>
      </header>

      {rendered ? (
        <MarkdownView path={path} revision={revision} onUrl={onUrl} />
      ) : asDiff && viewed.kind === 'diff' ? (
        <DiffView
          cwd={cwd}
          path={viewed.relative}
          base={base}
          context={context}
          revision={revision}
          line={viewed.line}
          wrap={wrap}
          opener={opener}
        />
      ) : (
        <CodePreview
          path={path}
          wrap={wrap}
          revision={revision}
          opener={opener}
          cwd={cwd}
          base={base}
        />
      )}
    </section>
  )
}

interface ActionProps {
  label: string
  /** Shown beside the icon. Worth it for a control nobody would go looking for. */
  text?: string
  active?: boolean
  onClick: () => void
  children: ReactNode
}

const Action = ({ label, text, active, onClick, children }: ActionProps) => (
  <button
    type="button"
    title={label}
    aria-label={label}
    aria-pressed={active}
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
