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
- **`.agents/skills/*/SKILL.md`** — the procedures an agent loads instead of
  reading this file end to end. A skill nobody maintains rots the same way a
  stale invariant does, and worse: it is copy-pasted rather than read. The
  `mcp-live-test` one describes the terminal surfaces, so a change to how they
  are drawn or measured belongs in it.
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

**The shell is not in any agent picker.** A stored `defaultAgentId`, a restored
tab and a resumed session can all still carry `shell`, so `agentById` must keep
resolving it while everything that _displays_ a selection goes through
`pickableAgent` — see its doc comment for why. Both the launcher and the
settings pane read `defaultAgentId`, so both need it; guarding only one leaves a
`<select>` on a value no option carries, which renders blank.

**Closing the last window exits the app; minimizing it does not.**
`tauri-runtime-wry` emits `ExitRequested` when the window list empties and
nothing here calls `prevent_exit`, so there is no window-less state to rebuild
from — anything written against one is unreachable. `RunEvent::Reopen` is still
worth handling, because a _minimized_ window keeps the app alive and the Dock
click arrives there with `has_visible_windows: false`, which suppresses
AppKit's own deminiaturize. `unminimize` is the call that restores it: tao's
`set_focus` is a no-op while miniaturized and `show` will not restore one
either, so without it the click does nothing at all. The `show` and
`set_focus` beside it are not redundant — a window can also be hidden or
merely unfocused, and they are what answers the click then.

**A blocked directory is not a missing one, and `metadata` cannot tell you
which.** It only stats, so an unreadable directory still answers
`is_dir() == true` — the first version of this gated the check on `!is_dir()`
and therefore skipped every case it existed for, silently. `is_unreadable` asks
`read_dir`, and `Workspace::denied` is the answer — but only when the caller
asks for it, for the reason the `workspace_info` invariant below gives. The
launcher's response to _missing_ is to offer to create it, which for a
directory full of someone's work reads as the app having lost it.

**Blocked warns; it does not refuse.** `read_dir` answers "cannot be listed",
which is not the same question as "cannot be worked in": a directory with
search permission and no read permission (`0311`) takes a `cd` and opens every
path already known, so refusing there blocks a session that would have run.
The warning has to survive the click that raised it, though — `onLaunch`
replaces the whole launcher with the terminal — so the first click on a
blocked directory only warns, and the second goes through. The `warned` ref
records which directories have been warned about, kept apart from the
`blocked` notice so that dismissing the notice leaves the acknowledgement
standing, and a ref rather than state so a second click sees the first one's
answer without waiting for a render.

The hint that follows is per-host because the hosts differ in kind, not wording
— `blocked.ts` holds the three, and its tests pin that only macOS blames a
prompt. That macOS case is not hypothetical here: the app is ad-hoc signed, so
TCC keys its grants to the binary's hash and every release is new code with no
permissions.

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

**Dispose every addon before the terminal, and hold a handle to each so you
can.** `Terminal.dispose()` tears `_core` down and only _then_ lets its addon
manager dispose whatever is still registered — so an addon that reaches through
`_terminal._core` dereferences what was just freed and throws
`undefined is not an object`. The image addon reads `_renderService`,
`_inputHandler`, `screenElement` and more; fit reads the render service. This
cost a crash on closing a tab, because the image addon was loaded anonymously
(`term.loadAddon(new ImageAddon({…}))`) and there was no handle to dispose
first.

TypeScript cannot see any of it: `dispose()` is typed `(): void` on both sides,
so the whole failure is invisible until a tab closes. Disposing an addon
explicitly is safe — `loadAddon` replaces `addon.dispose` with a wrapper that
early-returns when already disposed and splices the addon out of the manager's
list, so nothing is disposed twice.

The renderer keeps its place at the front of that queue: WebGL has to release
its GPU context first, and `onContextLoss` must null the handle so cleanup
cannot double-dispose. A lost context with no fallback stops the terminal
painting entirely rather than dropping back to the DOM renderer.

**`@xterm/addon-webgl` is pinned exactly, and nothing else pins the rest.** The same reach through `terminal._core` is why: the addons ship on their
own version lines, none declares a peer range tight enough to catch a
mismatch, and a field renamed upstream reads as `undefined` rather than
failing. `@xterm/addon-webgl@0.19.0` is built for xterm 6, where `Disposable`
holds a `_store`; beside xterm 5.5.0, which still calls it `_disposables`, the
only line that reads it is the addon's own dispose callback — so every
terminal rendered correctly and closing a tab threw, on every close, whatever
the dispose order. So the pin is `0.18.0` — the build that pairs with xterm
5.5.0 — exactly rather than ranged;
the other five addons and the core keep `^` ranges, and `test/xterm.test.ts`
is what stands behind them — it fails when an addon names a core field this
xterm does not have. Read its doc comment before trusting a green run: the
bundles are minified, so it sees only the literal `_core.x` spelling and not
the aliased reads that most of them compile to.

**Ligatures are activated with the Local Font Access API hidden.** The addon
reads a font's real ligature set through `queryLocalFonts` where the browser
has it and falls back to a fixed programming set where it does not — and
WebView2 has it while WKWebView does not, so activating it plainly would raise
a font permission dialog on Windows alone, at startup, for something the user
did nothing to ask for. `withoutLocalFonts` deletes the property for the
duration of `loadAddon` and puts it back, which is the same stance as the
native font enumeration below and has the side effect of making one host's
ligatures match another's. The version is the last on the xterm 5 line
(`0.9.0`, peer `^5.0.0`); `0.10.0` declares no peer at all, which is the trap
the pinning invariant above describes.

**`workspace_info` does not add a `read_dir` unless it is asked to.** `denied`
costs one, and `read_dir` is enumeration where `metadata` is a stat — on macOS
enumeration is what raises the TCC prompt. This does not make the command
prompt-free: `git_status` runs `git status` on the same path either way, and
that walks the tree in a child process. What the gate removes is the app's
_own_ enumeration, on a timer, of a directory nobody asked about. The status footer polls this
same command on a timer _and_ on window focus, in every mounted pane, against
the directory the **agent** has since `cd`-ed into; the only caller that reads
`denied` is the launcher, on a click. So `probe` defaults to off, and the
first version of this — which computed it unconditionally — put a permission
dialog on screen at a moment the user did nothing to cause, where a reflexive
"Don't Allow" is remembered and unrecoverable. That is the state `blocked.ts`
exists to explain, so causing it would have been the feature defeating itself.
Same shape and the same reason as `git_changes(counts)`.

**A user's own messages are found by cell attribute, not by text.** A CLI
draws the prompt you typed as a tinted block, and that tint is the only thing
in the stream that marks it: the prompt characters differ per agent and change
between releases, so matching them dates immediately. `findMessageRows` reads
`isBgDefault()` off the buffer instead, so it needs to know nothing about any
particular CLI.

Only Claude Code has been measured, though: of 93 recorded sessions on this
machine 76 carry a background SGR and all 9 shell sessions carry none, and no
other agent has ever been run here. "Works for any CLI that tints its prompt"
is the design, not a result — do not write it as one.

It reads the **buffer**, never the DOM — the WebGL renderer paints the grid
onto a canvas, so there are no nodes to query, which is the same reason
`pathLinks` walks `term.buffer.active`. It recomputes on `onWriteParsed`
coalesced into a frame, gated on `active`: every pane stays mounted, so a
hidden tab would otherwise walk its own scrollback on every write for a rail
nobody is looking at.

**Two surfaces mark your messages, and they answer different questions.**
`useRulerMarks` puts a decoration in xterm's overview ruler, which overlays the
scrollbar and is drawn against the same scroll extent — so those marks carry
each message's **true position** in the session. `MessageRail` draws its own
bars **evenly spaced**, because proportional marks put every message of a long
session into the same few pixels and read as one smudge: the rail is a list of
places, not a map of them.

The rail exists because the ruler cannot do its job. `OverviewRulerRenderer`
registers decoration, buffer and dimension listeners and **no pointer
handler**, so a mark there can never take a click; and xterm sets that canvas
to `display: none` whenever the alternate buffer is active.

That second clause is what `SCROLLBACK_ENV` in `pty.rs` exists to answer, and
it is worth being exact about: a full-screen TUI holds the alternate buffer,
which is `rows` tall and keeps no scrollback, so there is nothing to mark, no
ruler to mark it in, and one screen for the find bar to search. Neither
surface has anything to show in an agent tab unless the agent is kept out of
that buffer, so every session is spawned asking for the normal one — the same
session went from one screen to 24,000px of scroll extent and the rail filled.

Two things about that hold whatever else changes here. The variable is
undocumented and read by Claude Code alone, so any other agent that holds the
alternate buffer has no rail and no path strip, and there is no measurement
here saying otherwise. And it must never join
`INHERITED_SESSION_MARKERS`: the strip loop runs after the environment is
set, so a variable in both lists is removed by the line that follows the one
setting it, which reads exactly like working.

`MessageSteps` walks the identical list `useMessages` returns, so the number of
dots and the number of presses always agree — that is the property to preserve
if either surface changes. The rail sits clear of the scrollbar rather than
over it, and `pointer-events-none` on its column with `auto` on each dot keeps
the gaps inert either way.

The list is capped at `MAX_MARKS`, derived from the shortest pane the window's
420px floor allows: past that the oldest dot would be clipped while the step
buttons still walked it, so "one press per dot" would quietly stop being true.

What the list cannot hold is history the tint never marked, and a **resumed
session is mostly that**. Measured on a `--continue` of a 977-row transcript:
the stream carried 1,206 background SGRs spread evenly through it, and the scan
found five marks — the banner and the last four prompts. Claude Code redraws
older turns without the tinted prompt block, and most of those SGRs are diff
gutters rather than prompts. So the marks describe the live part of a session,
not its history; a plain shell, whose prompt carries no tint at all,
contributes nothing at any point. Matching the prompt glyph instead is the
thing that dates immediately, so there is no cheap fix here — only a different
signal, and `OSC 777`'s `prompt_submit` arrives for live turns alone. And what it _can_ be made to hold is anything
tinted: `isTinted` reads a cell attribute, so a coloured diff gutter, a
line-number column or an agent's own banner produces an entry indistinguishable
from a message you typed — which is why the label is presented as what was
found rather than as something you wrote. Measured across 91 recorded sessions on this
machine, no shell emitted `OSC 133` semantic prompt markers, so there is no
standard signal to fall back on.

`overviewRulerWidth` is still set on the terminal and is load-bearing there.
Left unset it defaults to 0, and every decoration asking for a ruler mark is
silently dropped — including the search addon's `matchOverviewRuler`, which is
what puts a find result on the scrollbar.

**xterm only writes the scroll area's height when its own record disagrees
with it.** `Viewport` caches the height it last wrote in
`_lastRecordedBufferHeight` and skips the write when that still matches — so an
inline height reset behind its back is never repaired, and the scrollbar keeps
the size it had when the session was one screen tall. Measured on a real
session, the cache read 8137 rows while the element's inline style read 657px,
and the thumb was full height over a 20,000-line scrollback. `resyncScrollbar`
in `TerminalView` re-asserts the height xterm already computed, from the
screen's own layout rather than a cell metric — the WebGL renderer draws to a
canvas and leaves no per-row element to measure. It is a normal-buffer fix and
only ever raises the height, so a shrink is left to xterm's own next write.

It is not free, though: it runs per write batch rather than per frame, and the
two `querySelector`s and the `offsetHeight` read force a layout each time. That
is why it returns immediately unless its pane is on screen.

**A turn ending is announced two ways, and Claude Code never uses the bell.**
`onBell` was the only signal wired to notifications, and measured across 24
recorded sessions the bell fired **zero** times — every `0x07` in the stream
was an `OSC` string terminator, not a bell. Claude Code broadcasts
`OSC 777;notify;warp://cli-agent;<json>` instead, carrying `session_start`,
`prompt_submit`, `tool_complete` and `stop`; `stop` is the turn boundary, and
its payload carries the agent's own closing words — which become the
notification body — alongside fields `parseAgentEvent` deliberately drops,
its transcript path among them.
`parseAgentEvent` reads it and `Pane`'s `signalAttention` is where both routes
meet, so an agent that rings _and_ broadcasts notifies once — the cooldown in
`decideBellResponse` is what makes that true.

Nothing here is configured: the sequence is in the pty stream Muster already
records, so no hook, plugin or transcript read is involved. The cost is that
the payload is **agent-authored JSON arriving over a terminal escape
sequence**, which is why `parseAgentEvent` answers `null` for anything
unexpected rather than throwing inside xterm's parser, and why it caps the
text it carries — an unbounded `response` becomes the body of a desktop
notification. Treat the field checks as the feature, not as detail.

**A width change destroys a TUI's scrollback, so the scrollback is dropped
rather than shown.** This is the price of `SCROLLBACK_ENV` above, and it has to
be stated next to it: the normal buffer is the only one xterm reflows, so
keeping an agent out of the alternate buffer is also what exposes its history
to re-wrapping. An agent pads every frame to the full width, so a narrower grid
spills each padded row into a second one and the transcript above the live
frame becomes offset blocks. Measured: narrowing a pane from 1883px to 1120px
took one session's scroll extent from 21,060px to 30,096px, and widening it
back gave 21,870 — reflow is lossy, so even the round trip does not undo it.

Nothing can repair those rows. xterm's buffer holds cells with no memory of
where the original breaks were, and the journal is not a transcript but a
width-specific render log — one recorded session holds 14,628 absolute column
moves, so replaying it into a different width would misplace every one of
them. So `sync` clears on a `cols` change and the ⟳ beside the step buttons reopens
the session with the agent's own `continue`, which is the only thing that can
print the conversation again at the width it now has. Verified: a clear took a
tab to one screen and the button brought it back to 15,066px with its marks.

`reflowRuins` is what decides, and it excludes two sessions for one reason:
`Terminal.clear()` keeps **only the cursor's line**, not the visible screen. A
plain shell's wraps are genuine, so its scrollback reflows correctly and has
nothing to repair — clearing it would throw away good history and blank the
screen of the one session that does not repaint on `SIGWINCH`. An agent still
in the alternate buffer has no scrollback to damage, so its `rows` of frame are
all there is to lose. The control is passed only where a `continue` mode
exists, so a shell is not offered a button whose click would do nothing.

What survives a clear is the machinery, and that is worth knowing because it
is not obvious: the scan is subscribed to `onWriteParsed` for the life of the
mount, so output written after a resize is marked as usual — a cleared tab
still painted 702 pixels of file marks from the agent's repaint. Only the
history is gone.

**Tabs and settings belong to the app, not to a window.** They live in
`state.json` beside the journal, written by `store.rs`, because `localStorage`
is per-origin: every window of the app shares one copy, so two windows editing
tabs would overwrite each other, and anything that clears site data takes the
tab list with it.

The whole store is read once, before the first render — `main.tsx` awaits
`loadAppState`, and a component that read state earlier would see an empty
store and restore a blank deck over a real one. Callers keep their synchronous
shape because reads are served from that cache; only writes leave the webview,
and `store.rs` persists each one as it arrives via a temp file and a rename, so
an interrupted write cannot leave a half-written file that parses as empty.

Per-window preferences stay in `localStorage` on purpose: a panel width dragged
in one window must not move in another. That is the test for where a value
belongs — is it the app's, or this window's?

**The path beside the scrollbar is searched upward, never scanned.** Agent
CLIs announce each file they touch on its own line, so `fileAbove` walks _up_
from the viewport to the nearest one and stops, bounded by `LOOK_BACK`. It runs
on every scroll, so a full-buffer scan of the kind `findMessageRows` does would
be the wrong shape here: only the nearest match matters and it is usually a few
rows away.

**Which line that is was guessed wrong once, and the guess cost the whole
feature.** `TOUCHED` began as `Update(path)`, `Write(path)`, `Read(path)` —
the shape a tool call reads as — and the label then stayed blank for a whole
session while looking exactly like a layout bug. Measured over 4.1 MB of
recorded sessions here, Claude Code names the file **after** the fact and with
a space: `Updated` 320 times, `Created` 44, `Deleted` 7, and `Read(…)`,
`Write(…)` or `Update(…)` not once. So the past-tense form is first and the
parenthesised one is kept only for the CLIs that write it. Two consequences
to preserve: `Bash(…)` — the one parenthesised header Claude Code does print,
25 times — must stay out of the verbs, because it names a command; and the
past-tense form must require an extension on the path, or a sentence about
having updated something reads as a filename. Verify a change here against a
journal file, never against what a tool call looks like.

It reads the rendered row, not the pty stream. The stream interleaves cursor
moves mid-path — the same recordings hold `Updaed`, `Updatd` and `Udated`,
which are one word torn by a cursor move — so matching the raw bytes would
find a truncated path; the buffer holds what was actually drawn. What it drew
is not always a path, though: an agent elides one too long for its column to
`Read(…)`, so a capture with no letter or digit in it is skipped and the walk
carries on upward.

The label rides the scrollbar rather than sitting still, at
`viewportRow / baseY` of the pane's height — the ratio the bar draws itself
from — so it reads as a label on the bar. It keeps `STEPS_RESERVE` of the
bottom edge clear, because the one place it must never come to rest is on top
of the step buttons. Clicking it opens the file through the same `onPath` a
path clicked in the output goes through, which is why `fileAbove` answers with
both forms: the tail is what fits beside the bar, and the printed path is what
`resolvePath` can turn into a file.

**`findFileBlocks` scans where `fileAbove` walks, and the two are not
interchangeable.** The label answers "what am I looking at" for one position,
so it stops at the first match above the viewport; the ruler marks answer
"where did the work happen" for the whole session, so they need every match and
scan like `findMessageRows` does, on the same `MAX_SCANNED` bound and for the
same reason. A file touched twice is two marks — deduping would hide the second
edit, which is a place in the session.

File marks take the ruler's **left** lane and messages keep the full width.
That is what tells the two apart by shape as well as by colour, which the
accessibility bar asks for; it is _not_ what protects the message marks —
`_refreshDecorations` draws every non-`full` zone and then every `full` one
over the top with an opaque fill, so a message mark wins a shared row whatever
lane the file mark takes. Both go through `useBufferMarks`, whose identity
preservation is load-bearing rather than tidy — a fresh array per write batch
would dispose and re-register every decoration in the ruler on every frame of
output.

**A file mark is a span, and both of its bounds were got wrong once.** The
ruler has no tall mark: `ColorZoneStore.addDecoration` reads `marker.line` and
ignores a decoration's `height`, so a span is drawn by sampling it at the
padding the store merges within — `floor(bufferLines / (canvasHeight - 1) *
markHeight)`, which `strideFor` reproduces rather than estimates. Estimating
it as one row per drawn pixel made the stride ten times finer than needed, the
newest block spent the whole decoration budget, and every older mark vanished
from the bar; the budget is now shared per mark for the same reason.

At the other end, a block left to run to the next header tiled the scrollback
and painted 93% of the bar one colour. `MAX_BLOCK_ROWS` is small because the
ruler is already generous: its minimum mark is
`clamp(canvasHeight / bufferLines, 6, 12)` device pixels, so one row is
already a band and the span's only job is to make a large edit read taller
than a one-line one. This is where the bar and the label part company on
purpose — the label attributes every row to the nearest header above it, and
the mark covers only where the file was touched.

**A tab's status is measured, not announced.** `isWorking` reads one thing:
whether the session has printed in the last `QUIET_MS`. Every CLI writes to
the pty while it thinks and goes quiet when it wants you, so this needs nothing
from the agent — which matters, because on this machine only Claude Code has
ever been observed announcing anything about itself, and eight of the nine
agents in the roster have never been run at all.

`TerminalView` reports the two edges rather than every chunk: a busy session
would otherwise dispatch a deck action per write batch. `unknown` is the state
before a tab has printed anything, and it is not the same as idle — a tab that
has said nothing must not claim to be idle.

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

**`build.ts` must keep both its flags.** `define` sets `import.meta.env.DEV`
to `false`, and without it Bun leaves that expression in the bundle — where
`import.meta.env` does not exist, so the guard in `main.tsx` reads a property
off `undefined` and throws before `createRoot` renders anything. Every release
would open a blank window, and `tsc` stays green because `@types/bun` declares
the property. It is also what keeps the MCP plugin's client code out of
`dist/`. Bun's dev server defines the same expression as `true`, which is why
`bun run dev` never shows it. This is the one place that mechanism is written
out; `build.ts` and `main.tsx` point here rather than restating it.

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

**A styled scrollbar uses the `-webkit-` pseudo-elements, never
`scrollbar-color`.** WKWebView
draws macOS's overlay scrollbar and WebView2 draws Windows' opaque grey one in
the system's colours, so the same panel looked like two different applications.
`scrollbar-color` would not fix that but widen it: WebView2 honours it and then
ignores every `::-webkit-scrollbar` rule, while WKWebView's support for it is
newer than the macOS versions this app runs on. The cost, accepted knowingly,
is that a styled scrollbar is no longer an overlay on macOS — it takes its 10px
from the layout, as it always did on Windows.

The thumb also carries a `min-height`, and that is not decoration: a thumb is
drawn in proportion to how much of the content is on screen, so a screenful
against a 20,000-line scrollback is a few pixels tall — present, correct, and
invisible. It reads as "the terminal has no scrollbar".

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
- **`async`/`await` over `.then()`**, and give the async function a name at
  module scope rather than writing an inline `void (async () => {…})()` — an
  IIFE buries the body in its call site. `main.tsx`'s `listenForMcp` is the
  shape.
- **Reach for `useEffect` last.** It is right for synchronising with something
  outside React — a PTY, a DOM node, a drop listener — which is most of what
  `TerminalView` does. It is wrong for a value that can be derived while
  rendering. When you do write one its dependency array must be complete: there
  is no ESLint here, so a missing dependency fails silently, and an effect
  written with no array at all re-runs after every render. The rule is to reach
  for a solution that needs no effect, never to leave an effect's array off.
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

## TypeScript

`strict` is on, with `noUnusedLocals`, `noUnusedParameters` and
`noFallthroughCasesInSwitch` (`tsconfig.json`). There is no ESLint, so the
compiler is the only automatic check there is — which makes every escape from
it worth more scrutiny than usual.

- **Never `any`, and never `@ts-ignore`.** `unknown` plus a narrowing check is
  the replacement; `normalizeSettings` and `normalizeDeck` are what that looks
  like on data from `localStorage`.
- **A type assertion (`as T`) is a claim the compiler cannot check**, so it
  needs a reason the way an invariant does. `JSON.parse(x) as T` is the common
  wrong one: it asserts a shape over a value that crossed a serialisation
  boundary. If the value never had to leave the program, keep it in a ref and
  serialise only for the comparison — see `useCollisions`.
- **Prefer narrowing to `!`.** A non-null assertion inside JSX usually means a
  conditional could have been a component taking the narrowed type; that is
  what `SettingsButton` is for. `!` is still right where a ref is filled by
  construction before anything reads it.
- **Type what crosses the IPC boundary once, in `shared/ipc.ts`**, and let
  every caller infer. A `#[derive(serde::Serialize)]` struct and its interface
  are two halves of one wire format that nothing checks against each other, so
  a field added on one side must be added on the other in the same change.
- **None of this catches a lie told by a dependency's types.** `dispose(): void`
  is honestly typed and still throws — see the addon invariant above. Where a
  library's contract is about _order_ rather than shape, only a comment and a
  test protect it.

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
- **A new font choice** is not a code change any more, and the monospace
  decision belongs in Rust. `src-tauri/src/fonts.rs` enumerates the installed
  families and marks each one, because neither half can be answered in the
  webview: Chromium's `queryLocalFonts` needs a permission prompt, WKWebView
  lacks it entirely, and the monospace flag lives in the font file.

  Measuring it instead — laying a narrow glyph run against a wide one on a
  canvas — is the thing that does not work, and it fails in a way that looks
  like success. A family with no Latin glyphs substitutes for _both_ probes,
  so the two come back equal and it reads as fixed-pitch: that put 60 of this
  machine's 248 families in the picker where 11 belong, and it answers
  differently per engine, so a green run in one proves nothing about the other.
  Warp solves the same problem natively and this follows its shape — enumerate,
  drop what cannot draw Latin, take the font's own flag — down to OR-ing the
  flag across a family, because Osaka ships both fixed and variable faces and
  the picker has to give one answer.

  The cost is seconds, since the flag means loading one face per family, so it
  is computed once — on the click that opens the picker, and never before. An
  earlier version warmed it at launch, which made a system-wide read of
  attacker-plantable bytes (`~/Library/Fonts` and `~/.local/share/fonts` are
  writable by anything running as the user) happen with no user action, in the
  process that owns every PTY, through CoreText, DirectWrite or FreeType. That
  is what the "automatic reads are bounded" invariant above exists to prevent,
  and `panic = "abort"` meant a malformed font could not degrade to the
  fallback list — it took the app down before any window existed, symbols
  stripped. `CANDIDATES` in
  `src/shared/lib/fonts.ts` survives only as the fallback for a host whose font
  source is unreachable — adding a name there changes nothing on a machine
  where enumeration works, so never reach for it to fix "my font is missing".
  That was the old design's failure: the list held `Operator Mono`, the machine
  had `Operator Mono Lig`, and an exact-name filter called it absent.

  Two things still hold. Every stack must end in `monospace`, proportional
  choices included, because a stored choice outlives the machine it was made on
  and a missing family must degrade to a fixed pitch rather than to the
  engine's proportional default. And the picker hides non-monospaced families
  behind the `allSystemFonts` setting rather than dropping them — Warp answers
  that with the same checkbox.

- **A new icon** is one entry in `src/shared/ui/icons.ts`; CONTRIBUTING.md's
  "Adding an icon" has where the path data comes from. A new file-type icon is
  one more line in `src/shared/ui/fileicon.ts`, and its test asserts every
  icon that table can return is one the set actually holds.
- **A new syntax-highlighted language** is one entry in `GRAMMARS` and one in
  `BY_EXTENSION`, both in `src/features/review/model/highlight.ts`. The test
  pins the second to the first, so a grammar id that does not exist fails there
  rather than silently rendering plain text.
