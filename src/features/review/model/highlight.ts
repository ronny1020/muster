import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { ThemedToken } from 'shiki/types'

/**
 * Syntax highlighting for the review panel, through Shiki.
 *
 * Two decisions are load-bearing:
 *
 * - **The JavaScript regex engine, not Oniguruma.** The WASM build would need
 *   `wasm-unsafe-eval` in the content security policy, and widening the policy
 *   to colour some text is a bad trade. `forgiving` then skips the few
 *   TextMate patterns that engine cannot express, rather than throwing and
 *   losing the whole file's colours.
 * - **Grammars are fetched per language, on demand.** Shiki's full bundle is
 *   several megabytes; a review of a Rust file has no use for the other sixty.
 *
 * Every failure here is answered with `null`, never an exception: unhighlighted
 * code is a perfectly good diff, and an unreadable one is not.
 */

/** Grammars worth carrying, keyed by the id Shiki knows them as. */
const GRAMMARS = {
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  css: () => import('@shikijs/langs/css'),
  diff: () => import('@shikijs/langs/diff'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  go: () => import('@shikijs/langs/go'),
  html: () => import('@shikijs/langs/html'),
  ini: () => import('@shikijs/langs/ini'),
  java: () => import('@shikijs/langs/java'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  lua: () => import('@shikijs/langs/lua'),
  markdown: () => import('@shikijs/langs/markdown'),
  php: () => import('@shikijs/langs/php'),
  python: () => import('@shikijs/langs/python'),
  ruby: () => import('@shikijs/langs/ruby'),
  rust: () => import('@shikijs/langs/rust'),
  scss: () => import('@shikijs/langs/scss'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  sql: () => import('@shikijs/langs/sql'),
  svelte: () => import('@shikijs/langs/svelte'),
  swift: () => import('@shikijs/langs/swift'),
  toml: () => import('@shikijs/langs/toml'),
  tsx: () => import('@shikijs/langs/tsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  vue: () => import('@shikijs/langs/vue'),
  xml: () => import('@shikijs/langs/xml'),
  yaml: () => import('@shikijs/langs/yaml'),
} as const

export type Language = keyof typeof GRAMMARS

/** Chosen to sit next to the terminal's own palette rather than shout over it. */
const THEME = 'vitesse-dark'

/** Extensions to grammars. Anything absent is shown without colour. */
const BY_EXTENSION: Record<string, Language> = {
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  htm: 'html',
  html: 'html',
  cfg: 'ini',
  ini: 'ini',
  java: 'java',
  cjs: 'javascript',
  js: 'javascript',
  mjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  jsonc: 'json',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  php: 'php',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  rs: 'rust',
  sass: 'scss',
  scss: 'scss',
  bash: 'shellscript',
  sh: 'shellscript',
  zsh: 'shellscript',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  toml: 'toml',
  tsx: 'tsx',
  cts: 'typescript',
  mts: 'typescript',
  ts: 'typescript',
  vue: 'vue',
  svg: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
}

/** Filenames whose extension says nothing about their contents. */
const BY_NAME: Record<string, Language> = {
  dockerfile: 'dockerfile',
  '.bashrc': 'shellscript',
  '.zshrc': 'shellscript',
  '.gitignore': 'ini',
  '.editorconfig': 'ini',
}

/** The grammar for a path, or `null` when there is none worth loading. */
export function languageFor(path: string): Language | null {
  const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()
  const known = BY_NAME[name]
  if (known) return known
  if (name.startsWith('dockerfile')) return 'dockerfile'
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? null : (BY_EXTENSION[name.slice(dot + 1)] ?? null)
}

/**
 * The grammar a fenced code block names, or `null`.
 *
 * A fence names a language, not a file: ```` ```typescript ```` and
 * ```` ```ts ```` mean the same thing, and reading the tag as an extension
 * left the spelled-out ones — typescript, javascript, python, rust, csharp —
 * uncoloured, which is how agents write them most of the time.
 */
export function grammarFor(tag: string): Language | null {
  const name = tag.toLowerCase()
  if (name in GRAMMARS) return name as Language
  return languageFor(`x.${name}`)
}

/**
 * Past this, tokenising costs more than the colours are worth — and it runs on
 * the same thread that draws the window.
 */
const MAX_CHARS = 400_000

let core: Promise<HighlighterCore> | null = null
const grammars = new Map<Language, Promise<boolean>>()

/** One highlighter for the whole app: each grammar is compiled once. */
function highlighter(): Promise<HighlighterCore> {
  core ??= createHighlighterCore({
    themes: [import('@shikijs/themes/vitesse-dark')],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
  return core
}

/** The promise is cached, not the result, so two panes cannot both load one. */
function grammar(
  instance: HighlighterCore,
  language: Language,
): Promise<boolean> {
  let loading = grammars.get(language)
  if (!loading) {
    loading = instance
      .loadLanguage(GRAMMARS[language])
      .then(() => true)
      .catch(() => false)
    grammars.set(language, loading)
  }
  return loading
}

/** One entry per line of `code`, or `null` when it was not highlighted. */
export type HighlightedLines = ThemedToken[][]

export async function highlight(
  code: string,
  language: Language | null,
): Promise<HighlightedLines | null> {
  if (!language || !code || code.length > MAX_CHARS) return null
  try {
    const instance = await highlighter()
    if (!(await grammar(instance, language))) return null
    return instance.codeToTokens(code, { lang: language, theme: THEME }).tokens
  } catch {
    // A grammar the engine cannot compile, or a theme that failed to load.
    return null
  }
}

/** Grammar ids, for the test that pins the extension table to real ones. */
export const GRAMMAR_IDS = Object.keys(GRAMMARS) as Language[]
