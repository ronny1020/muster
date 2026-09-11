import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'

import type { Backend } from './lib/platform'

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

export type PathKind = 'directory' | 'file' | 'missing'

/** Whether a clicked path is a folder to reveal or a file to open. */
export const pathKind = (path: string) =>
  invoke<PathKind>('path_kind', { path })

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
/**
 * `within` confines the read to that directory, resolved through any symlinks.
 * A caller that renders a file's own references passes it; one acting on a
 * path the user named does not.
 */
export const readImage = (path: string, within?: string) =>
  invoke<ImagePreview>('read_image', { path, within: within ?? null })

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
export interface Branch {
  /** What a checkout would switch to; for a remote branch, the local name. */
  name: string
  current: boolean
  upstream: string | null
  when: string
  /** Only a remote has it, so checking out starts a local branch from it. */
  remote: boolean
}

export const gitBranches = (cwd: string) =>
  invoke<Branch[]>('git_branches', { cwd })

/** Rejects with git's own message, which names the files in the way. */
export const gitCheckout = (cwd: string, branch: string) =>
  invoke<void>('git_checkout', { cwd, branch })

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

/** Picks a background image, or `null` when the dialog is dismissed. */
export async function pickImage() {
  const picked = await open({
    multiple: false,
    title: 'Choose a background image',
    // Matches the extensions the Rust side is willing to read.
    filters: [
      {
        name: 'Images',
        extensions: [
          'png',
          'jpg',
          'jpeg',
          'gif',
          'webp',
          'bmp',
          'avif',
          'svg',
          'ico',
        ],
      },
    ],
  })
  return typeof picked === 'string' ? picked : null
}

/**
 * Reports a failed hand-off to the OS — revealing a file, opening an editor or
 * a URL.
 *
 * These have no error surface in the chrome they are triggered from, and an
 * unhandled rejection is worse than a quiet one: in development it throws a
 * full-window overlay over an app that is otherwise working.
 */
export const report = (error: unknown) => {
  console.error(error)
}

/** How a file differs from the base the review panel is comparing against. */
export type ChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'conflicted'
  | 'typechange'
  | 'untracked'

export interface ChangedFile {
  /** Repo-relative, in git's own forward-slash form on every host. */
  path: string
  status: ChangeStatus
  /** Where a rename came from; `null` for every other status. */
  oldPath: string | null
  insertions: number
  deletions: number
  binary: boolean
  /** False when the file was listed but never read for a line count. */
  counted: boolean
}

export interface Changes {
  repo: boolean
  /**
   * Absolute repository root. Every `path` below is relative to it rather than
   * to the session's directory, so matching a clicked path needs this.
   */
  root: string
  /** The branch being compared against, or `''` for uncommitted work. */
  base: string
  /** Set when a base branch was asked for and git could not resolve it. */
  error: string | null
  files: ChangedFile[]
}

/**
 * Every file that differs from `base` — a branch name, or nothing for the
 * uncommitted state. Untracked files are included either way: a file an agent
 * has just written is the change you most want to read.
 */
export const gitChanges = (cwd: string, base?: string) =>
  invoke<Changes>('git_changes', { cwd, base: base ?? null })

export interface FileDiff {
  path: string
  /** Unified diff, or a synthesised all-added patch for an untracked file. */
  patch: string
  truncated: boolean
}

/**
 * One file's diff. `context` is the number of unchanged lines kept around each
 * hunk; a number past the file's length is how the panel shows all of it.
 */
export const gitFileDiff = (
  cwd: string,
  path: string,
  base?: string,
  context?: number,
) =>
  invoke<FileDiff>('git_file_diff', {
    cwd,
    path,
    base: base ?? null,
    context: context ?? null,
  })

export interface TextFile {
  path: string
  text: string
  /** Size on disk, which `text` may be a prefix of. */
  bytes: number
  truncated: boolean
}

/** A file read for the preview. Rejects anything binary, by its bytes. */
export const readTextFile = (path: string) =>
  invoke<TextFile>('read_text_file', { path })

export interface DirEntry {
  name: string
  /** Absolute, so a click needs nothing but this. */
  path: string
  directory: boolean
  bytes: number
  symlink: boolean
  /** Matched by a `.gitignore`; the tree dims it rather than hiding it. */
  ignored: boolean
}

/** One directory's entries, unsorted: the tree decides the order. */
export const listDirectory = (path: string) =>
  invoke<DirEntry[]>('list_directory', { path })

/**
 * What to type into a session when files are dropped on it: each path quoted
 * for that session's shell, with a trailing space.
 *
 * The quoting and the WSL path translation are the backend's, so a dropped
 * file behaves the same as one passed at launch — and neither is guessed at in
 * the webview, where the host's rules are not known.
 */
export const dropPaths = (paths: string[], backend: Backend) =>
  invoke<string>('drop_paths', { paths, backend })
