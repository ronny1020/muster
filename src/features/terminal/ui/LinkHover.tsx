import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type LinkMeta, linkPreview } from '../../../shared/ipc'
import { webHref } from '../../../shared/lib/weburl'
import { previewCache } from '../model/preview'

/** How long the pointer rests on a link before its page is fetched, so a
 *  pointer crossing a screen of links does not fetch every one of them. */
const DWELL_MS = 250

const cachedPreview = previewCache(linkPreview)

/** The click that opens a link: plain, or with the platform's modifier. */
export type OpenGesture = 'click' | 'cmdClick' | 'ctrlClick'

/** What the page said, or why it could not be read. */
type Answer = { uri: string; meta: LinkMeta } | { uri: string; failure: string }

/**
 * The label for the link under the pointer: its real target, the click that
 * opens it and, for a web page, what that page says about itself — with
 * "Loading preview…" until it answers. It takes no pointer events, so the
 * click goes to the link whatever this shows.
 */
export function LinkHover({
  uri,
  opens,
}: {
  uri: string
  /** Which click opens it, which depends on whether the agent reads the mouse. */
  opens: OpenGesture
}) {
  const { t } = useTranslation('terminal')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const href = webHref(uri)

  // The fetch is the outside thing; `cancelled` drops an answer for a link
  // the pointer has already left.
  useEffect(() => {
    if (!href) return
    let cancelled = false
    const show = (next: Answer) => {
      if (!cancelled) setAnswer(next)
    }
    const timer = setTimeout(
      () =>
        void cachedPreview(href).then(
          (meta) => show({ uri, meta }),
          (error: unknown) => show({ uri, failure: String(error) }),
        ),
      DWELL_MS,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [uri, href])

  const current = answer?.uri === uri ? answer : null
  const loading = href !== null && !current
  return (
    <div
      role="status"
      className="pointer-events-none absolute bottom-2 left-2 z-20 w-max max-w-[min(70%,26rem)] overflow-hidden rounded-md border border-line bg-chrome/95 text-[11px] text-ink shadow-lg backdrop-blur"
    >
      {current && 'meta' in current && (
        <PageCard meta={current.meta} untitled={t('link.untitled')} />
      )}
      {current && 'failure' in current && (
        <div className="truncate border-b border-line px-2 py-1 text-muted">
          {t('link.unavailable', { reason: current.failure })}
        </div>
      )}
      {loading && (
        <div className="animate-pulse border-b border-line px-2 py-1 text-muted">
          {t('link.loading')}
        </div>
      )}
      <div className="px-2 py-0.5">
        <div className="flex gap-1">
          <span className="font-medium break-all">{hostOf(href) ?? uri}</span>
          <span className="flex-none text-muted">
            · {t(`link.opens.${opens}`)}
          </span>
        </div>
        {href && <div className="truncate text-muted">{uri}</div>}
      </div>
    </div>
  )
}

/**
 * The host a click would reach, drawn whole: a long address truncates, and
 * `https://github.com:pull-…@evil.example` cut short reads as GitHub. The
 * userinfo before an `@` is never part of it.
 */
const hostOf = (href: string | null) => (href ? new URL(href).host : null)

function PageCard({ meta, untitled }: { meta: LinkMeta; untitled: string }) {
  if (!meta.title && !meta.description && !meta.imageDataUrl)
    return (
      <div className="border-b border-line px-2 py-1 text-muted">
        {untitled}
      </div>
    )
  return (
    <div className="flex items-start gap-2 border-b border-line px-2 py-1.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        {meta.siteName && (
          <div className="truncate text-[10px] text-muted">{meta.siteName}</div>
        )}
        {meta.title && (
          <div className="line-clamp-2 text-[12px] font-medium">
            {meta.title}
          </div>
        )}
        {meta.description && (
          <div className="line-clamp-2 text-muted">{meta.description}</div>
        )}
      </div>
      {meta.imageDataUrl && (
        <img
          src={meta.imageDataUrl}
          alt=""
          className="h-14 w-20 flex-none rounded object-cover"
        />
      )}
    </div>
  )
}
