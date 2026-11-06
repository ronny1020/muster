/**
 * Column widths in pixels with the edge after column `edge` moved by `delta`.
 * Only its two neighbours change, so the columns nobody touched keep their
 * size, and neither may end narrower than `min` — or than it already is, so a
 * column a small window squeezed is not grown by a drag that went the other
 * way.
 */
export function movedEdge(
  widths: number[],
  { edge, delta, min }: { edge: number; delta: number; min: number },
): number[] {
  const left = widths[edge]
  const right = widths[edge + 1]
  const moved = Math.max(
    Math.min(min, left) - left,
    Math.min(delta, right - Math.min(min, right)),
  )
  return widths.map((width, index) =>
    index === edge ? left + moved : index === edge + 1 ? right - moved : width,
  )
}
