import { useCallback, useEffect, useRef, useState } from 'react'

import {
  type DeckAction,
  type ReviewView,
  type Tab,
  tabSession,
} from '../../../entities/tab/model/deck'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { preferredEditor, useEditors } from '../../../shared/lib/useEditors'
import { useHomeDir } from '../model/useHomeDir'
import { useWorkspace } from '../../../features/workspace/model/useWorkspace'
import { treeRevision } from '../../../features/workspace/model/status'
import { revealItemInDir } from '@tauri-apps/plugin-opener'

import {
  dropPaths,
  gitChanges,
  type ImagePreview as Image,
  type LinkMeta,
  linkPreview,
  openInEditor,
  pathKind,
  readImage,
  report,
} from '../../../shared/ipc'
import {
  absolutePath,
  matchChanged,
} from '../../../features/review/model/changes'
import { lineOpener } from '../../../features/review/model/openline'
import type { Viewed } from '../../../features/review/model/viewed'
import { FileViewer } from '../../../features/review/ui/FileViewer'
import { ReviewPanel } from '../../../features/review/ui/ReviewPanel'
import { decideBellResponse, notify } from '../../../shared/lib/notify'
import { isImagePath } from '../../../shared/lib/imagepaths'
import { ImagePreview } from '../../../features/terminal/ui/ImagePreview'
import { LinkCard } from '../../../features/terminal/ui/LinkCard'
import { HistoryPanel } from '../../../features/workspace/ui/HistoryPanel'
import {
  Launcher,
  type LaunchRequest,
} from '../../../features/launch/ui/Launcher'
import { SessionEnded } from '../../../features/terminal/ui/SessionEnded'
import { SettingsPane } from '../../../features/settings/ui/SettingsPane'
import { StatusBar } from '../../../features/workspace/ui/StatusBar'
import { TerminalView } from '../../../features/terminal/ui/TerminalView'

interface LinkState {
  url: string | null
  meta: LinkMeta | null
  error: string | null
}

interface ImagePreviewState {
  image: Image | null
  error: string | null
}

export interface PaneProps {
  tab: Tab
  active: boolean
  onLaunch(request: LaunchRequest): void
  dispatch(action: DeckAction): void
}

/**
 * One tab's content. All panes stay mounted — hidden ones keep their PTY and
 * scrollback alive so switching tabs is instant.
 */
export function Pane({ tab, active, onLaunch, dispatch }: PaneProps) {
  const { settings } = useSettings()
  const session = tabSession(tab)
  const { cwd, workspace, tracked, refresh } = useWorkspace(
    session && tab.id,
    session?.cwd ?? null,
    settings.gitPollSeconds,
  )

  const editor = preferredEditor(useEditors(), settings.editorCommand)
  // Read through a ref: onPath is built once, the editor arrives asynchronously.
  const editorRef = useRef(editor)
  editorRef.current = editor
  const git = workspace?.git
  const historyOpen = tab.historyOpen && Boolean(git?.repo)
  const toggleHistory = () => dispatch({ type: 'toggleHistory', id: tab.id })
  const closeFind = useCallback(
    () => dispatch({ type: 'setFind', id: tab.id, open: false }),
    [dispatch, tab.id],
  )

  const reviewOpen = tab.reviewOpen
  const toggleReview = () => dispatch({ type: 'toggleReview', id: tab.id })
  /** A control naming a view: open it, switch to it, or close it. */
  const showReview = (view: ReviewView) =>
    dispatch({ type: 'showReview', id: tab.id, view })
  /**
   * What the content column is showing.
   *
   * Held here rather than in the drawer because the column is the drawer's
   * sibling, not its child: a file needs width the drawer does not have, and
   * covering the terminal to show one would defeat the point of reading it
   * next to the agent that wrote it.
   */
  const [viewed, setViewed] = useState<Viewed | null>(null)
  /** Which branch the drawer and the column compare against. */
  const [base, setBase] = useState('')
  /** Changes when the working tree does, which is what re-reads git. */
  const revision = treeRevision(cwd, git ?? null)

  // A session that `cd`s elsewhere is looking at another tree: a file from the
  // last one, and a base branch that may not exist in this one, are both stale
  // rather than merely old.
  useEffect(() => {
    setViewed(null)
    setBase('')
  }, [cwd])
  // Filled in by the terminal once it exists, so the panel and a file drop
  // can both put text in front of the agent.
  const paste = useRef<((text: string) => void) | null>(null)

  const home = useHomeDir()
  const [preview, setPreview] = useState<ImagePreviewState>({
    image: null,
    error: null,
  })

  /**
   * A path clicked in the output: an image opens in the overlay, anything else
   * goes to the editor. A directory counts as "anything else" — editors open
   * those happily.
   */
  const openFile = useCallback((path: string, line?: number) => {
    if (isImagePath(path)) {
      void readImage(path)
        .then((image) => setPreview({ image, error: null }))
        .catch((error) => setPreview({ image: null, error: String(error) }))
      return
    }
    if (!editorRef.current) {
      setPreview({ image: null, error: 'No editor found on your PATH.' })
      return
    }
    void openInEditor(path, editorRef.current.command, line).catch((error) =>
      setPreview({ image: null, error: String(error) }),
    )
  }, [])

  /**
   * A path clicked in the output.
   *
   * A file the agent has just changed opens in the review panel, because the
   * diff is what the user is looking for at that moment — the surrounding
   * output is the agent saying it edited that file. Everything else keeps the
   * behaviour it had: a folder is revealed, a file opens in the editor.
   *
   * git is asked per click rather than polled: the answer is only needed when
   * a path is clicked, and a poll here would run in every mounted pane.
   */
  const onPath = useCallback(
    (path: string, line?: number) => {
      void changedFile(cwdRef.current, path, baseRef.current).then(
        (changed) => {
          if (changed) {
            setViewed({ kind: 'diff', ...changed, line: line ?? null })
            // Named, not just opened: the drawer keeps whichever view it was
            // last on, and the file tree is not what you asked for by
            // clicking a changed path.
            dispatch({ type: 'setReviewView', id: tab.id, view: 'changes' })
            dispatch({ type: 'setReview', id: tab.id, open: true })
            return
          }
          // A folder belongs in the file manager, not an editor — and only the
          // filesystem can say which one a path is.
          void pathKind(path).then(
            (kind) => {
              if (kind === 'directory') {
                void revealItemInDir(path).catch(report)
                return
              }
              openFile(path, line)
            },
            () => openFile(path, line),
          )
        },
      )
    },
    [dispatch, openFile, tab.id],
  )

  /** Read through refs: `onPath` is built once, these move under it. */
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const baseRef = useRef(base)
  baseRef.current = base

  /** Puts a path in front of the agent, quoted as a drop would be. */
  const sendPath = useCallback(
    (path: string) => {
      const backend = session?.backend
      if (!backend) return
      void dropPaths([path], backend)
        .then((text) => paste.current?.(text))
        .catch(report)
    },
    [session?.backend],
  )

  const [link, setLink] = useState<LinkState>({
    url: null,
    meta: null,
    error: null,
  })

  /** A URL clicked in the output: read its metadata, then show the card. */
  const onUrl = useCallback((url: string) => {
    setLink({ url, meta: null, error: null })
    void linkPreview(url)
      .then((meta) => setLink({ url, meta, error: null }))
      .catch((error) => setLink({ url, meta: null, error: String(error) }))
  }, [])

  const notifiedAt = useRef<number | null>(null)
  /**
   * Agents ring the terminal bell when they finish a turn and hand control
   * back, which is the one moment worth interrupting the user for.
   */
  const onBell = useCallback(() => {
    const { attention, notify: shouldNotify } = decideBellResponse({
      enabled: settings.notifyOnDone,
      onlyWhenUnfocused: settings.notifyOnlyWhenUnfocused,
      tabActive: active,
      windowFocused: document.hasFocus(),
      lastNotifiedAt: notifiedAt.current,
      now: Date.now(),
    })

    if (attention) dispatch({ type: 'attention', id: tab.id })
    if (!shouldNotify) return
    notifiedAt.current = Date.now()
    void notify(
      `${session?.agentName ?? 'Session'} · ${tab.title}`,
      'Waiting for you.',
      settings.notifySound,
    )
  }, [
    active,
    dispatch,
    session?.agentName,
    settings.notifyOnDone,
    settings.notifyOnlyWhenUnfocused,
    settings.notifySound,
    tab.id,
    tab.title,
  ])

  useEffect(() => {
    if (!workspace) return
    dispatch({
      type: 'workspace',
      id: tab.id,
      label: workspace.label,
      branch: workspace.git.repo ? workspace.git.branch : '',
      dirty: workspace.dirty,
    })
  }, [workspace, tab.id, dispatch])

  return (
    <section
      className={`absolute inset-0 flex-col ${active ? 'flex' : 'hidden'}`}
    >
      {tab.content.type === 'settings' && <SettingsPane />}
      {tab.content.type === 'launcher' && (
        <Launcher
          active={active}
          onLaunch={onLaunch}
          start={
            tab.content.type === 'launcher' ? tab.content.start : undefined
          }
        />
      )}

      {session && (
        <>
          <div className="flex min-h-0 flex-1">
            {/* The floor is here rather than on the terminal because this is
                the flex child: the drawers can be dragged wider than the
                window, and a terminal fitted to zero columns is not one. */}
            <div className="relative flex min-h-0 min-w-64 flex-1">
              <TerminalView
                sessionId={tab.id}
                session={session}
                active={active}
                onBell={onBell}
                cwd={cwd}
                home={home}
                onPath={onPath}
                onUrl={onUrl}
                findOpen={tab.findOpen}
                onCloseFind={closeFind}
                paste={paste}
              />
            </div>
            {viewed && (
              <FileViewer
                viewed={viewed}
                cwd={cwd}
                base={base}
                revision={revision}
                active={active}
                opener={lineOpener(editor, viewed.absolute)}
                onUrl={onUrl}
                onClose={() => setViewed(null)}
              />
            )}
            {reviewOpen && (
              <ReviewPanel
                cwd={cwd}
                revision={revision}
                base={base}
                onBase={setBase}
                view={tab.reviewView}
                onView={(view) =>
                  dispatch({ type: 'setReviewView', id: tab.id, view })
                }
                viewed={viewed}
                onOpenDiff={(file, root) =>
                  setViewed({
                    kind: 'diff',
                    relative: file.path,
                    absolute: absolutePath(root, file.path),
                    line: null,
                  })
                }
                onOpenFile={(path) =>
                  setViewed({ kind: 'file', absolute: path })
                }
                onSend={sendPath}
                onClose={toggleReview}
              />
            )}
            {historyOpen && git && (
              <HistoryPanel
                cwd={cwd}
                git={git}
                limit={settings.historyLimit}
                revision={revision}
                onClose={toggleHistory}
                onSwitched={refresh}
              />
            )}
          </div>
          <LinkCard
            url={link.url}
            meta={link.meta}
            error={link.error}
            onClose={() => setLink({ url: null, meta: null, error: null })}
          />
          <ImagePreview
            preview={preview.image}
            error={preview.error}
            onClose={() => setPreview({ image: null, error: null })}
          />
          {tab.exitCode !== null && (
            <SessionEnded
              code={tab.exitCode}
              agentName={session.agentName}
              onRelaunch={() => dispatch({ type: 'relaunch', id: tab.id })}
            />
          )}
          <StatusBar
            cwd={cwd}
            workspace={workspace}
            tracked={tracked}
            agentName={session.agentName}
            state={tab.exitCode === null ? '' : tab.detail}
            exited={tab.exitCode !== null && tab.exitCode !== 0}
            historyOpen={historyOpen}
            reviewOpen={reviewOpen}
            editor={editor}
            reviewView={tab.reviewView}
            onToggleHistory={toggleHistory}
            onShowReview={showReview}
            // Toggles, like the branch button beside it and the review
            // groups: every control in the bar names a surface, and a second
            // click on the one you are looking at closes it.
            onShowHistory={toggleHistory}
          />
        </>
      )}
    </section>
  )
}

/**
 * The repo-relative path of a changed file an absolute path names, or `null`.
 *
 * Asked of git at click time. The panel's own list is not consulted because it
 * only exists while the panel is open, and the first click is usually what
 * opens it.
 */
async function changedFile(
  cwd: string,
  path: string,
  base: string,
): Promise<{ relative: string; absolute: string } | null> {
  // The same base the drawer is listing against, or a path changed in an
  // earlier commit on this branch would match nothing and open in the editor
  // while the drawer shows it as a change.
  // No counts: this asks only whether the path is in the list — see `gitChanges`.
  const changes = await gitChanges(cwd, base || undefined, false).catch(
    () => null,
  )
  if (!changes?.repo) return null
  const found = matchChanged(changes.files, path, changes.root)
  return found
    ? {
        relative: found.path,
        // Rebuilt from the root rather than reusing the clicked path: the two
        // can differ in case or separators, and the editor gets this one.
        absolute: absolutePath(changes.root, found.path),
      }
    : null
}
