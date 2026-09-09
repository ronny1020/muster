import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'

import type { Backend } from './platform'

export interface GitStatus {
  repo: boolean
  branch: string
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicted: number
}

export interface Workspace {
  path: string
  label: string
  exists: boolean
  dirty: boolean
  git: GitStatus
}

export interface Commit {
  sha: string
  short: string
  subject: string
  author: string
  when: string
  refs: string[]
  unpushed: boolean
}

export interface SpawnOptions {
  id: string
  cwd: string
  program: string
  args: string[]
  cols: number
  rows: number
  loginShell: boolean
  backend: Backend
  /** Which WSL distro, when the backend is `wsl`. Empty means the default one. */
  distro: string
}

export function spawnPty(
  options: SpawnOptions,
  onOutput: (bytes: Uint8Array) => void,
) {
  const channel = new Channel<ArrayBuffer | number[]>()
  channel.onmessage = (message) =>
    onOutput(
      message instanceof ArrayBuffer
        ? new Uint8Array(message)
        : new Uint8Array(message),
    )
  return invoke<void>('pty_spawn', { options, onOutput: channel })
}

export const writePty = (id: string, data: string) =>
  invoke<void>('pty_write', { id, data })
export const resizePty = (id: string, cols: number, rows: number) =>
  invoke<void>('pty_resize', { id, cols, rows })
export const killPty = (id: string) => invoke<void>('pty_kill', { id })
/** Live working directory of the session's foreground process, if readable. */
export const ptyCwd = (id: string) => invoke<string | null>('pty_cwd', { id })

export const workspaceInfo = (cwd: string) =>
  invoke<Workspace>('workspace_info', { cwd })
export const homeDir = () => invoke<string>('home_dir')

/**
 * Creates a directory and its missing parents, returning the absolute path.
 * Offered by the launcher when the directory typed is not there yet.
 */
export const createDirectory = (path: string) =>
  invoke<string>('create_directory', { path })

/**
 * How many past sessions an agent has in a directory, or `null` when that
 * agent's session store is not one the backend knows how to read — in which
 * case the mode stays offered rather than being hidden on a guess.
 */
export const agentSessions = (agentId: string, cwd: string) =>
  invoke<number | null>('agent_sessions', { agentId, cwd })

export interface Editor {
  command: string
  name: string
}

/** Editors this machine can launch, in the order a tab should offer them. */
export const editors = () => invoke<Editor[]>('editors')
export const openInEditor = (target: string, command: string, line?: number) =>
  invoke<void>('open_in_editor', { target, command, line })

export interface ImagePreview {
  dataUrl: string
  bytes: number
  path: string
}

/**
 * Reads an image off disk as a `data:` URI. The webview never fetches it
 * itself, which is what keeps the content security policy at `img-src data:`.
 */
export const readImage = (path: string) =>
  invoke<ImagePreview>('read_image', { path })

export interface LinkMeta {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  /** `data:` URI for the page's preview image, if it published one. */
  imageDataUrl: string | null
}

/**
 * Reads a page's Open Graph metadata. The only call in Muster that touches the
 * network, so it runs on an explicit click rather than on hover — terminal
 * output is written by an agent, and a URL it prints must not fetch itself.
 */
export const linkPreview = (url: string) =>
  invoke<LinkMeta>('link_preview', { url })
export const gitLog = (cwd: string, limit: number) =>
  invoke<Commit[]>('git_log', { cwd, limit })

export const onPtyExit = (
  handler: (payload: { id: string; code: number }) => void,
) =>
  listen<{ id: string; code: number }>('pty://exit', (event) =>
    handler(event.payload),
  )

export async function pickDirectory(defaultPath?: string) {
  const picked = await open({
    directory: true,
    multiple: false,
    defaultPath,
    title: 'Choose a working directory',
  })
  return typeof picked === 'string' ? picked : null
}
