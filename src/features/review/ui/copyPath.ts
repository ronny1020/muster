import { report } from '../../../shared/ipc'
import { isPlainPath } from '../../../shared/lib/paste'

/**
 * Puts a path on the clipboard, unless it carries a control character.
 *
 * Git stores arbitrary path bytes and an agent picks its own filenames, so a
 * name holding `ESC[201~` would end the reader's next paste early and type the
 * rest. Such a name is refused rather than escaped: no escaping survives being
 * pasted somewhere other than a shell. The tree and the viewer offer no copy
 * for one, so the refusal here is the backstop. The webview's own clipboard
 * is enough, since every copy follows a click or a key.
 */
export async function copyPath(path: string) {
  if (!isPlainPath(path)) {
    report(
      new Error(
        `refused to copy a path holding a control character: ${JSON.stringify(path)}`,
      ),
    )
    return
  }
  try {
    await navigator.clipboard.writeText(path)
  } catch (error) {
    report(error)
  }
}
