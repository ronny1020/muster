# AGENTS.md

Conventions for working in this repository. Written for coding agents, and just
as true for people.

**What this is:** a desktop app that runs AI agent CLIs in Chrome-style tabs.
Tauri 2 (Rust) owns the window, the PTYs and the filesystem; React 19 +
Tailwind 4 draw the interface; xterm.js renders each terminal. Bun bundles,
serves and tests the frontend.

Practical setup, commands and file map: [CONTRIBUTING.md](CONTRIBUTING.md).

## Before you claim a change works

All seven, in this order — the first three from the repo root, the last four
from `src-tauri`:

```bash
bun run check
bun run format:check
bun test
(cd src-tauri && cargo fmt --check)
(cd src-tauri && cargo check --all-targets)
(cd src-tauri && cargo clippy --all-targets -- -D warnings)
(cd src-tauri && cargo test --lib)
```

`bun run check:all` runs all seven in that order, and `bun run check:rust` the
last four — the shortcut exists so "I ran the checks" means the same thing
every time. `cargo check` earns its place ahead of the other two: a plain
compile error reported as rustc's own diagnostic is easier to read than the
same error arriving through clippy or a test binary that failed to build. Note it passes clippy `-D warnings`, as CI does: a warning that
passes locally and fails in CI is the whole reason the two ever disagree.

`bun run format` and `cargo fmt` fix what the two format checks report.

A husky pre-commit hook covers _some_ of this: `lint-staged` formats the staged
files, then `bun run check` and `bun test` run, and `bun run check:rust` — the
same script CI runs, so the two cannot drift — only when a `.rs` file is staged.
It never runs `format:check` (Prettier formats instead). Run the seven by hand
before a pull request.

None of them lints: there is no ESLint in this repo and no lint step. A wrong
hook dependency array — re-running the spawn effect, say — fails silently with
nothing to catch it, so read every dependency list you touch.

A green typecheck is not a passing test, and neither one exercises a PTY. If
you changed process spawning, terminal behaviour, or anything in the window
chrome, say plainly that you did not run it, or run it: `bun run dev`, then
report what you saw.

## Keep these documents true

A change is not finished while one of these files still describes the old
behaviour. Update them **in the same change**, not afterwards:

- **AGENTS.md** — the invariants, the layer table, the conventions. The layer
  table is meant to be what exists, so a new slice or segment belongs in it.
- **SECURITY.md** — what the app promises about the three parties it does not
  trust. A new command that reads the filesystem, or a new renderer fed by file
  contents, changes what that document has to claim.
- **docs/RELEASE.md** — the release runbook. It names `bun run check:all`
  rather than a count, and should stay that way: the count is what went stale.
- **CONTRIBUTING.md** — the checks, the "where things are" table, the
  procedures. A new module or command gets a row.
- **README.md** — anything a user can see. A new setting, a new shortcut, a new
  thing that is clickable: the settings list and the shortcut table are the two
  that go stale first.

The same applies to an instruction you are given that disagrees with what is
written here: the instruction wins, and this file gets the correction as part of
the work. A document nobody trusts is worse than no document — and the drift is
invisible, because nothing in the checks can catch it.

Say in your report which of these you changed, and why.

## Invariants that break silently

Each of these was a real bug. None of them fail loudly.

**Strip agent session markers from every spawned process.**
`INHERITED_SESSION_MARKERS` in `src-tauri/src/pty.rs` is removed from each PTY's
environment. Launching this app from inside an agent CLI otherwise leaks them
into every tab: a nested Claude Code sees `CLAUDE_CODE_CHILD_SESSION`, stops
writing a transcript, and `--continue` and `--resume` then find nothing.

Add to that list when a new agent brings its own markers. To find them: open a
session of that CLI in your own terminal and diff its environment against a
plain shell's — `env | sort` in both, or `env | grep -i <agent>`. Do not guess
variable names; a wrong guess strips nothing and looks exactly like success.

**Sessions run through a login shell.** A GUI app inherits a bare `PATH` — from
launchd on macOS, from the desktop session on Linux — so a CLI installed by the
user's profile (`mise`, `nvm`, `~/.local/bin`) is invisible until the shell's rc
files have run. On Windows the reason differs: PowerShell resolves the `.cmd`
and `.ps1` shims npm-installed CLIs ship as, which `CreateProcess` alone will
not find.

**Paths are stored in the host's own form.** A WSL session keeps the Windows
path the picker returned — a `\\wsl$\Ubuntu\...` share or a drive letter — and
translates to `/home/...` or `/mnt/c/...` only at launch, for `wsl.exe --cd`.
One representation is what keeps `git`, the folder picker and the file-manager
button agreeing with each other.

**Panes stay mounted while hidden.** `Pane` renders every tab and hides the
inactive ones with `hidden`. Unmounting would kill the PTY and the scrollback,
which is the opposite of the product. Never key a pane on the active tab.

The consequence, which is easy to miss: a timer or subscription in a pane runs
in _every_ tab, forever, visible or not. `useWorkspace` already git-polls on
that basis, at a user-set interval. Anything ticking faster — a per-second
clock, an animation — needs to check whether its pane is active first.

**Terminals blur when their pane hides.** A hidden pane keeps DOM focus in
xterm's helper textarea, which then swallows typing meant for the tab now on
screen. `TerminalView` calls `blur()` on deactivation; the launcher claims focus
when it comes forward.

**No `StrictMode`.** Its double-invoked effects spawn two PTYs per tab in
development. `src/app/main.tsx` says so — leave it.

**Tailwind needs an `@source` naming `src`.** In `src/app/index.css`,
resolved relative to that file — so moving the stylesheet breaks it. The dev server and
the production build resolve their scan root differently, and without it the dev
build silently emits no custom utilities.

**Output is recorded before it is sent, and every bound on it is load-bearing.**
The reader thread writes to the journal before `Channel::send`, because a
frontend that has gone away is exactly when the record is the only copy left.
The file is the pty stream verbatim, so it holds whatever the agent printed —
which is why recording is a setting, why one session is capped at 4 MB with the
older half dropped rather than rotated, why a sweep expires records on startup,
and why `file_stem` refuses any tab id that is not a bare name. Retention lives
in the frontend because it is a user setting and settings are in
`localStorage`; the cap lives in Rust because only the writer can enforce it.
Loosen any one of those and the feature becomes an unbounded, permanent copy of
everything every agent ever printed.

**An oversized paste is caught in two places, because macOS has no third.**
`Cmd+V` is a native menu accelerator, so `attachCustomKeyEventHandler` never
sees it and `clipboardIntent` returns `null` on macOS by design — the DOM
`paste` listener is the only route there. `Ctrl+Shift+V` goes through the key
handler on Windows and Linux, and every other paste gesture on those platforms
(`Ctrl+V`, right-click, middle-click) reaches the DOM listener too, which is
registered on every platform. Both funnel into one `deliverPaste`, and the DOM
listener claims the event **only** when the text is going to become a file:
taking an ordinary paste would override bracketed-paste handling xterm already
has right.

The call that matters there is **`stopPropagation`, not `preventDefault`**.
xterm registers its own paste listener on both its textarea and its element —
both descendants of the host this listener sits on — and that handler never
consults `defaultPrevented`: it reads the clipboard and sends it to the pty
itself. With `preventDefault` alone an oversized paste is delivered twice, once
as the giant keystroke run the feature exists to prevent, and nothing fails
loudly. Stopping propagation in the capture phase is what keeps the event from
reaching it at all. The path is delivered through `dropPaths`, never formatted
here — the quoting is the session's shell's, and a WSL session needs the
translation `--cd` does at launch.

**Two tabs in one working tree are not a collision.** `collisionsByTab` groups
tabs by `--git-common-dir`, so every worktree of a repository is compared — that
is the arrangement parallel agents run in, and two worktrees have separate
indexes. But tabs sharing a `root` are one tree, so they share every changed
file by definition; warning about that lights the chip permanently and teaches
everyone to ignore it. The `root` check is what keeps the warning worth reading,
and the test named "a third tab in a shared tree does not hide a real collision"
(`collisions.test.ts`, not a Rust test) pins that it suppresses the pair
without suppressing the real overlap.

The detector is mounted once, above the panes, for the reason every deck-wide
thing is: a hook called inside `Pane` runs in every mounted tab, and each copy
would poll every _other_ tab's directory. It also polls at a multiple of the
user's git interval, because "another tab is editing this" changes on the scale
of an agent finishing an edit rather than of a keystroke.

**`Channel` payloads must be owned.** PTY output goes over
`Channel<InvokeResponseBody>` and sends `InvokeResponseBody::Raw(...)`. A
borrowed `&[u8]` cannot outlive the command, and the reader thread needs it to.

**Never document `brew tap` as a step of its own.** `brew install --cask
<tap>/<cask>` is the only form that taps, trusts and installs in a working
order. The mechanism and Homebrew's exact error live in one place — the README's
"If something looks wrong" section, never the install steps, which stay a list
of what to do. `brew reinstall` cannot stand in for the install either, because
it does not add a missing tap; it repairs a record that disagrees with
`/Applications`, which is a different job.

Do not add a second install step to paper over that repair. One Homebrew command
is the whole macOS install, and anything further a user has to trust is a worse
trade than telling them to run `brew reinstall --cask` by hand.

This is invisible from a developer machine, where the tap is already present and
trusted. Test from a wiped one — see "Verifying an install" in CONTRIBUTING.md.

**Window state is saved on `RunEvent::Exit` too, and for the same reason.**
`tauri-plugin-window-state` saves from its own window hooks, which `Cmd+Q`
never reaches — so the most common quit gesture on macOS would restore the
window to wherever it was two quits ago, silently. `save_window_state` is
called beside `end_all` for that reason. The flags are explicit rather than
`all()`: `DECORATIONS` would let a saved state fight
`tauri.windows.conf.json`, which turns the frame off on purpose, and `VISIBLE`
could restore a hidden window, which on a single-window app leaves no way to
get it back.

**A reload is the one browser shortcut this app cannot survive.** `Ctrl+R` or
`F5` reaching WebView2 reloads the page, which remounts every pane and discards
all of xterm's scrollback — while the PTYs carry on in Rust, so the sessions
live and the record of them does not. `tauri-plugin-prevent-default` swallows
it. The flag set is curated rather than `Flags::debug()`, and two exclusions are
load-bearing: `FOCUS_MOVE` is `Shift+Tab`, so blocking it breaks backward
keyboard navigation and the Level AA bar below; `CONTEXT_MENU` is the right
click the file tree's menu is built on, which is also what makes that menu
answer the Menu key and `Shift+F10`. `FIND` _is_ swallowed on purpose — the app
answers that key with its own scrollback search and the webview's find bar must
not get there first. `config_tests.rs` pins all four.

**`single-instance` is registered first, and it has to be.** The plugin's own
docs require it, and the cost here is higher than in most apps: a second
instance would restore the same tab list, spawn its own PTYs for every one of
them, and record into and sweep the same per-directory journal folders as the
first. Its callback also carries the second launch's `argv`, which is how
`muster ~/proj` reaches an app that is already open — and that only ever opens
a **pre-filled launcher**, never a spawned session, because the gesture asked
for a place to work rather than for an agent to be running in it.

**Cleanup runs on `RunEvent::Exit`, not on a window event.** `Cmd+Q` and the
app menu's Quit reach tao as `terminate:`, which emits only `LoopDestroyed` — so
no window ever sees `CloseRequested` or `Destroyed`, and anything hung off those
is skipped on the most common quit gesture on macOS. The confirmation prompt can
live on `CloseRequested`; ending the sessions cannot.

**A session must be forgotten when its child exits.** The pane stays mounted
behind the "session ended" overlay, so `pty_kill` never runs on a natural exit.
Without `Sessions::forget` in the reader thread the registry keeps dead entries,
and then the quit prompt counts tabs with nothing running and `end_all` signals
pids the OS may already have recycled. For the same reason `end_all` drains into
a vec before ending anything — `end` sleeps between `SIGHUP` and `SIGKILL`, and
holding the map guard across those sleeps blocks the event loop.

**Tab ids must be unique across runs.** They key the backend's PTY map, and
`pty_spawn` reads a reused id as "end that session and take its place". A
per-run counter restarts at 1, so a restored tab and a later `⌘T` would collide;
`crypto.randomUUID` is what makes restore safe.

**`allowTransparency` is set once and never changed.** xterm requires it before
`open()` and it cannot be changed without calling `open()` again — which would
respawn the PTY. So it is always on, and whether the grid is actually
transparent is decided by the theme's alpha. For the same reason every theme's
`background` must stay an opaque `#rrggbb`: the pane paints it behind the grid.

**Dispose the WebGL addon before the terminal.** The renderer has to release its
GPU context first, and `onContextLoss` must null the handle so cleanup cannot
double-dispose. A lost context with no fallback stops the terminal painting
entirely rather than dropping back to the DOM renderer.

**Nothing an agent names may reach a session as keystrokes.** `drop_text`
refuses any path carrying a control byte, because quoting is not the only
boundary in play: the text is delivered through xterm's bracketed paste, which
wraps it in `ESC[200~`…`ESC[201~` and does **not** strip an end marker embedded
in the middle. A filename holding that sequence — git stores arbitrary path
bytes, and an agent picks its own filenames — ends paste mode early, and the
rest arrives as typed keys with a carriage return to submit them. Balanced
quoting does not help, because the shell's line editor never sees quotes at
all.

**A pathspec must be literal.** `:(top,literal)<path>` in `review.rs`, never
`:/<path>`: the second leaves the rest as pathspec language, so a file an agent
named `:setup.sh` resolved to the tracked `setup.sh` beside it — an empty diff
for a new file — and `!x` inverted the match to the whole repository. Verify a
change here against a real name: `git ls-files -- ':/:AGENTS.md'` prints
`AGENTS.md`, and the literal form prints nothing.

**Nothing is read through a symlink, and the automatic reads are bounded.**
`read_capped` uses `symlink_metadata` and refuses a link, the same stance and
the same reason as `image.rs`: a repository can ship
`docs/notes.md -> ~/.ssh/id_ed25519`, and the line count for an untracked file
is read with no click at all. `MAX_COUNTED` bounds how many of those reads a
single revision can cause, and `git_changes` takes a `counts` flag so a caller
that will not show a number reads nothing at all — the click that opens a diff
from the terminal asks only which files differ, because a read is what raises a
filesystem permission prompt and asking for one before the panel is even open
is asking too early. Confinement lives at the callers that have no click,
not in the commands — `read_image` must stay unconfined, because the terminal's
overlay and the background picker legitimately point anywhere, while
`resolveAgainst` refuses a markdown image that climbs out of its document's own
folder.

**An editor installed on macOS usually has no shell command.** A bundle in
`/Applications` puts nothing on `PATH`: VS Code's `code` arrives only if the
user ran "Shell Command: Install 'code' command" from the palette. Probing the
command alone therefore reported one editor on a machine with three, and looked
like a working list rather than a broken one. `editor.rs` looks for the bundle
too, and launches through the tool inside it — `Contents/Resources/app/bin/…`,
which is what the shell command is a symlink to, so the flags are the same. The
tool is not always named after the command: Antigravity's editor is
`Antigravity IDE.app` with `antigravity-ide`, and the `Antigravity.app` beside
it is a language server that opens nothing. A bundle with no such tool falls
back to `open -a`, which takes no flags, so a line number is dropped there.

**A file drop is a window event, not an element's.** Tauri intercepts the drop
before the DOM sees it — `dragDropEnabled` is on by default — so there is no
target to hang a handler on and `onDragDropEvent` is the only way to see one.
Every mounted pane would otherwise answer the same drop, so only the active one
subscribes; the effect is keyed on `active` for exactly that reason. The text it
inserts is built in `platform::drop_text`, not in the webview: the quoting is
the session's shell's, and a WSL session needs the path translated the way
`--cd` translates it at launch.

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
URL as `data-url` for the same preview card the terminal uses, because the
webview has one window and a link would navigate the whole app out of it; and
images become `data-src` paths that Rust reads, never URLs the webview fetches.
Any change there is a change to what a file an agent wrote can do to the
window — treat the escaping, the missing `href` and the `data-src` as the
feature, not as detail.

Mermaid is the fourth thing, and it is not markdown-it's doing: a `click`
directive in a diagram becomes a real `<a xlink:href>` inside the SVG, and
`securityLevel: 'strict'` does not prevent that — it only picks the anchor's
`target`. `disarmLinks` moves the destination to `data-url` after every render,
so a diagram's links reach the same preview card as the document's. Anything
that replaces `innerHTML` with mermaid's output has to keep calling it.

**Mermaid and the syntax grammars must stay dynamic imports, and `build.ts`
must keep `splitting: true`.** Inlined, they make an 8 MB bundle the webview
parses before it can draw anything; split, the entry chunk is 1.3 MB and a
grammar is fetched when a file needs one. Nothing fails if the flag is dropped
— the app just starts slowly, which is the kind of regression nobody bisects.

**The review surfaces re-read on a revision derived from the tree, never on a
clock.** `treeRevision` in `features/workspace/model/status.ts` builds it from
git's own counts, and the changed-file list, an open diff and every expanded
folder key on it. A timestamp is what this started as, and because
`useWorkspace` polls every few seconds it tore an open diff down on every tick —
clearing it to a "Reading…" notice, losing the scroll position and re-tokenising
both sides through Shiki on the thread that draws the window, in every mounted
pane at once. The trade is that a second edit to an already-modified file moves
no count, which is what the panel's Re-read button is for. No timer here at all:
see the hidden-pane invariant, and note the panel is mounted only while open —
which is also why the click that opens it asks git directly rather than reading
a list that does not exist yet.

**Material icons ship as path data, not a webfont.** `src/shared/ui/icons.ts`
holds the `d` attributes traced from Material Symbols. A webfont would need a
`font-src` the policy does not grant, and an icon font that fails to load
renders tofu boxes rather than nothing — a failure that looks like a bug in the
app. The three `window_*` glyphs are the exception to the tracing: Material's
window icons are several times the weight of the hairline squares a titlebar
draws, so those are drawn to the same 960 grid rather than copied.

**Windows has no frame, and the two window configs must say the same things.**
`tauri.windows.conf.json` sets `decorations: false` — the tab strip is that
platform's titlebar, and a native caption above it reads as two stacked title
bars. macOS keeps its frame, because `titleBarStyle: Overlay` already puts the
tabs inside it and dropping the frame there would lose window snapping and
tiling; Linux keeps its desktop's decorations, because a GTK window with none
loses whatever its window manager alone provides, and nobody has run this on
enough of them to know what that costs.

Windows pays a smaller version of that cost knowingly: tao still hit-tests the
borders itself, so edge-drag resizing and `Win`+arrow snapping survive, but the
Windows 11 Snap Layouts flyout does not — it needs `WM_NCHITTEST` to answer
`HTMAXBUTTON`, which no `<button>` can. One row of chrome instead of two was
judged the better trade.

The trap is the merge. Tauri merges the platform file over `tauri.conf.json`
with JSON Merge Patch (RFC 7396) semantics, which **replaces** an array rather
than merging its entries — and `app.windows` is an array. So the Windows file cannot say only
"turn the frame off": it restates the whole window, and a size or a background
changed in one file would silently apply on two platforms out of three.
`config_tests.rs` fails when the two disagree.

**Nothing may put a control at the strip's far right.** That corner is close —
drawn by Windows before this app took the frame off, and by `WindowControls`
after — so a gear or a menu one pixel from it is a misclick that quits the app.
Settings sits at the end of the status bar instead, which is also why that bar
renders on every tab: a launcher tab has no session, and would otherwise have no
way to reach settings but the shortcut. The bar's own last item needs
`flex-none`, and something before it needs `min-w-0`, or a long branch name
pushes settings past the edge at the window's 620px floor.

**A styled scrollbar uses the `-webkit-` pseudo-elements, never
`scrollbar-color`.** WKWebView
draws macOS's overlay scrollbar and WebView2 draws Windows' opaque grey one in
the system's colours, so the same panel looked like two different applications.
`scrollbar-color` would not fix that but widen it: WebView2 honours it and then
ignores every `::-webkit-scrollbar` rule, while WKWebView's support for it is
newer than the macOS versions this app runs on. The cost, accepted knowingly,
is that a styled scrollbar is no longer an overlay on macOS — it takes its 10px
from the layout, as it always did on Windows.

Those two engines are the ones this was reasoned about and looked at. Linux's
WebKitGTK is a third, and nobody has checked it: if it ignores the rules, that
host keeps its GTK scrollbar and nothing breaks — so do not write that all
three match until someone has run it there.

**A panel's width is a preference, not a fixed size.** All three right-hand
panels — the review drawer, the file column, the history drawer — are dragged by
their edge, so none may be `flex-none`: with several open and dragged wide, the
flex row is the only thing left that can keep the terminal on screen, and it can
only do that if they are allowed to shrink. The `min-w-64` on the terminal's
column in `Pane` is the other half of that, and it belongs on the flex child
rather than inside `TerminalView` — fitted to zero columns, xterm resizes the
PTY to nothing. The width itself is remembered in `localStorage` rather than in
settings: the panels unmount when closed, so component state would forget it
every time, and it is direct manipulation rather than a row in the settings
pane. `storedWidth` repairs what it reads, because a panel three pixels wide
leaves no edge to drag it back with.

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

**A scroll needs a bounded box.** `overflow-y-auto` on a child of an
`overflow-hidden` parent never becomes a scroll container: the child grows to
its content and the parent clips it, so the list looks truncated and the wheel
does nothing. Put the overflow on the element that has the height — the
`min-h-0 flex-1` box that the drawer's list and the reader both are — never on
both it and a child.

**A patch must come back from git verbatim.** `workspace::git` ends in
`trim_end`, which is right for a fact — a sha, a branch name — and wrong for a
diff: a unified diff's blank context line is a single space, so trimming
deletes the diff's last rows for any file ending in blank lines, while its `@@`
header still promises them. That is exactly the region a reviewer reads when an
agent may have eaten a trailing newline. `git_verbatim` is the one to use for
anything whose whitespace is content.

**An overlay that closes on Escape must claim the key, not share it.** Several
surfaces listen for Escape on their own, and they stack: the file column, the
link card, the image overlay, and a width drag in progress. Listeners on
`window` all fire, so dismissing a card also closed the column behind it, and
cancelling a drag closed the panel being dragged. The rule: a transient surface
listens in the **capture** phase on `document` and calls `stopPropagation`, so
the topmost one answers and the rest do not. A surface that is per-tab must also
gate on `active` — every pane stays mounted, so an Escape typed at a TUI in one
tab was closing another tab's panel.

**Keep command-line building platform-independent.** POSIX, PowerShell and WSL
argv construction in `src-tauri/src/platform.rs` compiles on every target so
`cargo test` covers all three from any host. `cfg`-gate the _choice_ between
them and the process inspection, never the string building.

## Architecture

`src-tauri/` owns processes, git and the filesystem, and knows nothing about
tabs. The client is layered, and **the layers are the architecture** — not a
filing convention.

    app        the composition root, and wiring that belongs to no slice
    widgets    surfaces that compose several features
    features   one user-facing capability each
    entities   the vocabulary several features share
    shared     no business logic; talks to the outside world

**A module may import from a layer strictly below its own, and never from a
sibling slice on its own layer.** That single rule is the point of the whole
structure. Grouping by domain alone does not get you it: an intermediate layout
of flat `tabs/`, `terminal/`, `settings/` and `launch/` folders put
`tabs ⇄ terminal` and `settings ⇄ launch` into cycles within minutes, because a
component that renders several domains has no honest home among them. Layers are
what make the direction decidable.

Two consequences worth knowing, because both surprised us:

- **A component that composes several slices is not one of them.** `Pane.tsx`
  renders the terminal, the launcher, the settings pane, the status bar, the
  history drawer, the review drawer and the file column;
  `TabStrip.tsx` needs both the tab entity and the shortcut labels. Neither can
  live in a slice without importing sideways, which is what `widgets` is for.
- **Vocabulary sinks.** If two features need the same type, it belongs in
  `entities`; if two layers do, it belongs in `shared`. That is why the theme
  table and `useBackground` sit in `shared/lib` — the settings pane and the
  terminal both need them, and neither owns them.

Inside a slice, segments are named for **purpose**, not kind: `ui` for what
renders, `model` for logic, state and the types that describe them. There is no
`hooks`, `types` or `utils` folder anywhere: those name the essence of a file
rather than its job, so they tell you nothing when you are looking for code. A
hook lives in the segment whose work it does — `model` when it drives state,
`ui` when it is presentation.

The Rust side stays **one crate**. Warp splits its backend into some sixty, which
buys parallel compile units across hundreds of thousands of lines; at ~3,000 the
workspace plumbing and cross-crate visibility churn would cost more than they
save. Its sibling-test-file pattern is the part worth borrowing, and
CONTRIBUTING.md's "Where the tests live" covers it.

`shared` earns its name by never importing from above. Anything that needs a
domain type is not shared. `shared/lib` holds contained libraries with one focus
each, not a `utils` drawer; `shared/ui` holds presentation with no domain in it
at all — the icon set and the component that draws one.

**`test/layers.test.ts` enforces all of this**, because there is no ESLint here
and a rule nothing checks is a comment. It fails on an upward import, a
sideways one, and on `shared` reaching up.

`src/entities/tab/model/deck.ts` remains the place tab behaviour belongs: a pure
reducer over `Deck` that knows nothing about the DOM, where a test can reach it.
When you find yourself wanting a test for something inside a component, that is
the signal to move it into a `model` segment first.

## Style

- **Comments say why, never what.** Use the language's doc-comment form (TSDoc,
  `///` in Rust). Put the explanation on the shared helper, not at each call
  site. Prefer a better name over a comment, and extraction over both. Never
  describe what changed — comments describe behaviour, not history.
- **Hoist pure functions to module scope.** If it only depends on its
  arguments, it does not belong inside a component or hook.
- **One job per function**, 0–2 parameters, an options object past that.
  Intention-revealing names; no `Manager`, `Data`, `Info`, `Helper`.
- **Do not name a self-evident literal.** A constant earns its name by being
  computed, repeated, or opaque.
- **Prettier owns the formatting**, at 80 columns, with single quotes and no
  semicolons (`.prettierrc`). Do not hand-format around it, and do not argue
  with it in review — run `bun run format`. JSX attributes stay double-quoted,
  which is Prettier's own default and reads as the HTML it resembles.
- **Tailwind classes inline**, no `@apply` outside `src/app/index.css`'s base layer.
  Reach for the `@theme` tokens first (`canvas`, `chrome`, `surface`, `line`,
  `ink`, `muted`, `faint`, `brand`, `danger`). Raw hex is still in use where no
  token fits — the git-status chip colours, the palettes in `src/shared/lib/themes.ts`, an
  agent's `accent` — so prefer promoting a repeated hex to a token over adding
  another one-off.

## Accessibility

Level AA is the bar, and two habits carry most of it:

- **A control's name is what a screen reader reads, and content wins over
  `title`.** A status chip labelled `~24` needs an `aria-label` saying what it
  counts; an icon-only button needs one at all. Every `<button>` in the review
  surfaces has one or visible text.
- **Colour is never the only signal, and `aria-hidden` can remove the other
  one.** The diff's `+`/`-` glyph is decorative, so each added or removed row
  also carries an `sr-only` word — hiding the glyph without that left the tint
  as the sole carrier.

Async text — "Reading…", the changed-file summary — sits in a `role="status"`
region, because these replace each other as reads land and 4.1.3 is an AA
criterion.

A gesture that exists only on the right mouse button would fail 2.1.1, so note
why the file tree's menu does not: `onContextMenu` on a focusable element is
also fired by the Menu key and `Shift+F10`, which makes it a keyboard gesture
too. Hang one on a `<div>` and that stops being true — and having opened it
from the keyboard, the menu has to be usable from there, which is why
`shared/ui/ContextMenu` takes focus, moves on the arrows, and hands focus back
to the row it came from. It claims Escape in the capture phase for the reason
the Escape invariant above gives: the column underneath closes on Escape too.

The **syntax theme is the open contrast question**: measured against the app's
own background, vitesse-dark's dimmest token (`#666666`) is 3.12:1, and the
diff tints take it to 2.43:1 — under the 4.5:1 AA needs for body text. Tint
tuning cannot close that on its own; a higher-contrast theme is the lever, and
it is a visible change nobody has asked for yet.

## Tests

Bun's runner for the frontend, `cargo test` for Rust. Both are unit tests of
plain functions; there is no component or end-to-end layer, so a change to
component wiring is verified by running the app, not by a green suite.

- **Name a test as the behaviour it protects.** "closing the active tab focuses
  the one that slid into its place", not "test close".
- **Cover the edge that would actually bite** — an empty deck, a corrupt stored
  setting, a truncated `git` record, an unclosed quote mid-typing.
- **Loading anything persisted must be total.** `normalizeSettings` clamps,
  repairs and falls back rather than throwing: a bad stored value would
  otherwise leave the user no window in which to fix it.
- `test/setup.ts` supplies an in-memory `localStorage`, which Bun's test runtime
  lacks.

## Git

- **Do not commit unless asked.** Finish the change, leave it in the working
  tree, and report what you touched.
- **Never force-push, amend, or rebase anything already pushed.** Fix a pushed
  mistake with a new commit on top.
- **Never disable commit signing.** No `-c commit.gpgsign=false`, no
  `--no-gpg-sign`. If signing fails, fix the key setup or ask.
- Keep a change in one commit. There is no changelog.
- **Subjects are [Conventional Commits](https://www.conventionalcommits.org)**:
  `type(scope): summary`, where type is one of `feat`, `fix`, `docs`,
  `refactor`, `test`, `build`, `ci` or `chore`. Imperative mood, no trailing
  full stop. Nothing enforces this — there is no commitlint hook — so the
  convention holds only as long as you follow it. The body is where the
  reasoning goes: why the change, and what breaks without it.

## Scope

Change this repository only. If a fix seems to require editing a dependency or
another repo, stop and say so.

These are the seams for common asks:

- **A new agent** starts as one entry in `src/entities/agent/model/agents.ts`, but the roster is also
  pinned by `src/entities/agent/model/agents.test.ts` and written out in `README.md` and
  `package.json`'s keywords. CONTRIBUTING.md's "Adding an agent" lists every
  rule the tests enforce and every file that follows.
- **A session record** is `src-tauri/src/journal.rs` and the
  `src/features/journal` slice. Two files per session: the pty stream, and a
  `.meta` sidecar naming the agent and the agent's own conversation id. The
  sidecar is what makes a record actionable — our file is keyed on the _tab_,
  which outlives any one session, so only the id the CLI published can reopen
  a conversation. `resumeArgs` builds the argv from the agent's existing
  `resume` mode rather than a second table.
- **A new user-facing preference** is one field in `src/entities/preferences/model/settings.ts` — with its
  fallback in `normalizeSettings` — plus one row in `SettingsPane`.
- **A new font choice** is one name in `CANDIDATES` in
  `src/shared/lib/fonts.ts`, and it appears only on machines that have it.
  Neither webview can enumerate installed fonts — Chromium's
  `queryLocalFonts` needs a permission prompt and WKWebView lacks it entirely —
  so the list is a filter over known families, measured by laying out a probe
  string in `<candidate>, <generic>` and again in `<generic>` alone. Both
  stacks must end in the **same** generic, and that is the whole trick: an
  absent family falls through to it and the widths match. Ending the
  candidate's stack in a family that cannot exist instead — which this did at
  first — makes an absent candidate fall back to the engine's own last-resort
  face, which is _proportional_, so every missing family measures differently
  from a monospace baseline and is reported installed while the platform's real
  monospace is reported missing. Two generics are tried because a family whose
  metrics equal one of them is otherwise indistinguishable from an absent one.
  Two consequences worth keeping: a family nobody thought to list stays
  invisible however installed it is, and every stack must still end in
  `monospace`, because a stored choice outlives the machine it was made on and
  a proportional fallback misaligns the grid.
- **A new icon** is one entry in `src/shared/ui/icons.ts`; CONTRIBUTING.md's
  "Adding an icon" has where the path data comes from. A new file-type icon is
  one more line in `src/shared/ui/fileicon.ts`, and its test asserts every
  icon that table can return is one the set actually holds.
- **A new syntax-highlighted language** is one entry in `GRAMMARS` and one in
  `BY_EXTENSION`, both in `src/features/review/model/highlight.ts`. The test
  pins the second to the first, so a grammar id that does not exist fails there
  rather than silently rendering plain text.
