import { useCallback, useEffect, useRef, useState } from 'react'

import { type DeckAction, type Tab, tabSession } from '../deck'
import { useSettings } from '../hooks/useSettings'
import { preferredEditor, useEditors } from '../hooks/useEditors'
import { useHomeDir } from '../hooks/useHomeDir'
import { useWorkspace } from '../hooks/useWorkspace'
import {
  type ImagePreview as Image,
  type LinkMeta,
  linkPreview,
  openInEditor,
  readImage,
} from '../ipc'
import { decideBellResponse, notify } from '../notify'
import { isImagePath } from '../termlinks'
import { ImagePreview } from './ImagePreview'
import { LinkCard } from './LinkCard'
import { HistoryPanel } from './HistoryPanel'
import { Launcher, type LaunchRequest } from './Launcher'
import { SessionEnded } from './SessionEnded'
import { SettingsPane } from './SettingsPane'
import { StatusBar } from './StatusBar'
import { TerminalView } from './TerminalView'

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
  const { cwd, workspace, tracked } = useWorkspace(
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
  const onPath = useCallback((path: string, line?: number) => {
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
        <Launcher active={active} onLaunch={onLaunch} />
      )}

      {session && (
        <>
          <div className="flex min-h-0 flex-1">
            <TerminalView
              sessionId={tab.id}
              session={session}
              active={active}
              onBell={onBell}
              cwd={cwd}
              home={home}
              onPath={onPath}
              onUrl={onUrl}
            />
            {historyOpen && git && (
              <HistoryPanel
                cwd={cwd}
                branch={git.branch}
                limit={settings.historyLimit}
                revision={`${cwd}:${git.branch}:${git.ahead}:${git.staged}:${git.modified}`}
                onClose={toggleHistory}
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
            editor={editor}
            onToggleHistory={toggleHistory}
          />
        </>
      )}
    </section>
  )
}
