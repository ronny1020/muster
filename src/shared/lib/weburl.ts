/**
 * A web page's address as the browser will read it, or `null` for anything
 * else — the only kind of link the app hands to the system. A link in agent
 * output or in a file an agent wrote may name any scheme — a pre-filled
 * email, a phone call, a settings pane — and none of those is what a click on
 * a link should start. The parsed form is what gets opened, so what was
 * checked is what the browser receives.
 */
export function webHref(url: string) {
  try {
    const parsed = new URL(url)
    const web = parsed.protocol === 'https:' || parsed.protocol === 'http:'
    return web ? parsed.href : null
  } catch {
    return null
  }
}
