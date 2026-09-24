import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'

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
  /** Push sends this branch under its own name for the first time. */
  publishes: boolean
}

export interface Workspace {
  path: string
  label: string
  exists: boolean
  /** Exists and cannot be read; one is created, the other unblocked. */
  denied: boolean
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
  /** Record this session's output so it outlives the process. */
  journal: boolean
  /** Which agent this is, so a record remembers what wrote it. */
  agentId: string
  /**
   * Keep the session out of the alternate buffer, so it leaves a scrollback
   * behind. Costs the agent's mouse — `SCROLLBACK_ENV` in `pty.rs` has the
   * whole trade.
   */
  scrollback: boolean
  /**
   * Start a plain shell with Muster's own startup file, so it reports where
   * each prompt ends and each command's output begins — see
   * `src-tauri/src/shell.rs`. Nothing else in a session reports that.
   */
  shellIntegration: boolean
}

/** One recorded session, as the journal panel lists it. */
export interface JournalEntry {
  id: string
  bytes: number
  /** Seconds since the epoch, from when the session last printed. */
  endedAt: number
  /** Which agent wrote it; empty for a record from before this was kept. */
  agentId: string
  /**
   * The agent's own id for the conversation, where it publishes one. Empty
   * means it cannot be reopened — only this agent's own picker can find it.
   */
  sessionId: string
}

/** One thing an agent's own transcript says happened in a session. */
export interface Turn {
  kind: 'message' | 'file'
  /** One line: the start of a message, or a file's name. */
  label: string
  /** The whole message; empty for a file. */
  text: string
  /** Absolute path; empty for a message. */
  path: string
  /** The agent's own timestamp, as it wrote it. */
  at: string
}

/**
 * The turns of the conversation a tab is running, oldest first.
 *
 * Empty for anything that has no readable transcript — a shell, another agent,
 * a session whose id was never published — so a caller falls back to reading
 * the terminal.
 */
export const agentTurns = (cwd: string, id: string) =>
  invoke<Turn[]>('agent_turns', { cwd, id })

/** What the backend answers about a session it has just started. */
export interface Spawned {
  /**
   * Names this registration, quoted back by `killPty` — a tab reopening its
   * conversation respawns under the same id, so a kill has to say which
   * session it meant.
   */
  epoch: number
  /**
   * Whether the session really was started with Muster's own startup file.
   * Only such a session's `OSC 133` reports mean anything: anything else that
   * prints them is another program's claim about a shell that is not there.
   */
  shellIntegration: boolean
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
  return invoke<Spawned>('pty_spawn', { options, onOutput: channel })
}

export const writePty = (id: string, data: string) =>
  invoke<void>('pty_write', { id, data })
export const resizePty = (id: string, cols: number, rows: number) =>
  invoke<void>('pty_resize', { id, cols, rows })
export const killPty = (id: string, epoch: number) =>
  invoke<void>('pty_kill', { id, epoch })

/**
 * The commands a shell's history file holds, newest first.
 *
 * `path` is the shell's own answer, reported over `OSC 133;P;HistFile` rather
 * than guessed at.
 */
export const shellHistory = (path: string) =>
  invoke<string[]>('shell_history', { path })

export const journalSessions = (cwd: string) =>
  invoke<JournalEntry[]>('journal_sessions', { cwd })
/** `live` names the tabs whose journals are open, which are never deleted. */
export const journalSweep = (days: number, live: string[]) =>
  invoke<void>('journal_sweep', { days, live })

/** Writes pasted text to a file and answers with its absolute path. */
export const attachText = (text: string) =>
  invoke<string>('attach_text', { text })
export const attachSweep = (days: number) =>
  invoke<void>('attach_sweep', { days })
/** Live working directory of the session's foreground process, if readable. */
export const ptyCwd = (id: string) => invoke<string | null>('pty_cwd', { id })

/**
 * Facts about a directory. `probe` additionally answers `denied`, and costs a
 * `read_dir` — which is what raises the macOS permission prompt, so only a
 * caller acting on a click may ask for it. See the command's own doc comment.
 */
export const workspaceInfo = (cwd: string, probe = false) =>
  invoke<Workspace>('workspace_info', { cwd, probe })
export const homeDir = () => invoke<string>('home_dir')

/** An installed family, and whether it can hold a terminal grid. */
export interface FontFamily {
  name: string
  monospaced: boolean
}

/**
 * Every font family installed on this machine, sorted, each marked.
 *
 * Both halves come from Rust: neither webview can enumerate fonts, and the
 * monospace flag lives in the font file rather than in anything the webview
 * can measure. Answers an empty list when the platform's font source is
 * unreachable, which is what the built-in fallback list is for.
 */
export const fontFamilies = () => invoke<FontFamily[]>('font_families')

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
 * How many past sessions an agent has in a directory, or `null` when we cannot
 * say — an agent whose store we do not read, a session in a WSL distro whose
 * store lives inside it, or a store root this process cannot open.
 *
 * `null` and `0` are not interchangeable: a caller hides a control on a zero,
 * so "cannot see it" answering as "empty" takes a working control away.
 */
export const agentSessions = (agentId: string, cwd: string, backend: Backend) =>
  invoke<number | null>('agent_sessions', { agentId, cwd, backend })

/** One past conversation an agent's own store holds for a directory. */
export interface PastSession {
  /** The agent's own id for it, which is what its `--resume` takes. */
  id: string
  /** Seconds since the epoch, from when the conversation was last written. */
  at: number
  /** The first thing the user typed in it; empty when it holds none. */
  summary: string
}

/** What a directory's store holds, and whether the bound hid any of it. */
export interface PastSessions {
  /** Newest first, and bounded — `more` says whether that bound bit. */
  listed: PastSession[]
  more: boolean
}

/**
 * Past conversations for a directory, newest first.
 *
 * Empty wherever the store cannot be read, which is the caller's cue to let
 * the CLI show its own picker instead — unlike the count above, an empty list
 * costs nothing, so it is not three-valued.
 */
export const agentSessionList = (
  agentId: string,
  cwd: string,
  backend: Backend,
) => invoke<PastSessions>('agent_session_list', { agentId, cwd, backend })

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
 * Reads a page's Open Graph metadata. The only request Muster makes itself
 * (pull and push run the user's own git), so it runs on an explicit click
 * rather than on hover — terminal output is written by an agent, and a URL it
 * prints must not fetch itself.
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
export const gitCheckout = (cwd: string, branch: string, op: string) =>
  invoke<void>('git_checkout', { cwd, branch, op })

/**
 * Commits what is staged, or every change when nothing is. Resolves with
 * git's one-line summary; rejects with git's own message, or `Cancelled.`
 * once `gitCancel(op)` stopped it — as do the two below.
 */
export const gitCommit = (cwd: string, message: string, op: string) =>
  invoke<string>('git_commit', { cwd, message, op })

/** Fast-forward only. */
export const gitPull = (cwd: string, op: string) =>
  invoke<string>('git_pull', { cwd, op })

/**
 * Pushes the current branch where `git push` would send it, publishing one
 * with no upstream or an upstream of another name.
 */
export const gitPush = (cwd: string, op: string) =>
  invoke<string>('git_push', { cwd, op })

/** Stops the command running under `op`; `false` when none is. */
export const gitCancel = (op: string) => invoke<boolean>('git_cancel', { op })

export const gitLog = (cwd: string, limit: number) =>
  invoke<Commit[]>('git_log', { cwd, limit })

export const onPtyExit = (
  handler: (payload: { id: string; code: number }) => void,
) =>
  listen<{ id: string; code: number }>('pty://exit', (event) =>
    handler(event.payload),
  )

/**
 * A second launch handed this one a directory — `muster ~/proj` while the app
 * is already open. The first instance keeps the window; this is how it hears
 * what the second one was asked for.
 */
export const onOpenDirectory = (handler: (cwd: string) => void) =>
  listen<string>('muster://open-directory', (event) => handler(event.payload))

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
  /**
   * False when the file was listed but never read for a line count — which
   * also means `insertions`, `deletions` and `binary` are placeholders rather
   * than answers. Check this before trusting any of them.
   */
  counted: boolean
}

export interface Changes {
  repo: boolean
  /**
   * Absolute repository root. Every `path` below is relative to it rather than
   * to the session's directory, so matching a clicked path needs this.
   */
  root: string
  /**
   * What makes two working trees the same repository. A linked worktree has
   * its own root and its own index, so `root` cannot say whether two tabs are
   * editing one project — see `common_dir` in `review.rs`.
   */
  commonDir: string
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
 *
 * `counts: false` asks only *which* files differ, and reads none of them. The
 * reads are what raise a filesystem permission prompt on macOS, so a caller
 * that will not show a line count should not cause one.
 */
export const gitChanges = (cwd: string, base?: string, counts = true) =>
  invoke<Changes>('git_changes', { cwd, base: base ?? null, counts })

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

/**
 * The window's own controls, for the caption buttons drawn where the OS draws
 * none.
 *
 * `async` is load-bearing: unlike `invoke`, `getCurrentWindow()` is synchronous
 * and reads a global only Tauri supplies, so a plain arrow would throw at the
 * call site instead of rejecting — and thrown from an effect that unmounts the
 * app rather than degrading it. Resolving per call keeps the same throw out of
 * import time, where nothing could catch it.
 */
export const minimizeWindow = async () => getCurrentWindow().minimize()
/**
 * This window's own name. Tabs are stored per window, so two windows never
 * write each other's list.
 */
export const windowLabel = () => {
  try {
    return getCurrentWindow().label
  } catch {
    // No Tauri here — `bun run serve` and the test runner both reach this.
    // One notional window is the right answer for both.
    return 'main'
  }
}

/** The whole backend-held store, read once at startup. */
export const readAppState = () => invoke<Record<string, string>>('state_read')

/** Stores one entry, or forgets it when `value` is `null`. */
export const writeAppState = (key: string, value: string | null) =>
  invoke<void>('state_write', { key, value })

export const toggleMaximizeWindow = async () =>
  getCurrentWindow().toggleMaximize()
export const closeWindow = async () => getCurrentWindow().close()
export const isWindowMaximized = async () => getCurrentWindow().isMaximized()
export const onWindowResized = async (run: () => void) =>
  getCurrentWindow().onResized(run)
