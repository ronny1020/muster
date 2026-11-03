import { fileIconUrl, folderIconUrl } from './fileicon'

/** A file's icon from the Material Icon Theme, by its name and extension. */
export const FileTypeIcon = ({
  path,
  className,
}: {
  path: string
  className?: string
}) => <ThemeIcon src={fileIconUrl(path)} className={className} />

/** A folder's icon from the same theme, by its name, open or closed. */
export const FolderTypeIcon = ({
  path,
  open,
  className,
}: {
  path: string
  open: boolean
  className?: string
}) => <ThemeIcon src={folderIconUrl(path, open)} className={className} />

/**
 * One of the theme's icons, drawn as the SVG file it ships.
 *
 * An `<img>` rather than inline markup, as VS Code draws them: the theme's
 * icons use gradients, transforms and several colours, which an image renders
 * as designed, and an image cannot run anything an SVG carries. Decorative,
 * because a row's name always sits beside it.
 */
function ThemeIcon({
  src,
  className = 'size-3.5',
}: {
  src: string | undefined
  className?: string
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`flex-none ${className}`}
    />
  )
}
