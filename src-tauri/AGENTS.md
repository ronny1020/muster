# AGENTS.md — the Rust backend

The invariants for the Rust backend — sessions and their PTYs, the shell integration scripts, git, the journal and transcript reads, windows and their lifecycle, and the platform-specific command lines. The repository's conventions, and an index of
every invariant, are in the root [AGENTS.md](/AGENTS.md); read that first.

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

**Sessions run through a login shell — and where they cannot, they imitate
one.** A GUI app inherits a bare `PATH` — from launchd on macOS, from the
desktop session on Linux — so a CLI installed by the user's profile (`mise`,
`nvm`, `~/.local/bin`) is invisible until the shell's rc files have run. On
Windows the reason differs: PowerShell resolves the `.cmd` and `.ps1` shims
npm-installed CLIs ship as, which `CreateProcess` alone will not find.

The one exception is a **bash** session with shell integration on, because
bash ignores `--init-file` for a login shell: `-l` is dropped and the script
sources `/etc/profile` and the first profile itself. What must stay true is
the `PATH`, not the flag — see the shell-integration invariant below.

**An agent tab hands its terminal to a shell, and the agent never learns.**
Quitting an agent lands on a prompt in the same terminal and directory, as
quitting it anywhere else does. The agent runs `exec`ed over the login shell,
as every agent session does, and a small `/bin/sh` above it holds the
terminal: when the agent exits, that `sh` resets the modes and the tty settings a
crashed TUI leaves armed, announces `OSC 777;muster-handback;<token>;<status>`,
and `exec`s the login shell in place (`platform::hands_back`, `handback_line`).
Six things about that shape break silently.

The pty's child has to outlive the agent. Spawning a second child on the same
pty does not work — when the first child, the terminal's session leader,
exits, the kernel hangs the terminal up and portable-pty's slave descriptor
answers `EBADF` to the next spawn. The `sh` is what keeps a session leader
there throughout.

The agent is the `sh`'s child, not the pty's, so anything that looks an agent
up by pid looks one level down: the session-id watcher asks
`platform::children_of` as well, because Claude Code publishes its session
under its own pid — without that the id is never found, and Resume and the
transcript rail silently lose the conversation.

The agent shares the `sh`'s process group, so the terminal's Ctrl+C and
Ctrl+\ reach both — and dash, `/bin/sh` on Debian, Ubuntu and most WSL
distros, dies of one even when the agent catches it, ending the session
instead of handing it back. `trap : INT QUIT` is what keeps it; a handler
rather than `trap ''`, because an ignored signal is inherited by the agent.
The test that pins it runs the signal in a process group of its own — in the
runner's group, `kill -INT 0` interrupts the runner.

The reset saves the cursor before it leaves the alternate screen, which
restores one, in xterm.js even when that screen was never entered, so without
the save a Scrollback session — which never enters it — would have its prompt
drawn over the top of the output. And it is written `\00337`, not `\0337`,
which `printf %b` reads as one octal escape.

The announcement is ordinary bytes, so it carries a token only the `sh` has:
`pty_spawn` hands it over in `MUSTER_HANDBACK`, the `sh` unsets it before the
agent starts, and `TerminalView` believes nothing without it — otherwise an
agent, or a file it printed, could end the tab's agent phase while it ran. A
WSL session gets the token through `WSLENV` and runs its line with
`wsl.exe --exec`, because after `--` the line reaches the distro user's
default shell as text, which expands `$code` too early and fails outright
under fish. A believed announcement sets the tab's `handedBack`, and from then on `Pane`
resolves what the tab runs as the shell: the Clicks/Scrollback control and the
⟳ go, since both end the session to reopen the conversation and would take the
user's shell and whatever it is running with them, the transcript is no longer
read, the status bar, its notifications and a later ended bar say Shell, the
tab takes a shell's colour, and the journal drawer offers the tab's own
record, since the conversation in it has ended. In a session that hands back, a
`pty://exit` means the shell ended, never the agent. PowerShell gets no
hand-back at all — with nothing to announce it, the tab could not stop treating
the prompt as the agent's, so there the session ends with the agent. The kill
signals the terminal's foreground group as well as the spawn group: the agent
shares the spawn group, but the shell after it runs each command as a job in a
group of its own.

The shell after the agent takes the shell integration a plain shell tab would,
and on the `sh`'s own command line (`platform::shell_after`) rather than the
session's environment: a `ZDOTDIR` there would send the agent's own login shell
through Muster's startup files too. `TerminalView` holds its `OSC 133` off until
the hand-back is believed, for the reason the gate below gives.

The git writes the drawers make — commit, pull, push, checkout — are not
sessions, but they run the user's programs too: a husky hook calling `bunx`, a
git-lfs `pre-push`, `gh` as a credential helper. So `sync::login_path` borrows
the login shell's `PATH`, read on the first click that needs it and bounded by
a deadline, because it runs the user's startup files; a success is kept and a
failure retried after a minute. Without it the same commit
passes under `bun run dev`, which inherits a terminal's `PATH`, and fails from
the Dock.

**A git write is stopped by the thread that waits for it.** `finish` polls its
own child rather than handing a pid to `git_cancel`, because a pid another
thread signals may have been reaped and reused. The child leads a process group
of its own (`without_terminal`'s `setsid`), and `terminate` sends that group
`SIGTERM` before `SIGKILL`: the hook or `ssh` git is waiting on is what has to
stop, and git removes its `index.lock` on `SIGTERM` but not on `SIGKILL`, which
would leave every later command in the tree refused. Windows has no group
signal, so `taskkill /T` there is forcible, and a lock can be left.

The output is drained on threads that `Drain::finish` waits for only briefly,
and that is load-bearing: a hook's background job inherits the pipe, and
joining the reader until it closes would hold every later git write in the app
— the login-`PATH` read sits in front of all of them — behind a
process that may run for hours.

**No git the app runs may take its repository from the environment.**
`workspace::git_in` removes `REPOSITORY_OVERRIDES` from every git child, and the
login shell above loses them too, since its prompt runs git. Git exports
`GIT_INDEX_FILE` to its hooks and this repository's pre-commit hook runs the
Rust tests — so a test's `git add --all` in a scratch repository would have
written the scratch tree over the commit being made, and nothing would have
failed until that commit landed.

**Paths are stored in the host's own form.** A WSL session keeps the Windows
path the picker returned — a `\\wsl$\Ubuntu\...` share or a drive letter — and
translates to `/home/...` or `/mnt/c/...` only at launch, for `wsl.exe --cd`.
One representation is what keeps `git`, the folder picker and the file-manager
button agreeing with each other.

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

**`Channel` payloads must be owned.** PTY output goes over
`Channel<InvokeResponseBody>` and sends `InvokeResponseBody::Raw(...)`. A
borrowed `&[u8]` cannot outlive the command, and the reader thread needs it to.

**Closing the last window exits the app; minimizing it does not.** Closing
the last _tab_ closes its window, as in Chrome, through the same close prompt
— so on the last window it quits. `tauri-runtime-wry` emits `ExitRequested` when the window list empties and
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

**An empty list of past conversations means "let the CLI pick", never "there is
nothing".** Two commands read the same store and answer differently on purpose.
`agent_sessions` counts, and is three-valued, because a caller hides a control
on a zero. `agent_session_list` lists, and is not: it answers empty for a store
this process does not read, for a WSL distro, and for a directory with no
history alike. That is only safe because of what the caller does with it — the
start screen falls back to launching the agent's own `--resume`, which is what
every agent did before the list existed, so an unreadable store costs the
picker rather than the mode. Disable the mode on an empty list and Codex, the
only other agent with a `resume`, silently loses it — while Claude Code, the
one store that is read, goes on working. The count is what greys the button
out, and it is the one that can tell "unknown" from "empty".

Two consequences. The list is read on the **click**, never beside the count:
the count is re-read on every keystroke in the directory field, while each row
of the list costs a bounded read of a transcript's head for the line it
carries. And whether history was left out is answered by the **listing**, which
is the only thing that knows what it dropped — the count applies none of the
list's filters, so comparing the two offers a picker for a directory with
nothing more in it.

**Window state is saved on `RunEvent::Exit` too, and for the same reason.**
`tauri-plugin-window-state` saves from its own window hooks, which `Cmd+Q`
never reaches — so the most common quit gesture on macOS would restore the
window to wherever it was two quits ago, silently. `save_window_state` is
called beside `end_all` for that reason. The flags are explicit rather than
`all()`: `DECORATIONS` would let a saved state fight
`tauri.windows.conf.json`, which turns the frame off on purpose, and `VISIBLE`
could restore a hidden window, which leaves no way to get it back.

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
for a place to work rather than for an agent to be running in it. It answers in
the focused window (`window::front`), and only there.

**Cleanup runs on `RunEvent::Exit`, not on a window event.** `Cmd+Q` and the
app menu's Quit reach tao as `terminate:`, which emits only `LoopDestroyed` — so
no window ever sees `CloseRequested` or `Destroyed`, and anything hung off those
is skipped on the most common quit gesture on macOS. The confirmation prompt can
live on `CloseRequested`; ending the sessions cannot.

`Destroyed` still ends sessions, but only the closing window's:
`Sessions::end_window`, by the label each session records at spawn and
re-records when it is adopted. Ending them all there killed every other
window's agents whenever one window closed. A window closed while others stay
open also forgets its stored tab list, as Chrome forgets a closed window's
tabs; the last one keeps it, which is what makes a relaunch restore it.

**A tab moves between windows; its process does not.** Rust owns the PTY, so
the move re-points the session's output (`pty_reattach`) instead of spawning
— `pty_spawn` on a live id ends what was there. The screen cannot move that
way, because xterm's buffer lives in the old webview, so it travels as an
`@xterm/addon-serialize` snapshot. Three things keep the seam exact:

- The snapshot carries `offset`, the bytes of output it already shows, and
  every terminal counts what it was sent. `output.rs` numbers the stream the
  same way and keeps a bounded backlog, and `redirect` swaps the channel and
  replays everything after `offset` that it still holds **under the lock the
  reader thread sends under** — so no chunk falls between the swap and the
  replay, or arrives twice. The backlog keeps the last 512 KB of every live
  session, so a burst larger than that during a move is lost from the screen.
- The old view stops drawing at the moment it takes `offset`, and its unmount
  then skips `pty_kill`: a detached tab leaves its session running. A move
  that fails calls `resume`, which reattaches to itself from the same offset.
- A session tab that arrives without its terminal is refused (`readHandoff`),
  never repaired. Adopted without one, it would spawn the agent a second time
  in the new window while the original kept running.

The window a session moves to owns it from the moment the move is asked for —
`window_open` and `window_send` re-record the label before the target has even
loaded — because the old window may close at once, and its `Destroyed` ends
what it owns. For the same reason a failed send does not end the reader
loop: the window it failed to is either closing, which ends the session
anyway, or handing it over, and the session must stay drained and its backlog
filling until the new window attaches. A session that ends during the move is
remembered in `Exits`, so the adopting tab shows how it ended.

**A tab dragged off the strip lands where the backend says the cursor is.**
While the button is held no other window receives a single event, and the
page itself stops hearing `pointermove` once the pointer leaves it under
WebKitGTK (the release still arrives) — so the drop is decided at release, by
`window_drop_target`, from `cursor_position()` against the strip each window
reported (`window_strip`). Another window's strip merges the tab there, by
`insertionIndex`'s half-width rule; anywhere else — its own window included,
as in Chrome — gets a new window with the grabbed point under the cursor. A
point inside the dragging window's own frame is over that window whatever
strip lies behind it, since the dragging window is the one in front. A
window's only tab carries its whole window from the first move (`Carry`, moved
by the label's thread each frame), so for it only another strip changes
anything. Escape, or bringing the tab back onto the strip, is how to keep it.
Pointer events, never HTML drag and drop: the native file drop this app relies
on keeps WebView2 from ever seeing `dragover`.

The units are the trap. macOS scales the cursor by the **primary** display's
factor but each window's position by **its own**, so on a Retina laptop beside
a 1x display a comparison in physical pixels misses by a factor of two;
`desktop_per_physical` compares in points there and in physical pixels on
Windows and X11, where both are already physical. A window is placed by its
frame while the grab is measured in its client area, so `Carry` subtracts the
frame between them — a title bar on Linux, nothing on macOS or frameless
Windows. Wayland reports the cursor and every window's position as `(0, 0)`,
which would put every strip under the cursor, so `on_wayland` withholds the
cursor altogether: a drag there still opens a new window, but shows no label,
carries no lone tab's window and merges nowhere. A tab is torn off past `TEAR_PX` above or below the strip and comes back
only within `RETURN_PX`, closer, so a hand wavering at the threshold does not
toggle it every move. Windows have no z-order API, so of overlapping strips the
most recently focused window's wins.

**The label that follows a torn-off tab is a window, and it must never count as
one.** A page cannot draw outside itself, so `ghost.rs` keeps a borderless,
transparent, click-through window labelled `ghost`, built on the first drag and
reused. While a tab is torn off a thread moves it to the cursor every frame
and asks `target_under_cursor` what a release would do, which is also how the
hovered window gets its landing mark (`muster://drop-hover`) — that window
hears nothing of the drag itself. Five things keep it out of the way: every
list of real windows skips the label (`has_other_windows`, `front`, the drop's
own hit-test), or closing the last real window would neither quit nor keep its
tabs; the last window's `Destroyed` closes it, because a hidden window still
keeps the app running; window-state's denylist names it, or it would be
restored wherever a drag last left it; it has a capability of its own
(`capabilities/ghost.json`) granting the event API alone among the core and
plugin APIs, since it draws a title an agent chose — the app's own commands
are not capability-gated (there is no app manifest), so that is where the
narrowing stops; and it hides itself a second after the
dragging page's heartbeat stops, because a page that reloads or dies mid-drag
never sends the hide and the label would follow the pointer for the rest of
the run. Its page asks for the current state on mount as well as listening,
since the first drag's first word is sent while that page is still loading,
and the thread checks the drag is still on after showing it, because a hide
can run while a frame is working out its target. Each tear-off is numbered by
the page and a hide quotes the number: `ghost_show` is async and `ghost_hide`
is not, so a quick tear-and-release can deliver the hide first, and the show
that follows must not bring the label back. The landing mark is in the
dragged tab's agent colour; the label's own "Add to this window" in `primary`.

The serialize addon is pinned at `0.13.0`, the last on the xterm 5 line, for
the reason the ligatures invariant in `src/features/terminal/AGENTS.md` gives: `0.14.0` declares no peer.

What the snapshot cannot hold is carried beside it. xterm keeps mouse
encoding (`?1006`) and cursor visibility (`?25`) out of the state the
serializer reads, so a clicks tab would arrive reporting the wheel in an
encoding the agent does not parse; `CARRIED_MODES` watches them and the
handoff writes them back. The shell reports its history file once, so that is
carried too. Prompt boundaries before the move are not: the snapshot has no
`OSC 133` marks, so the copy control and `⌘⇧O` reach only commands run after
it. And a move cut mid-escape-sequence prints the sequence's tail once, since
the offset is a chunk boundary and xterm does not expose its parser state.

**A kill names a registration, not a tab.** `pty_kill` and `pty_spawn` are
separate async commands with no ordering between them, and a tab reopening
its conversation posts both for the **same id** in one commit — so a kill
meant for the session being torn down can arrive after its replacement is
registered. Removing by id alone then ends the child that just started, and
because `end` sets `killed` the reader thread reads it as deliberate and
reports no exit: the tab keeps its terminal, shows no ended bar and no way
back, and has nothing running behind it. `EPOCHS` numbers every registration,
`pty_spawn` answers with the one it took, and `pty_kill` refuses an epoch that
is not the one currently registered. Same shape as `Sessions::forget`'s
`Arc::ptr_eq`, and for the same reason.

**A session must be forgotten when its child exits.** The pane stays mounted
behind the "session ended" overlay, so `pty_kill` never runs on a natural exit.
Without `Sessions::forget` in the reader thread the registry keeps dead entries,
and then the quit prompt counts tabs with nothing running and `end_all` signals
pids the OS may already have recycled. For the same reason `end_all` drains into
a vec before ending anything — `end` sleeps between `SIGHUP` and `SIGKILL`, and
holding the map guard across those sleeps blocks the event loop.

**But it must forget its own session, not whatever holds the id now.** A tab
reopening its conversation respawns under the **same id** — the mode control,
the width repair and a record from the journal all do — and `pty_spawn`
registers the new session _before_ it ends the previous child. So the old
reader thread reaches `forget` with a live session already in its place, and
removing by id alone drops that one: every later `pty_write` answers
`no session <id>`. Nothing about the tab looks wrong when it happens, which is
what makes it expensive — the reader thread owns the output channel rather
than the registry, so the terminal goes on drawing, the status stays
"waiting for you", and only typing is dead. `forget` therefore takes a `Weak`
to the session the caller owns and removes only on `Arc::ptr_eq`;
`pty_tests.rs` pins both directions.

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

**A shell reports its own command boundaries, and nothing else can.** The
prompt is just characters in the stream: no cell attribute marks it the way an
agent's tinted block does — measured, no shell on this machine emits `OSC 133`
on its own. So a **plain shell** session, and the shell an agent session hands
back to, is started with a startup file of Muster's own (`src-tauri/shell/`), which sources the user's and then adds
`precmd`/`preexec` hooks that print the standard marks. The copy control and
the completion list both read them, and a session that reports none simply has
neither surface.

Three things about the injection break silently.

**zsh moves `HISTFILE` when `ZDOTDIR` moves.** The injection is `ZDOTDIR`
pointing at Muster's own directory, and zsh derives the default history file
from it — so without the line that puts `HISTFILE` back, a Muster session
writes its history where no other terminal reads it, and starts every first
run with none. The four shims there (`.zshenv`, `.zprofile`, `.zshrc`,
`.zlogin`) each hand `ZDOTDIR` back before sourcing the user's own file,
because that file may look beside itself for the rest of their configuration
— and the last one hands it back for good, so a shell started _inside_ the
session is the user's own.

**bash cannot be given both `-l` and `--init-file`.** It reads the init file
only for an interactive **non**-login shell, so a login bash ignores it
entirely — which is why `Integration::args` _replaces_ the session's arguments
rather than adding to them, and why the script sources `/etc/profile` and the
first of the three profiles itself. Drop that and a GUI-launched session is
back to the bare `PATH` launchd gave it, with every CLI installed by the
user's profile invisible. It is also why the DEBUG trap is chained rather than
set: starship and bash-preexec both hold it already, and taking it would stop
their prompt working.

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

The transcript read holds to the same stance, and it has to: it happens on a
status edge with **no click at all**, so it is the automatic kind. The final
component goes through `open_without_following` — `review.rs`'s, rather than a
second copy — because `symlink_metadata` alone is check-then-open and the
program that writes the file is the one being defended against, so it can
replace its own transcript with a link between the two. A project directory
that is itself a link is skipped in `claude_project_dir` before anything under
it is opened; `~/.claude` above it is not, for the reason `links_above` gives
about a root — that is the user's own home, not something an agent chose.

**An id another program published is checked once, for two hazards.**
`is_session_id` is the only copy, and both callers need both halves: the
journal sidecar's id reaches an **argv** through the Resume button, and a
**path** through `transcript.rs`. The alphabet alone covers neither. A leading
`-` is spelled from it — `--dangerously-skip-permissions` is thirty ASCII
letters and hyphens — and would put a flag in front of a program nobody typed;
a Windows device name is too, and `CON.jsonl` opens the console whatever
directory it is joined under. `.`, `/`, `\` and `:` are outside the alphabet
already, so the traversal half needs nothing more.

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

**A patch must come back from git verbatim.** `workspace::git` ends in
`trim_end`, which is right for a fact — a sha, a branch name — and wrong for a
diff: a unified diff's blank context line is a single space, so trimming
deletes the diff's last rows for any file ending in blank lines, while its `@@`
header still promises them. That is exactly the region a reviewer reads when an
agent may have eaten a trailing newline. `git_verbatim` is the one to use for
anything whose whitespace is content.

**Keep command-line building platform-independent.** POSIX, PowerShell and WSL
argv construction in `src-tauri/src/platform.rs` compiles on every target so
`cargo test` covers all three from any host. `cfg`-gate the _choice_ between
them and the process inspection, never the string building.
