import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'

/** Agents ring the bell more than once per turn; one notification is enough. */
const COOLDOWN_MS = 4000

export interface BellContext {
  enabled: boolean
  /** Stay quiet while the user is already looking at this very tab. */
  onlyWhenUnfocused: boolean
  tabActive: boolean
  windowFocused: boolean
  /** When this tab last raised a notification, or `null` if never. */
  lastNotifiedAt: number | null
  now: number
}

export interface BellResponse {
  /** Mark the tab, so the strip shows which session wants attention. */
  attention: boolean
  notify: boolean
}

/**
 * What to do when a session signals it is done. Both halves are deliberate:
 * the tab mark is for a user who will look later, the notification for one who
 * has moved on to something else.
 */
export function decideBellResponse(context: BellContext): BellResponse {
  const watching = context.tabActive && context.windowFocused
  const cooledDown =
    context.lastNotifiedAt === null ||
    context.now - context.lastNotifiedAt >= COOLDOWN_MS

  return {
    attention: !watching,
    notify:
      context.enabled &&
      cooledDown &&
      (!context.onlyWhenUnfocused || !watching),
  }
}

let permission: boolean | null = null

/** Asks once per launch; a refusal is remembered so nothing nags. */
async function allowed(): Promise<boolean> {
  permission ??=
    (await isPermissionGranted()) || (await requestPermission()) === 'granted'
  return permission
}

export async function notify(title: string, body: string, sound: boolean) {
  try {
    if (await allowed()) {
      sendNotification({ title, body, sound: sound ? 'default' : undefined })
    }
  } catch {
    /* notifications are a courtesy: never let one break a session */
  }
}
