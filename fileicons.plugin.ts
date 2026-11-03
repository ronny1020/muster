/**
 * Fills `src/shared/ui/materialicons.ts` from the installed
 * `material-icon-theme` package, so the file tree's icons are that package's
 * own SVGs and its own filename, extension and folder-name mapping — the one VS Code's
 * Material Icon Theme draws with — and a version bump of the package is the
 * whole of an update. Nothing is copied into the repository.
 *
 * Registered for the dev server (`bunfig.toml`), the production build
 * (`build.ts`) and the tests (`test/setup.ts`). Each SVG is imported, so the
 * bundler's file loader ships it as an asset beside the bundle.
 *
 * The icons are MIT-licensed, Copyright (c) 2025 Material Extensions; the
 * licence text is the package's `LICENSE`.
 */
import type { BunPlugin } from 'bun'
import { generateManifest } from 'material-icon-theme'

const STUB = /[\\/]src[\\/]shared[\\/]ui[\\/]materialicons\.ts$/

const plugin: BunPlugin = {
  name: 'material-file-icons',
  setup(build) {
    build.onLoad({ filter: STUB }, () => ({
      contents: moduleSource(),
      loader: 'ts',
    }))
  },
}

export default plugin

/**
 * The module's source: one import per icon the mapping can name, from the
 * package's documented `generateManifest` with its default settings.
 */
function moduleSource(): string {
  const manifest = generateManifest()
  const definitions = manifest.iconDefinitions ?? {}
  const fallback = manifest.file ?? 'file'
  // VS Code matches both tables case-insensitively, and so does `fileicon.ts`.
  const fileNames = lowerKeys(manifest.fileNames ?? {})
  const fileExtensions = lowerKeys(manifest.fileExtensions ?? {})
  // One table for both states: every open folder's icon is its closed one's
  // name plus `-open`, so `folderNamesExpanded` would only repeat it.
  const folderNames = lowerKeys(manifest.folderNames ?? {})
  const folder = manifest.folder ?? 'folder'
  const folders = [folder, ...Object.values(folderNames)]
  const used = [
    ...new Set([
      fallback,
      ...Object.values(fileNames),
      ...Object.values(fileExtensions),
      ...folders,
      ...folders.map((icon) => `${icon}-open`),
    ]),
  ].filter((icon) => definitions[icon]?.iconPath)

  const imports = used.map((icon, index) => {
    const file = definitions[icon].iconPath?.split('/').pop() ?? ''
    return `import i${index} from ${JSON.stringify(`material-icon-theme/icons/${file}`)}`
  })
  const urls = used.map((icon, index) => `${JSON.stringify(icon)}: i${index}`)
  return [
    ...imports,
    `export const ICON_URLS: Readonly<Record<string, string>> = {${urls.join(',')}}`,
    `export const FILE_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(fileNames)}`,
    `export const FILE_EXTENSIONS: Readonly<Record<string, string>> = ${JSON.stringify(fileExtensions)}`,
    `export const DEFAULT_ICON = ${JSON.stringify(fallback)}`,
    `export const FOLDER_NAMES: Readonly<Record<string, string>> = ${JSON.stringify(folderNames)}`,
    `export const DEFAULT_FOLDER = ${JSON.stringify(folder)}`,
  ].join('\n')
}

const lowerKeys = (table: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(table).map(([key, icon]) => [key.toLowerCase(), icon]),
  )
