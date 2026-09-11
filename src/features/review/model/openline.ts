import { type Editor, openInEditor, report } from '../../../shared/ipc'

/**
 * Opening a file at one of its lines, as the gutter offers it.
 *
 * Only the new side of a diff can be opened: an old line number describes the
 * file before the change, so an editor sent there would land somewhere else
 * entirely — or nowhere, for a line the change removed.
 */
export interface LineOpener {
  /** Editor name, for the tooltip; there is no gutter link without one. */
  editor: string
  open(line: number): void
}

/**
 * An opener for one file, or `null` when there is nothing to open it with.
 *
 * Both surfaces that draw line numbers — the diff and the file preview, which
 * share the column — need one, and each knows a different path, so the shape
 * lives here rather than being built twice.
 */
export function lineOpener(
  editor: Editor | null,
  path: string | null,
): LineOpener | null {
  if (!editor || !path) return null
  return {
    editor: editor.name,
    open: (line) => void openInEditor(path, editor.command, line).catch(report),
  }
}
