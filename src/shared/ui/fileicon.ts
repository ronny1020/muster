import { IMAGE_EXTENSIONS } from '../lib/imagepaths'
import type { IconName } from './icons'

/**
 * Which icon and tint a filename gets.
 *
 * Extension-driven, like every file tree: the contents are not read to draw a
 * row. The tints are deliberately few — a tree where every row is a different
 * colour reads as noise, so related languages share one.
 */
export interface FileIcon {
  name: IconName
  /** Tailwind text colour for the glyph. */
  tone: string
}

const CODE: FileIcon = { name: 'code', tone: 'text-[#6f9ede]' }
const DATA: FileIcon = { name: 'data_object', tone: 'text-[#d8b165]' }
const TEXT: FileIcon = { name: 'description', tone: 'text-muted' }
const SHELL: FileIcon = { name: 'terminal', tone: 'text-[#7fb37a]' }
const IMAGE: FileIcon = { name: 'image', tone: 'text-[#b58cd8]' }

/** Extension to icon. Anything absent falls back to a plain document. */
const BY_EXTENSION: Record<string, FileIcon> = {
  ts: CODE,
  tsx: CODE,
  js: { name: 'javascript', tone: 'text-[#d8b165]' },
  jsx: { name: 'javascript', tone: 'text-[#d8b165]' },
  mjs: { name: 'javascript', tone: 'text-[#d8b165]' },
  cjs: { name: 'javascript', tone: 'text-[#d8b165]' },
  rs: CODE,
  go: CODE,
  py: CODE,
  rb: CODE,
  java: CODE,
  kt: CODE,
  swift: CODE,
  c: CODE,
  h: CODE,
  cpp: CODE,
  hpp: CODE,
  cs: CODE,
  php: CODE,
  lua: CODE,
  vue: CODE,
  svelte: CODE,
  html: { name: 'html', tone: 'text-[#e08a5f]' },
  css: { name: 'css', tone: 'text-[#6f9ede]' },
  scss: { name: 'css', tone: 'text-[#6f9ede]' },
  json: DATA,
  jsonc: DATA,
  yaml: DATA,
  yml: DATA,
  toml: DATA,
  ini: DATA,
  env: { name: 'lock', tone: 'text-[#d8b165]' },
  lock: { name: 'lock', tone: 'text-faint' },
  sql: { name: 'table', tone: 'text-[#6f9ede]' },
  csv: { name: 'table', tone: 'text-[#7fb37a]' },
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  fish: SHELL,
  ps1: SHELL,
  bat: SHELL,
  cmd: SHELL,
  md: TEXT,
  mdx: TEXT,
  txt: TEXT,
}

/** Filenames worth recognising whole, because their extension says nothing. */
const BY_NAME: Record<string, FileIcon> = {
  dockerfile: SHELL,
  makefile: SHELL,
  '.gitignore': { name: 'settings', tone: 'text-faint' },
  '.gitattributes': { name: 'settings', tone: 'text-faint' },
  '.editorconfig': { name: 'settings', tone: 'text-faint' },
}

// From the one list of image extensions rather than a second copy of it: the
// tree's icon and the preview's decision to show a picture have to agree.
for (const extension of IMAGE_EXTENSIONS) BY_EXTENSION[extension] = IMAGE

export function fileIcon(path: string): FileIcon {
  const name = basename(path).toLowerCase()
  const known = BY_NAME[name]
  if (known) return known
  // `bun.lock` and `Cargo.lock` are locks whatever they are locking, and a
  // dotfile like `.env.local` keeps the meaning of its first suffix.
  if (name.endsWith('.lock')) return BY_EXTENSION.lock!
  if (name.startsWith('.env')) return BY_EXTENSION.env!
  return BY_EXTENSION[extensionOf(name)] ?? TEXT
}

export const folderIcon = (open: boolean): IconName =>
  open ? 'folder_open' : 'folder'

const basename = (path: string) =>
  path.split(/[/\\]/).filter(Boolean).pop() ?? path

/**
 * The extension, or `''` for a name that has none. A leading dot is part of
 * the name rather than the start of an extension, so `.gitignore` has none.
 */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}
