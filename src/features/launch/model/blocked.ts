import type { TFunction } from 'i18next'

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

export function blockedHint(
  os: PlatformInfo['os'],
  t: TFunction<'launch'>,
): BlockedHint {
  if (os === 'macos') {
    return {
      reason: t('blocked.macos.reason'),
      remedy: t('blocked.macos.remedy'),
      settings: {
        label: t('blocked.macos.settings'),
        // `Privacy_FilesAndFolders` is the anchor Apple uses; `Privacy_Files`
        // is not one of them and silently lands on the Privacy root instead.
        url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
      },
    }
  }
  if (os === 'windows') {
    return {
      reason: t('blocked.windows.reason'),
      remedy: t('blocked.windows.remedy'),
      settings: {
        label: t('blocked.windows.settings'),
        url: 'windowsdefender://RansomwareProtection',
      },
    }
  }
  return {
    reason: t('blocked.linux.reason'),
    remedy: t('blocked.linux.remedy'),
  }
}
