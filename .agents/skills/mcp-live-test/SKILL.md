---
name: mcp-live-test
description: Drive Muster's running dev build over tauri-plugin-mcp's unix socket to verify terminal and window behaviour that no test can reach.
license: MIT
metadata:
  version: 1.0.0
  domains: [testing]
  type: automation
---

# Testing Muster live over the MCP socket

## When to use this skill

- A change touches the terminal grid, the scrollbar, the overview ruler, the
  tab strip or anything else `bun test` and `cargo test` structurally cannot
  see, and the claim "it works" needs evidence.
- A surface renders nothing and it is unclear whether the cause is the data or
  the layout.
- You want to press the app's own controls without a human at the keyboard.

Not for this skill: anything a unit test can hold. Logic belongs in a `model`
segment with a test beside it — see AGENTS.md. Reach for the socket only for
what needs a real PTY, a real buffer or real layout.

## Starting the app

```bash
bun run dev:mcp          # tauri dev with the mcp feature; socket at /tmp/muster-mcp.sock
until [ -S /tmp/muster-mcp.sock ]; do sleep 2; done
```

The first build takes a minute. `bun run dev` alone exposes no socket.

Both scripts run the app as **muster-dev**, under its own bundle identifier —
so the tabs, the settings and the journal you measure are that build's, and
never an installed Muster's. When this file says to read a recording, it means
`~/Library/Application Support/io.github.ronny1020.muster.dev/journal`.

**Never run this while someone is working in a muster-dev window.** `tauri dev`
restarts the binary on a Rust edit, killing every session in it, and reloads
the webview on a frontend edit, discarding every tab's scrollback. A session
someone cares about must be in the installed app, not in the build you are
editing. `single-instance` also means a second launch exits silently, so a
socket that answers may belong to an app you did not start — check the tab
list before trusting what you measure.

## Talking to it

`scripts/ask.ts` is the whole client: newline-delimited JSON over the socket,
`{command, payload, id, authToken}`, with the token read from
`/tmp/muster-mcp.sock.token`.

```bash
bun .agents/skills/mcp-live-test/scripts/ask.ts js "document.title"
bun .agents/skills/mcp-live-test/scripts/ask.ts take_screenshot '{"window_label":"main"}'
```

`js()` returns a **string** — `data.result` — so end every snippet in
`JSON.stringify` or an object comes back as `[object Object]`.

Useful commands: `execute_js`, `get_dom`, `dispatch_pointer`, `press_key`,
`type_into_focused`, `manage_local_storage`, `invoke`, `query_logs`, and
`take_screenshot`, which needs `window_label` and answers a
`data:image/jpeg;base64,…` string. JPEG is chroma-subsampled, so a screenshot
**cannot** separate two mark colours in a 10px strip: it corroborates, it never
proves. The full list is the match in the plugin's `src/tools/mod.rs`.

Before measuring anything, check you are measuring the build you edited. A
socket that answers may belong to an app you did not start, and `tauri dev`
rebuilds on save, so `stat -f "%Sm %N" src-tauri/target/debug/muster <the file
you changed>` and the tab list are both worth a look. When you are done, leave
the app running only if you started it — and close the tabs you opened, because
the tab list is persisted in `state.json` and outlives the run.

## The traps

Each of these produced a wrong measurement that read as a bug in the app.

**Every pane stays mounted, so scope every query to the visible one.** A
hidden tab's buttons are still in the DOM and still answer `querySelector`.
Pressing one while measuring the visible viewport produces movement that
belongs to neither. Filter by `getClientRects().length > 0` and resolve the
pane from the visible `.xterm-viewport` upward.

**`element.click()` is not reliable here; the React handler is.** Some
controls answer it, some do not, and the tab strip is on `onMouseDown` so a
click never reaches it. Read the props off the fibre and call the handler:

```js
const k = Object.keys(el).find((n) => n.startsWith('__reactProps'))
el[k].onClick({ stopPropagation() {}, preventDefault() {}, button: 0 })
```

To prove a **real** click lands, do not synthesise one — ask
`document.elementFromPoint` at the control's centre whether it hits the
control, or use `dispatch_pointer`.

**Hold no element or terminal across calls.** React replaces nodes, a
frontend edit reloads the page, and a disposed terminal answers every question
with a stale, plausible number. Re-query inside each call.

**React has not rendered when your call returns.** A synthetic
`pointermove` or a click handler sets state, and the DOM it produces appears
on the _next_ commit — so dispatching and querying inside one `js()` call
always finds nothing, which reads exactly like the handler not firing. Split
them: dispatch in one call, query in the next. This cost a working hover
control an hour of looking like a broken one.

**A terminal's grid is a canvas, so there is nothing to read in the DOM.**
Assert on what the app exposes instead — an `aria-label`, `scrollTop`, a
decoration's own canvas. The overview ruler is the one canvas worth reading
directly, because it is a 2D context and `getImageData` is lossless:

```js
const vp = [...document.querySelectorAll('.xterm-viewport')].find(
  (v) => v.getClientRects().length > 0,
) // the visible pane's, per the trap above — never document.querySelector
const c = vp.closest('.xterm').querySelector('.xterm-decoration-overview-ruler')
if (getComputedStyle(c).display === 'none') return 'alternate buffer'
const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
```

Three things about reading it, and each one is a wrong answer waiting to
happen.

`display: none` means the **alternate buffer** is active — the ruler is hidden
and there is nothing to measure. The rails are still drawn there, from the
agent's transcript rather than the buffer, so read them from the DOM
(`[role="group"][aria-label^="Your messages"]`) rather than from this canvas. That is not the same as "no marks are
painted", and mistaking the one for the other reads exactly like a bug in the
code under test. A clickable Claude Code tab is in that buffer by design, so
check the mode before reading anything from this canvas.

Pixels prove **presence and lane, never count or row**.
`ColorZoneStore.addDecoration` merges any two decorations of the same colour
and position within `floor(bufferLines / (canvasHeight - 1) * markHeight)`
lines of each other, which is hundreds of lines in a long session — so a dozen
marks collapse into one band, and the band's extent is the union of its
members. Count and position have to come from comparing the scan's rows to the
decorations the terminal holds.

The lane is what separates the two kinds, and the geometry is xterm's:
`drawWidth.full` is the whole canvas while `left` is `floor(width / 3)`, and
`drawHeight.full` is `2 * dpr` against `left`'s
`clamp(canvasHeight / bufferLines, 6, 12) * dpr`. So a message mark is proven
by its colour appearing at `x >= floor(width / 3)`, which only `full` can
reach, and a file mark by its colour appearing **only** below that. Note that
the lane does not stop a message mark painting over a file mark: the renderer
draws every non-`full` zone and then every `full` one on top, opaquely.

## Getting a shell tab with real blocks

A zsh or bash tab reports its command boundaries over `OSC 133`, which is what
the completion list and the copy control are drawn from. The overlay's
presence is the quickest check that they are arriving at all:

```js
!!document.querySelector(
  '.pointer-events-none.absolute.inset-2.overflow-hidden',
)
```

It is false until the first boundary of that session arrives, so after a
frontend reload it stays false until the next prompt is drawn — that is the
reload, not the feature.

Typing into xterm with synthetic `KeyboardEvent`s does not work, and
`type_into_focused` writes the helper textarea rather than the pty. Write to
the session instead, with the id off the React fibre:

```js
let f = el[Object.keys(el).find((n) => n.startsWith('__reactFiber'))]
while (f && !f.memoizedProps?.sessionId) f = f.return
window.__TAURI_INTERNALS__.invoke('pty_write', {
  id: f.memoizedProps.sessionId,
  data: 'ls\r',
})
```

The `shell` surface itself is on the overlay's fibre — `blockAt(row)`,
`reporting`, `suggestions` — which is how to prove a block covers the rows you
think it does without reading the user's own output.

## Getting an agent tab with real output

A replayed transcript is the best fixture there is: real tool-call headers,
thousands of rows, and no tokens spent as long as nothing is submitted. It has
to be a **Claude Code** tab **in scrollback mode** — `SCROLLBACK_ENV` takes
that one agent out of the alternate buffer and nothing takes the other eight
out at all. Scrollback is the default, so a fresh tab has a ruler to read; a clicks tab
has none at all, and the mode is per tab and per the `terminalMode` setting,
so check the status bar's **Clicks / Scrollback** control first: read against a clickable tab and the ruler is empty for reasons
that have nothing to do with your change. Pressing it reopens the session with
`--continue`, which is the replay you wanted anyway.

What a replay does _not_ give you is the message marks. Measured on a 977-row
`--continue`, only the banner and the last four prompts carried the tint the
detector keys on; older turns are redrawn without it. Judge message marks on a
session you typed in, file marks on a replay.

Set the launcher's directory, then press **Continue** through its handler —
`element.click()` per the trap above:

```js
const dir = [...document.querySelectorAll('input')].filter(
  (i) => i.type === 'text' && i.getClientRects().length > 0,
)[0]
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
  dir,
  '/path/to/repo',
)
dir.dispatchEvent(new Event('input', { bubbles: true })) // React reads the event, not the property

const go = [...document.querySelectorAll('button')].find((b) =>
  (b.textContent || '').includes('Continue'),
)
const k = Object.keys(go).find((n) => n.startsWith('__reactProps'))
go[k].onClick({ stopPropagation() {}, preventDefault() {} })
```

Wait for `scrollHeight` to stop growing before measuring: xterm pins to the
bottom on every write, so a scroll taken mid-replay is undone under you.

## What the journal is for

`~/Library/Application Support/io.github.ronny1020.muster.dev/journal/<dir>/*.log`
is the pty stream verbatim. It is the only honest source for **what an agent
actually prints** — strip the escapes and count. A pattern guessed from what a
tool call looks like cost a whole feature once: Claude Code writes
`Updated <path>`, never `Update(<path>)`, and the guess produced a blank label
that looked exactly like a layout bug. Measure against a record, then write the
pattern.

## Triggers

- "use the mcp to test"
- "test it yourself" / "run it and check"
- "drive the app"
- "why does nothing render"
