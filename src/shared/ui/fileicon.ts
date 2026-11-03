import {
  DEFAULT_FOLDER,
  DEFAULT_ICON,
  FILE_EXTENSIONS,
  FILE_NAMES,
  FOLDER_NAMES,
  ICON_URLS,
} from './materialicons'

/**
 * Which Material Icon Theme icon a filename gets, by the theme's file-name and
 * extension tables.
 *
 * A name the theme ties to a folder first — `.config/graphqlrc` — then the
 * whole name — `readme.md`, `agents.md`, `package.json` — then the longest
 * extension the theme knows, so `app.test.ts` is a test, `x.d.ts` a
 * declaration and `x.ts` plain TypeScript. A name neither table knows gets the
 * theme's default, where VS Code may still pick one by the file's language,
 * which needs its language registry. Case never matters, because filesystems
 * disagree about it. The contents are never read to draw a row.
 */
export function fileIconName(path: string): string {
  const name = basename(path).toLowerCase()
  return (
    byQualifiedName(FILE_NAMES, path) ??
    own(FILE_NAMES, name) ??
    byExtension(name) ??
    DEFAULT_ICON
  )
}

/**
 * Each table's names that include a folder — `.config/graphqlrc`,
 * `.github/workflows` — found once rather than on every row.
 */
const qualifiedNames = new Map(
  [FILE_NAMES, FOLDER_NAMES].map((table) => [
    table,
    Object.keys(table).filter((name) => name.includes('/')),
  ]),
)

/** A folder-qualified name the path ends with, matched as VS Code does. */
function byQualifiedName(
  table: Readonly<Record<string, string>>,
  path: string,
): string | undefined {
  const full = path.replace(/\\/g, '/').toLowerCase()
  const match = qualifiedNames
    .get(table)
    ?.find((name) => full === name || full.endsWith(`/${name}`))
  return match && table[match]
}

/** The icon's URL, bundled from the theme's own SVG. */
export const fileIconUrl = (path: string) =>
  ICON_URLS[fileIconName(path)] ?? ICON_URLS[DEFAULT_ICON]

/**
 * The longest extension the theme maps. Each dot starts a candidate, earliest
 * first, which is longest first: `a.test.ts` tries `test.ts`, then `ts`.
 */
function byExtension(name: string): string | undefined {
  for (
    let dot = name.indexOf('.');
    dot !== -1;
    dot = name.indexOf('.', dot + 1)
  ) {
    const icon = own(FILE_EXTENSIONS, name.slice(dot + 1))
    if (icon) return icon
  }
  return undefined
}

/**
 * A table's own entry only. The tables are plain objects and the key is a
 * filename anyone can choose, so `constructor` must not find `Object`.
 */
const own = (table: Readonly<Record<string, string>>, key: string) =>
  Object.hasOwn(table, key) ? table[key] : undefined

/**
 * A folder's icon by its name, as the theme picks it — `src`, `test`,
 * `.github`, `node_modules` — open or closed. An open folder's icon is always
 * the closed one's name plus `-open`.
 */
export function folderIconName(path: string, open: boolean): string {
  const icon =
    byQualifiedName(FOLDER_NAMES, path) ??
    own(FOLDER_NAMES, basename(path).toLowerCase()) ??
    DEFAULT_FOLDER
  return open ? `${icon}-open` : icon
}

/** The folder icon's URL, bundled from the theme's own SVG. */
export const folderIconUrl = (path: string, open: boolean) =>
  ICON_URLS[folderIconName(path, open)] ??
  ICON_URLS[open ? `${DEFAULT_FOLDER}-open` : DEFAULT_FOLDER]

const basename = (path: string) =>
  path.split(/[/\\]/).filter(Boolean).pop() ?? path
