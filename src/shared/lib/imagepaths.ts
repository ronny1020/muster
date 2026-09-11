/**
 * Which paths are images.
 *
 * Shared because three layers ask the question: the terminal decides whether a
 * clicked path opens a preview or an editor, the review panel decides whether
 * a file is read as text or shown, and the file tree picks an icon. An
 * allowlist of extensions, matching the set the Rust side is willing to read —
 * the name is all any of them has to go on before the read.
 */
export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
  'svg',
  'ico',
] as const

const EXTENSIONS: ReadonlySet<string> = new Set(IMAGE_EXTENSIONS)

export function isImagePath(path: string): boolean {
  // Both separators: a WSL session shows Windows paths, where splitting on `/`
  // alone leaves the whole path as the "filename" and the leading-dot guard
  // below never applies.
  const name = path.split(/[/\\]/).pop() ?? ''
  // A leading-dot name like `.png` has no extension, only a name.
  if (name.startsWith('.') && name.indexOf('.', 1) === -1) return false
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSIONS.has(extension)
}
