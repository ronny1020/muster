/**
 * The Material Icon Theme's file and folder icons: each icon's URL, and the
 * filename, extension and folder-name tables that pick one.
 *
 * This file is a stand-in. `fileicons.plugin.ts` replaces its contents in the
 * dev server, the build and the tests with tables generated from the
 * installed `material-icon-theme` package; what is written here is only what
 * the typechecker and the linter read. Empty tables are the honest fallback:
 * with the plugin missing every file gets no icon — which the tests catch for
 * their own registration, and `build.ts` refuses for a release.
 */
export const ICON_URLS: Readonly<Record<string, string>> = {}
export const FILE_NAMES: Readonly<Record<string, string>> = {}
export const FILE_EXTENSIONS: Readonly<Record<string, string>> = {}
export const DEFAULT_ICON = 'file'
export const FOLDER_NAMES: Readonly<Record<string, string>> = {}
export const DEFAULT_FOLDER = 'folder'
