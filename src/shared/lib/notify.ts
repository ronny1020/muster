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

/**
 * The one permission check, shared by every caller.
 *
 * The promise is stored rather than its result, because two sessions finishing
 * together would both find an unresolved check and start their own, where one
 * check is all a launch needs.
 */
let permission: Promise<boolean> | null = null

/**
 * Checked on the first notification a user's settings allow, not at launch, so
 * a permission is never sought for a feature nobody is using.
 *
 * On desktop the plugin never prompts: its Rust side answers `Granted` to both
 * calls, and the OS decides when the first notification is posted. A refusal
 * is remembered so nothing nags; a check that rejects is forgotten rather than
 * cached, since a cached rejection would leave the window unable to notify for
 * the rest of its life.
 */
async function allowed(): Promise<boolean> {
  permission ??= checkPermission()
  try {
    return await permission
  } catch {
    permission = null
    return false
  }
}

const checkPermission = async () =>
  (await isPermissionGranted()) || (await requestPermission()) === 'granted'

export async function notify(title: string, body: string, sound: boolean) {
  if (!(await allowed())) return
  try {
    sendNotification({ title, body, sound: sound ? 'default' : undefined })
  } catch {
    // A notification is a courtesy, so a throw here never reaches a session.
    // The native post itself is fired and forgotten by the plugin, and fails
    // on its own.
  }
}
