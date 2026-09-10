/**
 * Terminal colour schemes.
 *
 * A plain table rather than anything computed: these are published palettes,
 * and the point of picking a named one is that it matches the same scheme
 * elsewhere exactly. `background` is what the pane paints behind the grid too,
 * so it has to be an opaque `#rrggbb`.
 */

export interface TerminalTheme {
  name: string
  foreground: string
  background: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export const DEFAULT_THEME_ID = 'muster'

export const THEMES: Record<string, TerminalTheme> = {
  muster: {
    name: 'Muster',
    foreground: '#e6e6e8',
    background: '#171719',
    cursor: '#d97757',
    cursorAccent: '#171719',
    selectionBackground: '#37414f',
    black: '#2a2a30',
    red: '#e26d63',
    green: '#7fb37a',
    yellow: '#d8b165',
    blue: '#6f9ede',
    magenta: '#b98adf',
    cyan: '#67b6bd',
    white: '#d5d5da',
    brightBlack: '#5c5c66',
    brightRed: '#f08a80',
    brightGreen: '#9bcf96',
    brightYellow: '#efcb82',
    brightBlue: '#8fb8f0',
    brightMagenta: '#cfa6f0',
    brightCyan: '#84d0d6',
    brightWhite: '#f2f2f4',
  },
  'gruvbox-dark': {
    name: 'Gruvbox Dark',
    foreground: '#ebdbb2',
    background: '#282828',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
  },
  'solarized-dark': {
    name: 'Solarized Dark',
    foreground: '#839496',
    background: '#002b36',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  nord: {
    name: 'Nord',
    foreground: '#d8dee9',
    background: '#2e3440',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#434c5e',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
  },
  'solarized-light': {
    name: 'Solarized Light',
    foreground: '#657b83',
    background: '#fdf6e3',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
}

/**
 * The named theme, or the default when the stored name is unknown.
 *
 * Total on purpose: a theme removed in a later version, or a hand-edited
 * setting, must leave a readable terminal rather than an unstyled one.
 */
export const themeFor = (id: string): TerminalTheme =>
  THEMES[id] ?? THEMES[DEFAULT_THEME_ID]

/** Id and display name for each theme, for a picker. */
export const themeChoices = () =>
  Object.entries(THEMES).map(([id, theme]) => ({ id, name: theme.name }))
