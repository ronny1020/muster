/** Last segment of a path, whichever separator the host writes it with. */
export function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) ?? path
}
