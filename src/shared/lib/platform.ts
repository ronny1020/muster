import { invoke } from '@tauri-apps/api/core'

/** Which world a session runs in. Only Windows offers more than the host. */
export type Backend = 'native' | 'wsl'

export interface PlatformInfo {
  os: 'macos' | 'windows' | 'linux'
  pathSeparator: string
  /** Whether the status bar can follow a `cd` typed in the terminal. */
  followsCwd: boolean
  /** Distros a session can run inside; empty unless this is Windows with WSL. */
  wslDistros: string[]
}

export const platformInfo = () => invoke<PlatformInfo>('platform_info')

/**
 * Which host this is, read from the webview rather than the backend: the
 * titlebar gutter and the shortcut modifier are needed on the first render,
 * before an async command could answer. Anything the backend alone knows —
 * whether WSL is installed, whether a `cd` can be followed — comes from
 * `platformInfo` instead.
 */
export const OS: PlatformInfo['os'] = /Macintosh|Mac OS X/.test(
  navigator.userAgent,
)
  ? 'macos'
  : /Windows/.test(navigator.userAgent)
    ? 'windows'
    : 'linux'

export const IS_MAC = OS === 'macos'

/** Where this platform's file manager shows a directory. */
export const REVEAL_LABEL = {
  macos: 'Reveal in Finder',
  windows: 'Show in Explorer',
  linux: 'Show in file manager',
}[OS]

/** An example path, for a directory field that is still empty. */
export const EXAMPLE_DIRECTORY =
  OS === 'windows' ? 'C:\\code\\project' : '~/code/project'
