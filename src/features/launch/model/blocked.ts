import { type PlatformInfo } from '../../../shared/lib/platform'

/**
 * What to tell someone whose directory is there but unreadable, and where to
 * send them to undo it.
 *
 * The three hosts differ in kind, not just in wording, so one message would be
 * wrong on two of them:
 *
 * - **macOS** refuses by policy. `~/Documents`, `~/Desktop` and `~/Downloads`
 *   are TCC-protected, the app is asked once per folder, and the answer is
 *   *remembered* — so a "Don't Allow" cannot be undone by trying again, and
 *   the app is never allowed to ask a second time. That is the whole reason
 *   this hint exists: retrying is the obvious move and it cannot work.
 * - **Windows** has no such prompt. A refusal is either ordinary NTFS
 *   permissions or Controlled folder access, the ransomware guard that blocks
 *   apps from the user's own Documents and Desktop — off by default, so it is
 *   a possibility to check rather than the answer.
 * - **Linux** is plain file permissions, unless the app is packaged in a
 *   sandbox whose portal was refused. Neither has a settings deep link worth
 *   guessing at, so that host gets no button.
 */
export interface BlockedHint {
  /** Why the directory cannot be read, in one sentence. */
  reason: string
  /** What the user has to do about it. */
  remedy: string
  /** A settings page to open, where the host has one worth opening. */
  settings?: { label: string; url: string }
}

export function blockedHint(os: PlatformInfo['os']): BlockedHint {
  if (os === 'macos') {
    return {
      reason:
        'macOS is blocking this folder. Documents, Desktop and Downloads need your permission, and the answer you gave is remembered.',
      remedy:
        'Because it is remembered, the app cannot ask again — switch Muster back on under Files and Folders, then start the session again.',
      settings: {
        label: 'Open Privacy settings',
        // `Privacy_FilesAndFolders` is the anchor Apple uses; `Privacy_Files`
        // is not one of them and silently lands on the Privacy root instead.
        url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
      },
    }
  }
  if (os === 'windows') {
    return {
      reason: 'Windows is refusing access to this folder.',
      remedy:
        'If it sits under Documents, Desktop or Pictures, Controlled folder access may be blocking it — allow Muster through it. Otherwise check the folder’s own permissions.',
      settings: {
        label: 'Open Windows Security',
        url: 'windowsdefender://RansomwareProtection',
      },
    }
  }
  return {
    reason: 'This folder is not readable by your user.',
    remedy:
      'Check its permissions — and if Muster was installed as a Flatpak or Snap, that the sandbox is allowed to reach it.',
  }
}
