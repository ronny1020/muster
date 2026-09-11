import { type CSSProperties, useEffect, useRef, useState } from 'react'

import { renderMarkdown, type RenderedMarkdown } from '../model/markdown'
import { useTextFile } from '../model/useTextFile'
import { codeStyle } from '../model/codestyle'
import { readImage } from '../../../shared/ipc'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import { useFontMetrics } from '../../../shared/lib/fontmetrics'

export interface MarkdownViewProps {
  /** Absolute path of the markdown file. */
  path: string
  /** Changes when the tree may have moved, which re-reads the file. */
  revision: string
  /** A link was clicked: it goes to the same card the terminal's URLs use. */
  onUrl(url: string): void
}

/**
 * A markdown file, rendered.
 *
 * The only place in the app that sets `innerHTML`, and the reason it is safe is
 * in `markdown.ts`: the file's own HTML is escaped, links carry no `href`, and
 * images are paths for Rust to read rather than URLs for the webview to fetch.
 * Both are finished here, where there is a live DOM — mermaid needs one to
 * draw into, and an image has to become a `data:` URI before it can appear.
 */
export function MarkdownView({ path, revision, onUrl }: MarkdownViewProps) {
  const { settings } = useSettings()
  const metrics = useFontMetrics(settings.fontFamily, settings.fontSize)
  const { file, error } = useTextFile(path, revision)
  const [rendered, setRendered] = useState<RenderedMarkdown | null>(null)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!file) {
      setRendered(null)
      return
    }
    let live = true
    void renderMarkdown(file.text, directoryOf(file.path)).then((result) => {
      if (live) setRendered(result)
    })
    return () => {
      live = false
    }
  }, [file])

  // Both of these reach into the rendered HTML, so they run after it lands.
  useEffect(() => {
    if (!rendered || !host.current) return
    let live = true
    void drawDiagrams(host.current, rendered.diagrams, () => live)
    void loadImages(host.current, directoryOf(path), () => live)
    return () => {
      live = false
    }
  }, [rendered])

  if (error) return <Notice tone="text-danger">{error}</Notice>
  if (!rendered) return <Notice>Reading…</Notice>

  return (
    <div
      ref={host}
      onClick={(event) => {
        const url = (event.target as HTMLElement)
          .closest('[data-url]')
          ?.getAttribute('data-url')
        if (url) onUrl(url)
      }}
      // Code keeps the terminal's type; prose does not — a document is read at
      // a reading width in a reading face, which is the whole point of a
      // rendered view.
      // Prose is deliberately not terminal type — a document is read at a
      // reading width in a reading face — but the code inside it is the same
      // type as the diff beside it, which is what the font settings promise.
      style={codeVariables(codeStyle(settings, metrics))}
      className={`min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-relaxed text-ink ${PROSE}`}
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  )
}

/** The code style as custom properties the class list below can reach. */
const codeVariables = (style: ReturnType<typeof codeStyle>) =>
  ({
    '--code-font': style.fontFamily,
    '--code-size': style.fontSize,
    '--code-leading': String(style.lineHeight),
    '--code-spacing': style.letterSpacing,
  }) as CSSProperties

/**
 * Typography for the rendered document.
 *
 * Written as variants on the container rather than as a stylesheet: the HTML is
 * generated, so there is nowhere to put a class, and this keeps the rules
 * beside the element they style.
 */
const PROSE = [
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_h1]:first:mt-0 [&_p]:my-2',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-0.5',
  '[&_.md-link]:cursor-pointer [&_.md-link]:text-brand [&_.md-link]:underline',
  '[&_.md-refused]:text-faint [&_.md-refused]:italic',
  '[&_code]:rounded [&_code]:bg-surface [&_code]:px-1 [&_code]:py-0.5',
  // `[font-family:…]` spelled out: `font-[…]` is ambiguous in Tailwind and
  // compiled to `font-weight`, which left code in the theme's own mono stack
  // while looking exactly like a working rule.
  '[&_code]:[font-family:var(--code-font)]',
  '[&_code]:text-[length:var(--code-size)]',
  '[&_code]:[letter-spacing:var(--code-spacing)]',
  '[&_pre_code]:[line-height:var(--code-leading)]',
  '[&_pre]:my-2.5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border',
  '[&_pre]:border-line [&_pre]:bg-chrome [&_pre]:p-2.5',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-line',
  '[&_blockquote]:pl-3 [&_blockquote]:text-muted',
  '[&_hr]:my-4 [&_hr]:border-line',
  '[&_table]:my-2.5 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto',
  '[&_th]:border [&_th]:border-line [&_th]:bg-surface [&_th]:px-2 [&_th]:py-1',
  '[&_th]:text-left [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1',
  '[&_img]:my-2 [&_img]:max-w-full [&_img]:rounded',
  '[&_.md-diagram]:my-3 [&_.md-diagram]:overflow-x-auto',
  // mermaid hard-codes a width on its SVG, which a narrow column has to be
  // allowed to scale down rather than clip.
  '[&_.md-diagram_svg]:mx-auto [&_.md-diagram_svg]:h-auto',
  '[&_.md-diagram_svg]:max-w-full',
  'select-text',
].join(' ')

/**
 * Draws every mermaid fence into its slot.
 *
 * Loaded on demand: mermaid is megabytes, and most files have no diagram in
 * them. Its own output is the only markup here that this app did not generate,
 * which is why it runs at `strict` — the level that refuses HTML in labels.
 */
async function drawDiagrams(
  host: HTMLElement,
  diagrams: Map<string, string>,
  live: () => boolean,
) {
  if (diagrams.size === 0) return
  const { default: mermaid } = await import('mermaid')
  if (!live()) return

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'dark',
    darkMode: true,
  })

  for (const [id, source] of diagrams) {
    if (!live()) return
    const slot = host.querySelector(`[data-diagram="${id}"]`)
    // `continue`, not `return`: a slot that is not there must not abandon
    // every diagram after it.
    if (!slot) continue
    try {
      const { svg } = await mermaid.render(`mermaid-${id}`, source)
      if (!live()) return
      slot.innerHTML = svg
      disarmLinks(slot)
    } catch (reason) {
      // A diagram the agent got wrong is worth showing as what it wrote,
      // rather than as an empty gap.
      slot.textContent = `${String(reason)}\n\n${source}`
      slot.classList.add('whitespace-pre-wrap', 'text-[11px]', 'text-danger')
    }
  }
}

/** SVG links carry their target here, not in `href`. */
const XLINK = 'http://www.w3.org/1999/xlink'

/**
 * Takes the navigation out of a diagram's links.
 *
 * A mermaid `click` directive becomes a real `<a xlink:href>` in the SVG, and
 * `securityLevel: 'strict'` does not stop it — it only chooses the `target`.
 * The app has one window, so following one would take the whole of it out of
 * the terminal, which is the exact thing `markdown.ts` strips `href`s to
 * prevent. So the anchor keeps its shape and loses its destination: the URL
 * moves to `data-url`, where the click handler hands it to the same preview
 * card every other link in the document goes through.
 */
function disarmLinks(slot: Element) {
  for (const link of slot.querySelectorAll('a')) {
    const url =
      link.getAttributeNS(XLINK, 'href') ?? link.getAttribute('href') ?? ''
    link.removeAttributeNS(XLINK, 'href')
    link.removeAttribute('href')
    link.removeAttribute('target')
    if (url) {
      link.setAttribute('data-url', url)
      link.setAttribute('title', url)
    }
  }
}

/**
 * Turns every local image into a `data:` URI.
 *
 * The webview fetches nothing: the policy allows `data:` images and little
 * else, and Rust caps the size, refuses anything that is not an image, and —
 * given `within` — refuses anything that resolves outside the document's own
 * folder. `resolveAgainst` cannot do that part: a path is inside a folder by
 * spelling even when a committed symlink points that folder elsewhere.
 */
async function loadImages(
  host: HTMLElement,
  within: string,
  live: () => boolean,
) {
  const images = [...host.querySelectorAll<HTMLImageElement>('img[data-src]')]
  for (const image of images) {
    if (!live()) return
    const source = image.dataset.src
    // `continue`, not `return`: `![alt]()` renders an empty `data-src`, and it
    // must not stop every later image from loading.
    if (!source) continue
    try {
      const { dataUrl } = await readImage(source, within)
      if (live()) image.src = dataUrl
    } catch {
      image.replaceWith(
        Object.assign(document.createElement('span'), {
          className: 'text-[11px] text-faint',
          textContent: `[missing image: ${source}]`,
        }),
      )
    }
  }
}

/** The directory a file sits in, for resolving what it points at. */
function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? '' : path.slice(0, cut)
}

const Notice = ({
  children,
  tone = 'text-faint',
}: {
  children: string
  tone?: string
}) => (
  // A status region: these replace each other as reads land.
  <p role="status" className={`m-0 px-2.5 py-3 text-[11px] ${tone}`}>
    {children}
  </p>
)
