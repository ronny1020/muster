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
nothing an agent wrote can reach the DOM as markup, and `TableView` puts every
CSV cell in a text node for the same reason.

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
no count, which is what the panel's Re-read button is for — or, with the
live-edit reader on, the newest edit's id, which joins the Changes list's
revision so a flashing row shows its new counts. No timer in the
panel at all — the live-edit reader below is the one clock, and it lives in
`Pane`: see the hidden-pane invariant in the root `AGENTS.md`, and note the panel is mounted only while open —
which is also why the click that opens it asks git directly rather than reading
a list that does not exist yet.

**Live edits are read by comparing passes, and only while the tab works.**
`readEdits` (`editpass.ts`) diffs each `git_changes` read against the last
one, per file and by count, because the tree revision above moves only when a
file appears — a second edit to an already-modified file, the commonest edit
an agent makes, would never show. Counts miss an edit that rewrites a line in
place, so each pass also re-reads the patches of the files edited most
recently, inside one budget of eight `git diff`s — a pass that takes a
baseline, or re-reads a rename's files, reads up to twenty instead; a file moved past that
budget is reported by its counts, and its patch forgotten so a later edit
cannot claim its lines — so a change that moves no count there, a binary file
or a mode change, shows nothing. What it reports is the tree's, not the agent's:
git cannot say who wrote a line, so the strings say "working tree".

A file leaving the list is a revert only if `HEAD` stayed put: an agent
commits as often as it edits, and a commit empties the list the same way, so a
pass whose `HEAD` moved — a commit, a pull, a checkout — reports nothing and
takes a new baseline. That sha is `git_changes`' own `head`, resolved in the
same read the list was diffed against; read separately, a commit landing
between the two reads would pair the list from before it with the `HEAD`
from after, and every committed file would read as taken back. A status that
moves with no line in it — `git add` of a new file — is not an edit either. Nor
is a rename appearing or going — `git mv`, a second rename, `mv` then
`git add`: the files it touches take a fresh baseline and show nothing,
because pairing its halves line by line produced false cards in every shape
tried. Two consequences are accepted: git pairs a rename by how alike the
halves are, so rewriting most of a renamed file can make the rename go — and
that rewrite shows nothing; and a bare `mv`, before `git add`, is still a
deleted file and a new one, because git has not paired them yet. Every read of
a renamed file names its old path too, since the new name alone reads as the
whole file added; the next edit to it then shows only itself. The fresh
baselines are re-read up to the priming budget and forgotten past it, so a
folder of three hundred moved files costs twenty reads, not three hundred.
The baseline belongs to the repository root, not the directory, so a `cd`
inside the tree keeps the feed. A failed `git_changes` keeps the baseline, and
git's own failure counts: it comes back as an `error` beside an empty list,
which would otherwise read as every file taken back. A patch git cut short is
treated as unread.

`useEdits` runs the passes. The first waits for the tab to work, because it
primes up to twenty patches and a launch restores every tab at once; after
that a timer runs at the git poll's interval only while the status is
`working`, plus one read on going idle, on a revision change, and on a
`tool_complete` naming a writing tool. A queued pass reads the session's
directory from a ref when it runs, never the one it was asked from. None of
it runs while all three surfaces are switched off.

What an edit wrote is the multiset difference between the file's patch
before and after, never a positional one — a line shifted by an edit above it
is not new. That needs the patch from before, so the first pass in a tree
remembers up to twenty of them; a file changed before that and not among them
shows its counts and no lines, rather than its whole diff dressed as one edit.

The cards and the flash carry no timer either. A card is removed on its CSS
animation's `animationend`, and a hidden pane paints nothing, so a tab you
return to shows what landed while you were away and then lets it go. While
the pointer or focus is anywhere in the stack, every card pauses and the stack
is frozen — a newer card ending or a fourth edit arriving would otherwise
remove the card under the pointer, or the one holding keyboard focus. The
pointer and focus hold separately, the space between cards is padding rather
than a gap so the pointer never crosses the terminal between two, and a hold
whose cards are all dismissed lets go — the stack unmounts with it, and no
event would arrive to release it. Only the oldest card ending clears the
backlog behind it; any other goes alone.

A row's flash is a span keyed on the edit id, so the next edit remounts it and
plays it again — and so does anything else that mounts the row. Every
mounting therefore raises the floor below which nothing flashes: the drawer
opening, a view switch and the flash being switched on raise it in
`ReviewPanel`, a folder opening or hidden files being shown raises it for
the rows that appear, and a folder closing raises it for its own flash. The
Changes list returning from an empty read does not, because its first row is
usually the edit that ended the empty state. `ReviewPanel` owns the first because the Changes
list mounts only once it has a row, and by then its first edit would already
count as old. A patch read that fails is skipped rather than read as empty,
which would show every line the file had as taken back.

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

**A surface you read opts back into selection.** The app's `body` is
`select-none`, so a view that does not say `select-text` cannot be selected at
all, and nothing reports that. The code bodies opt in; the gutters, the
`+`/`-` glyph, the spoken "added line", the hunk headers and every `Notice`
stay `select-none`, so a copy is the code and nothing else. `selectedLines`
reads the lines from each row's `data-line`, never from offsets, because a wrapped row is several screen lines and only the
row knows which line of the file it is. A removed row has no `data-line`: it
has no line in the file as it is now. And a row the selection only touches at
an edge — it ends at the row's start, or starts past the end of a row with
text in it — is left out. A blank row's start is its end, so a drag from one
includes it; blank means only whitespace, since an uncoloured row draws an
empty line as one space to keep its height. Every edge is measured from the
row's `code`, because a range counts the gutter's number as text even though
nobody can select it.

**A commit's diff is history, not the file.** Opened from the history drawer or
the file's own history, the column shows the commit against its first parent,
under the name the file had in that commit — `git log --follow` reports it
per commit, so a commit from before a rename files its diff under the old name.
The history comes from the file's own repository, found from its folder, and
the view carries that root, because the tab's directory may hold several
repositories or a submodule. So the column drops what reads the disk or names
a path: no rendered preview, no image, no editor link, no copy path, no send —
in the column or the drawer — since each would show or name today's file
beside yesterday's lines. A rename names both paths in its pathspec, or `-M`
has no old side to pair with and the file reads as new; a copy names only
itself, since its source still exists with edits of its own. A commit id
reaches git as an argument, so `commit_range` takes only a hex object id that
resolves to a commit.

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
