# AGENTS.md — the review panel

The invariants for the review panel — the diff and file views, highlighting, rendered markdown and diagrams, and the panel's own scrollbars and controls. The repository's conventions, and an index of
every invariant, are in the root [AGENTS.md](/AGENTS.md); read that first.

Each of these was a real bug. None of them fail loudly.

**Nothing in the review panel may need WASM.** The content security policy has
no `wasm-unsafe-eval`, so Shiki runs on `createJavaScriptRegexEngine` — widening
the policy to colour some text would be a bad trade. `forgiving: true` skips the
few TextMate patterns that engine cannot express instead of throwing away the
file's colours, and every failure in `highlight()` answers `null`, because
uncoloured code is a perfectly good diff and an unreadable one is not.

**Highlighted code is rendered as elements, never as markup.** Shiki can emit
HTML directly and `dangerouslySetInnerHTML` would be shorter, but the code being
coloured was written by an agent. `TokenLine` renders tokens as `<span>`s so
nothing an agent wrote can reach the DOM as markup.

`MarkdownView` is the one exception, and it is only safe because of three
things in `markdown.ts`: markdown-it runs with `html: false`, so the file's own
HTML is escaped into text; links are rendered with **no `href`**, carrying the
URL as `data-url` for the system browser, as a terminal URL goes, because the
webview has one window and a link would navigate the whole app out of it; and
images become `data-src` paths that Rust reads, never URLs the webview fetches.
Any change there is a change to what a file an agent wrote can do to the
window — treat the escaping, the missing `href` and the `data-src` as the
feature, not as detail.

Mermaid is the fourth thing, and it is not markdown-it's doing: a `click`
directive in a diagram becomes a real `<a xlink:href>` inside the SVG, and
`securityLevel: 'strict'` does not prevent that — it only picks the anchor's
`target`. `disarmLinks` moves the destination to `data-url` after every render,
so a diagram's links reach the browser the way the document's do. Anything
that replaces `innerHTML` with mermaid's output has to keep calling it.

**The review surfaces re-read on a revision derived from the tree, never on a
clock.** `treeRevision` in `features/workspace/model/status.ts` builds it from
git's own counts, and the changed-file list, an open diff and every expanded
folder key on it. A timestamp is what this started as, and because
`useWorkspace` polls every few seconds it tore an open diff down on every tick —
clearing it to a "Reading…" notice, losing the scroll position and re-tokenising
both sides through Shiki on the thread that draws the window, in every mounted
pane at once. The trade is that a second edit to an already-modified file moves
no count, which is what the panel's Re-read button is for. No timer here at all:
see the hidden-pane invariant in the root `AGENTS.md`, and note the panel is mounted only while open —
which is also why the click that opens it asks git directly rather than reading
a list that does not exist yet.

**The review panels mark their own scrollbars, and they measure rows rather
than compute them.** `ChangeRuler` reads `offsetTop` off the rendered
`[data-change]` rows, because a diff's rows are real elements whose height
depends on the font, the wrap setting and the width — none of which a model can
predict. It takes a `revision` for exactly that reason: nothing about the DOM
announces a re-read, a context change or a new file, so the measure has to be
told.

Two things there are the same shape as the terminal's own surfaces. The first
measure is synchronous, because an occluded window gets no animation frames and
a ruler that waited for one stayed empty in a way that reads as "nothing
changed". And only the changed rows carry `data-change`: a diff is mostly
context, and marking every row would have the ruler filtering thousands of
attributes that say nothing. The plain file view marks the same way, from
`changedLines` over the same patch the diff view reads — reading a file says
nothing about what changed in it, and a file opened from outside a working tree
gets no marks rather than wrong ones.

**A panel's close button may never be the control that clips.** Every `Action`
in `FileViewer`'s header is `flex-none`, so a narrow panel overflowed the row
and pushed the last item — the close button — out of sight, leaving Escape as
the only way back. The optional controls sit in their own `min-w-0 shrink
overflow-hidden` group and close sits outside it, so the row clips the things
you can do without and keeps the one you cannot. The panel is draggable down
to a few pixels, so this is reachable by ordinary use rather than only at the
window's floor.

**The file column never covers the terminal.** Reading a diff and typing the
next instruction are one activity, so the column is a sibling of the terminal in
the flex row, not an overlay on it. That is also why the drawer holds no reader:
it lists and the column reads, and what is being read lives in `Pane` — the two
are siblings, so neither can own it.

**Code in the review panel is the terminal's own type.** `codeStyle` hands the
font family, size, line height and letter spacing from settings to the diff and
the file view, so a column of code matches the output beside it. Tailwind's
preflight then undoes half of that: it sets `code { font-family: var(--font-mono) }`,
which beats an inherited family, so the elements that actually show code would
ignore the font the user chose. `[&_code]:[font-family:inherit]` on the
container is what puts it back, and the gutters are sized in `ch` rather than
pixels so the columns follow the font instead of clipping at 20px.
