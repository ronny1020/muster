import MarkdownIt, { type Env as MarkdownEnv } from 'markdown-it'

import { grammarFor, highlight, type HighlightedLines } from './highlight'

/**
 * Rendering a markdown file for the preview.
 *
 * Agents write markdown constantly — plans, notes, a README they just
 * rewrote — and reading the source of a table or a nested list is not reading
 * the document.
 *
 * **Raw HTML in the file is escaped, never emitted** (`html: false`). This is
 * the one place the panel builds markup, and the text it is building from was
 * written by an agent: markdown-it's own tags and ours are the only HTML that
 * can reach the DOM. Links keep no `href` either — they carry the URL as data
 * and go through the same card the terminal's URLs do — so nothing in a
 * document can navigate the window or fetch on its own.
 */
export interface RenderedMarkdown {
  html: string
  /** Mermaid sources, by the id of the placeholder that holds their slot. */
  diagrams: Map<string, string>
}

/** Files worth offering a rendered view of. */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'mdown', 'mkd'])

export function isMarkdownPath(path: string): boolean {
  const name = (path.split(/[/\\]/).pop() ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot > 0 && MARKDOWN_EXTENSIONS.has(name.slice(dot + 1))
}

interface Env extends MarkdownEnv {
  /** Highlighted code per fence token, by its index in the token stream. */
  code: Map<number, string>
  diagrams: Map<string, string>
  /** Directory of the file, for resolving its relative images. */
  dir: string
}

/**
 * The render pass's own state, out of markdown-it's `env`.
 *
 * `env` is typed as an open bag and declared optional, but every rule here is
 * only ever reached through [`renderMarkdown`], which always supplies one.
 */
const state = (env: MarkdownEnv | undefined) => env as Env

const md = new MarkdownIt({
  // The file was written by an agent; its HTML is text, not markup.
  html: false,
  linkify: true,
  breaks: false,
})

/** `mermaid`, or a language name, from a fence's info string. */
const fenceLanguage = (info: string) =>
  (info.trim().split(/\s+/)[0] ?? '').toLowerCase()

md.renderer.rules.fence = (tokens, index, _options, env) => {
  const { code, diagrams } = state(env)
  const token = tokens[index]!
  if (fenceLanguage(token.info) === 'mermaid') {
    const id = `diagram-${index}`
    diagrams.set(id, token.content)
    // Filled in by the view once mermaid has drawn it: the library needs a
    // live DOM, which a string cannot be.
    return `<div class="md-diagram" data-diagram="${id}"></div>`
  }
  const body = code.get(index) ?? md.utils.escapeHtml(token.content)
  return `<pre class="md-code"><code>${body}</code></pre>`
}

/**
 * A link with no `href`.
 *
 * The webview has one window: a plain link would navigate the whole app out of
 * the terminal it is sitting next to. The URL travels as data and the view
 * hands it to the same preview card the terminal uses.
 */
md.renderer.rules.link_open = (tokens, index) => {
  const href = md.utils.escapeHtml(String(tokens[index]!.attrGet('href') ?? ''))
  // A `<button>`, not an `<a>`: without an `href` an anchor is neither
  // focusable nor announced as anything, so the keyboard and a screen reader
  // both lose the link entirely. The title is what puts the URL back in front
  // of the reader before they commit to it.
  return `<button type="button" class="md-link" data-url="${href}" title="${href}">`
}

/**
 * An image the view will load through Rust, by absolute path.
 *
 * The policy allows `data:` images and nothing else, so a `src` of any kind —
 * relative or remote — would simply fail to load. A local one is resolved
 * against the file's own directory and read from disk; a remote one stays a
 * link, which is the only honest thing to do with it.
 */
md.renderer.rules.link_close = () => '</button>'

md.renderer.rules.image = (tokens, index, _options, env) => {
  const token = tokens[index]!
  const source = String(token.attrGet('src') ?? '')
  const alt = md.utils.escapeHtml(token.content || source)
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    const url = md.utils.escapeHtml(source)
    return `<button type="button" class="md-link" data-url="${url}" title="${url}">${alt}</button>`
  }
  const path = resolveAgainst(state(env).dir, source)
  if (path === null) {
    // Said plainly rather than dropped: a document that points outside itself
    // should read as having done so.
    return `<span class="md-refused">${alt} (image outside this folder)</span>`
  }
  return `<img class="md-image" alt="${alt}" data-src="${md.utils.escapeHtml(path)}" />`
}

/**
 * A relative path as it sits next to the file, or `null` when it does not.
 *
 * `..` is resolved rather than passed through, and anything that climbs out of
 * the document's own directory is refused: the file was written by an agent or
 * shipped by a cloned repository, and concatenating its string let
 * `![x](../../../../Pictures/x.png)` display any readable image on the machine
 * the moment the document was opened — no click involved. An absolute path is
 * refused for the same reason.
 */
export function resolveAgainst(dir: string, relative: string): string | null {
  if (!dir || !relative) return null
  if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) return null

  const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  const walked: string[] = []
  for (const segment of relative.split(/[/\\]/)) {
    if (!segment || segment === '.') continue
    if (segment !== '..') {
      walked.push(segment)
      continue
    }
    // Nothing left to climb down from means it is climbing out.
    if (walked.length === 0) return null
    walked.pop()
  }
  if (walked.length === 0) return null
  return `${dir.replace(/[/\\]+$/, '')}${separator}${walked.join(separator)}`
}

/**
 * Markdown as HTML, with its code fences already highlighted.
 *
 * Two passes, because Shiki is asynchronous and markdown-it's renderer is not:
 * the token stream is parsed, every fence highlighted in parallel, and the
 * results handed back to the renderer through `env`.
 */
export async function renderMarkdown(
  source: string,
  dir: string,
): Promise<RenderedMarkdown> {
  const tokens = md.parse(source, {})
  const env: Env = { code: new Map(), diagrams: new Map(), dir }

  await Promise.all(
    tokens.map(async (token, index) => {
      if (token.type !== 'fence') return
      const language = fenceLanguage(token.info)
      if (language === 'mermaid') return
      const lines = await highlight(token.content, grammarFor(language))
      if (lines) env.code.set(index, tokensToHtml(lines))
    }),
  )

  return {
    html: md.renderer.render(tokens, md.options, env),
    diagrams: env.diagrams,
  }
}

/** Shiki's tokens as HTML, escaped. Only the colours come from Shiki. */
function tokensToHtml(lines: HighlightedLines): string {
  return lines
    .map((line) =>
      line
        .map(
          (token) =>
            `<span style="color:${md.utils.escapeHtml(token.color ?? '')}">${md.utils.escapeHtml(token.content)}</span>`,
        )
        .join(''),
    )
    .join('\n')
}
