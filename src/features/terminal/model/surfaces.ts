/**
 * Which surfaces a session gets, decided in one place.
 *
 * Each of these was wired separately once, and each was gated on a different
 * thing: the rail on the buffer type, the width repair on the tab's *mode*,
 * the scrollbar on nothing at all. That is how a clicks tab whose CLI had
 * fallen back to its classic renderer ended up with a real scrollback, a
 * clear on every resize, and no control to reopen the session — three
 * answers to one question. Nothing in the suite could see any of it, because
 * it all lived inside a component.
 */

/** What a session's view looks like right now, as the terminal reports it. */
export interface ViewState {
  /** Which buffer xterm is showing. The agent chooses this, not the tab. */
  buffer: 'normal' | 'alternate'
  /** Lines the buffer holds, including scrollback. */
  bufferRows: number
  /** Lines on screen. */
  screenRows: number
  /** Turns the agent's own transcript offered, if any. */
  turns: number
}

export interface Surfaces {
  /**
   * Whether the session has the scroll extent xterm draws a scrollbar from.
   *
   * It needs somewhere to scroll: the alternate buffer is exactly `rows`
   * tall, and a normal buffer that has not filled a screen yet has nothing
   * above either. Nothing gates on this — xterm draws the bar itself — so it
   * is here to be asserted, which is the only way the suite can say whether
   * a session should have one. Its two inputs are read while rendering, and
   * neither a growing buffer nor a resize re-renders the caller, so a
   * consumer would need them fed from state the way `buffer` is.
   */
  scrollbar: boolean
  /** Where the message rail's places come from, or `none` for no rail. */
  rail: 'transcript' | 'buffer' | 'none'
  /**
   * Whether the width repair has anything to repair.
   *
   * The same test `reflowRuins` clears on — the live buffer, never the tab's
   * mode, because the CLI decides which renderer it runs.
   */
  replay: boolean
}

export function surfacesFor(view: ViewState): Surfaces {
  const scrollable =
    view.buffer === 'normal' && view.bufferRows > view.screenRows
  return {
    scrollbar: scrollable,
    rail:
      view.buffer === 'alternate' && view.turns > 0
        ? 'transcript'
        : view.buffer === 'normal'
          ? 'buffer'
          : 'none',
    replay: view.buffer === 'normal',
  }
}
