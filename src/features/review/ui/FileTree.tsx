import { type MouseEvent, type ReactNode, useCallback, useState } from 'react'

import { revealItemInDir } from '@tauri-apps/plugin-opener'

import { visibleEntries } from '../model/tree'
import { useDirectory } from '../model/useDirectory'
import { ContextMenu, type MenuItem } from '../../../shared/ui/ContextMenu'
import { Icon } from '../../../shared/ui/Icon'
import { fileIcon, folderIcon } from '../../../shared/ui/fileicon'
import { relativeTo } from '../model/changes'
import { type DirEntry, report } from '../../../shared/ipc'
import { REVEAL_LABEL } from '../../../shared/lib/platform'

export interface FileTreeProps {
  /** Absolute directory at the top of the tree. */
  root: string
  /** Changes when the tree may have moved, which re-reads every open folder. */
  revision: string
  showHidden: boolean
  /** Absolute path of the file being previewed, if any. */
  selected: string | null
  onSelect(entry: DirEntry): void
}

/**
 * The working directory's structure, expanded a folder at a time.
 *
 * Lazy on purpose: a repository with a `node_modules` in it has more files than
 * any tree should ever ask the filesystem about, and nothing below a closed
 * folder has been read.
 */
export function FileTree({
  root,
  revision,
  showHidden,
  selected,
  onSelect,
}: FileTreeProps) {
  const [menu, setMenu] = useState<Asked | null>(null)
  const close = useCallback(() => setMenu(null), [])

  return (
    <div className="py-0.5">
      <Children
        path={root}
        depth={0}
        revision={revision}
        showHidden={showHidden}
        selected={selected}
        onSelect={onSelect}
        onAsk={setMenu}
      />
      {menu && (
        <ContextMenu
          at={menu.at}
          items={itemsFor(menu.entry, root)}
          onClose={close}
        />
      )}
    </div>
  )
}

/** A row asked for its menu, and where the pointer was when it did. */
interface Asked {
  entry: DirEntry
  at: { x: number; y: number }
}

/** What a row offers besides being clicked. */
function itemsFor(entry: DirEntry, root: string): MenuItem[] {
  const relative = relativeTo(entry.path, root)
  return [
    {
      label: REVEAL_LABEL,
      onSelect: () => void revealItemInDir(entry.path).catch(report),
    },
    { label: 'Copy path', onSelect: () => void copy(entry.path) },
    ...(relative
      ? [{ label: 'Copy relative path', onSelect: () => void copy(relative) }]
      : []),
  ]
}

/** The clipboard is the browser's here; there is no plugin for it in this app. */
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch (error) {
    report(error)
  }
}

/** What every row of the tree needs, whatever its depth. */
interface TreeOptions {
  revision: string
  showHidden: boolean
  onAsk(asked: Asked): void
  /** Absolute path of the file being previewed, if any. */
  selected: string | null
  onSelect(entry: DirEntry): void
}

interface ChildrenProps extends TreeOptions {
  path: string
  depth: number
}

function Children({ path, depth, ...rest }: ChildrenProps) {
  const { entries, error } = useDirectory(path, rest.revision)

  if (error) {
    return (
      <Line depth={depth} tone="text-danger">
        {error}
      </Line>
    )
  }
  if (!entries) return <Line depth={depth}>Reading…</Line>

  const shown = visibleEntries(entries, rest.showHidden)
  if (shown.length === 0) return <Line depth={depth}>Empty</Line>

  return (
    <>
      {shown.map((entry) =>
        entry.directory ? (
          <Folder key={entry.path} entry={entry} depth={depth} {...rest} />
        ) : (
          <FileRow
            key={entry.path}
            entry={entry}
            depth={depth}
            selected={rest.selected}
            onSelect={rest.onSelect}
            onAsk={rest.onAsk}
          />
        ),
      )}
    </>
  )
}

interface FolderProps extends TreeOptions {
  entry: DirEntry
  depth: number
}

function Folder({ entry, depth, ...rest }: FolderProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        title={`${entry.name}${entry.ignored ? ' — git-ignored' : ''} — ${REVEAL_HINT}`}
        onClick={() => setOpen((was) => !was)}
        onContextMenu={ask(entry, rest.onAsk)}
        style={{ paddingLeft: indent(depth) }}
        className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs hover:bg-surface-hover ${
          entry.ignored ? IGNORED : ''
        }`}
      >
        <Icon
          name="chevron_right"
          className={`h-3.5 w-3.5 text-faint transition-transform ${
            open ? 'rotate-90' : ''
          }`}
        />
        <Icon name={folderIcon(open)} className="h-3.5 w-3.5 text-[#8ea2c0]" />
        <span className="truncate text-ink">{entry.name}</span>
        {entry.symlink && (
          <span className="flex-none text-[10px] text-faint">link</span>
        )}
      </button>
      {/* Unmounted when closed, which is what drops everything it had read. */}
      {open && <Children path={entry.path} depth={depth + 1} {...rest} />}
    </>
  )
}

interface FileRowProps extends Omit<TreeOptions, 'showHidden' | 'revision'> {
  entry: DirEntry
  depth: number
}

function FileRow({ entry, depth, selected, onSelect, onAsk }: FileRowProps) {
  const icon = fileIcon(entry.name)

  return (
    <button
      type="button"
      onClick={() => onSelect(entry)}
      onContextMenu={ask(entry, onAsk)}
      aria-current={entry.path === selected ? 'true' : undefined}
      title={`${entry.path}${entry.ignored ? ' — git-ignored' : ''} — ${REVEAL_HINT}`}
      style={{ paddingLeft: indent(depth) + 18 }}
      className={`flex w-full items-center gap-1 py-0.5 pr-2 text-left text-xs ${
        entry.path === selected
          ? 'bg-surface text-ink'
          : 'hover:bg-surface-hover'
      } ${entry.ignored ? IGNORED : ''}`}
    >
      <Icon name={icon.name} className={`h-3.5 w-3.5 ${icon.tone}`} />
      <span className="truncate">{entry.name}</span>
    </button>
  )
}

const REVEAL_HINT = 'right-click for more'

/**
 * How an ignored row reads: present, and plainly not part of the work.
 *
 * Dimmed rather than hidden, because a `dist/` you have just built is
 * something you go looking for. 60% is as far as it goes — further, and the
 * text drops under the contrast the rest of the app holds to.
 */
const IGNORED = 'opacity-60'

/**
 * Opens a row's menu where the pointer is.
 *
 * On the context menu rather than the click, because the click is what reads
 * the file — and it stays reachable from the keyboard, since the Menu key and
 * `Shift+F10` fire this event at whichever row has focus.
 */
const ask =
  (entry: DirEntry, onAsk: (asked: Asked) => void) => (event: MouseEvent) => {
    event.preventDefault()
    onAsk({ entry, at: { x: event.clientX, y: event.clientY } })
  }

/** Depth as pixels, since Tailwind cannot name an arbitrary nesting level. */
const indent = (depth: number) => 8 + depth * 12

const Line = ({
  depth,
  tone = 'text-faint',
  children,
}: {
  depth: number
  tone?: string
  children: ReactNode
}) => (
  <p
    style={{ paddingLeft: indent(depth) + 18 }}
    className={`m-0 py-0.5 text-[11px] ${tone}`}
  >
    {children}
  </p>
)
