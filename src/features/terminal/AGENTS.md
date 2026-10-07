# AGENTS.md — the terminal

The invariants for the terminal surfaces — xterm and its addons, the shell blocks and completion, the message and file marks, the rails, the modes, links, notifications and the width repair. The repository's conventions, and an index of
every invariant, are in the root [AGENTS.md](/AGENTS.md); read that first.

Each of these was a real bug. None of them fail loudly.

**Terminals blur when their pane hides.** A hidden pane keeps DOM focus in
xterm's helper textarea, which then swallows typing meant for the tab now on
screen. `TerminalView` calls `blur()` on deactivation; the launcher claims focus
when it comes forward.

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

**Three addons are pinned exactly — webgl, ligatures and serialize — and the
rest keep ranges.** The same reach through `terminal._core` is why: the addons ship on their
own version lines, none declares a peer range tight enough to catch a
mismatch, and a field renamed upstream reads as `undefined` rather than
failing. `@xterm/addon-webgl@0.19.0` is built for xterm 6, where `Disposable`
holds a `_store`; beside xterm 5.5.0, which still calls it `_disposables`, the
only line that reads it is the addon's own dispose callback — so every
terminal rendered correctly and closing a tab threw, on every close, whatever
the dispose order. So the pin is `0.18.0` — the build that pairs with xterm
5.5.0 — exactly rather than ranged; ligatures and serialize are pinned for
the peer-range trap the ligatures invariant below describes. The other four
addons and the core keep `^` ranges, and `test/xterm.test.ts`
is what stands behind them — it fails when an addon names a core field this
xterm does not have. Read its doc comment before trusting a green run: the
bundles are minified, so it sees only the literal `_core.x` spelling and not
the aliased reads that most of them compile to.

**Ligatures are activated with the Local Font Access API hidden.** The addon
reads a font's real ligature set through `queryLocalFonts` where the browser has
it and falls back to a fixed programming set where it does not — and WebView2
has it while WKWebView does not, so activating it plainly would raise a font
permission dialog on Windows alone, at startup, for something the user did
nothing to ask for. `withoutLocalFonts` deletes the property for the duration of
`loadAddon` and puts it back, which is the same stance as the native font
enumeration in the root AGENTS.md's Scope section and has the side effect of
making one host's ligatures match another's. The version is the last on the
xterm 5 line (`0.9.0`, peer `^5.0.0`); `0.10.0` declares no peer at all, which
is the trap the pinning invariant above describes.

**A multi-line prompt reports its end twice.** The line editor redraws the
prompt's last line after the first paint — measured against starship, `A B B
C` for every command — so the **latest** `B` before a `C` is where typing
actually starts, and treating the first as final puts the completion's
anchor a row too high. `promptEnd` therefore replaces the open block rather
than keeping the first one.

**The command a block ran is the shell's answer, never the row it was drawn
on.** zsh draws `RPROMPT` on the command's own row, so the rendered row is the
command, then padding, then the right prompt — measured under a pty,
`\x1b[70C[12:04]` on the same line. Built from that row, this session's own
suggestions carried the right prompt with them, and accepting one typed all
three back into the shell. Both scripts report `OSC 133;P;Cmd=<command>` from
`preexec` instead, and the rendered row is only the fallback for a shell that
reports none. bash's DEBUG trap fires for this file's own functions too, so
the report skips anything named `__muster_*` — without that the session's
first command was the terminal's own plumbing.

**Only a session Muster injected into is believed, and the backend is what
says so.** `OSC 133` is ordinary bytes: an agent CLI, a command's output, or a
remote host printing into an `ssh` session can report a prompt boundary and a
history file as easily as a shell can — and what it reports chooses a file for
`shell_history` to open and text for `accept` to type back into that same
session. So `pty_spawn` answers with `shellIntegration`, and the `OSC 133`
handler drops everything until that is true — and in a session that hands
back, until the hand-back is believed as well, because before it the terminal
is the agent's. Every surface here is fed through that one call, which is what
makes one check the whole gate.

Answered by the backend rather than re-derived in the frontend for two
reasons: the same rule computed in two places drifts, and only that side knows
whether the scripts could be written at all. Re-deriving it from the tab's
agent, backend and the _current_ setting would also be wrong after the setting
is toggled — the session keeps whatever it was started with.

**A block's rows are markers, never row numbers.** A row number is right until
the scrollback is trimmed, at which point every row above shifts and the number
names someone else's output — so the copy control would copy the wrong command,
which looks exactly like it working. `useShellBlocks` holds xterm's own
`IMarker`s and disposes them with the terminal; `MAX_BLOCKS` is what stops a
day-long session carrying one per command it ever ran.

`MAX_BLOCKS` only bounds the blocks that became commands, though, and a prompt
that never does is the common case: a multi-line prompt reports its end twice
per command, so the block the second report replaces has to be released where
it is dropped. Every path that discards an open prompt calls `forget`.

The rows a marker names can also leave the scrollback, and then it answers
`-1`. That is not a row to read from: xterm's `getLine` has no bounds check,
and its circular buffer resolves `-1` to a real stale row once it has wrapped
— so `textBetween` refuses a negative row, and every caller that walks a
block checks the same thing. Without it, `⌘⇧O` on a command whose start had
been trimmed copied the entire session.

**Accepting a completion types it into a live shell.** That is the whole
reason for every refusal around it: `commands_in` drops a zsh history entry
spanning lines and one carrying a control byte — bash marks no continuation,
so its halves are offered as commands of their own — `matchesFor` drops a candidate
whose remainder is not typeable, and a line starting with a space — which is how a shell is asked not to
record one — is refused on both sides: in `commands_in`, which has to read the
space before it trims it away, and in `matchesFor`, because a session reports
its own commands verbatim and the file never sees them. A newline
in accepted text is a command submitted by the keystroke that promised to
complete one. The same hazard `drop_text` refuses a path for.

Accepting also **fills the line in and stops**: running it is still a press of
Enter the reader makes, having read it.

**The completion keys are claimed only while there is something to claim.**
`→` at the end of a line, `↓` into the list, `↑` back up it, Enter on a chosen
row, Escape to dismiss — each answers `false` when no list is showing, and the
key then reaches the shell untouched. A chord carrying **any** modifier answers
`false` before that switch is reached: `⌥→` is `forward-word` and `⇧Enter` is a
newline in several CLIs, and a list that took them would claim a key the reader
has always had. `↑` out of the **first** row also answers
`false`, which is what keeps the shell's own history recall on the key it has
always been on: the list is an offer, never a mode to escape.

**A control drawn over the grid must not sit on the grid's own listener.** The
copy control is the overlay's child, so a pointer moving onto it _leaves_ the
element xterm was opened in — and a `pointerleave` there took the control away
as the pointer reached it, every time. The pointer is followed on the pane,
which contains both.

**The history file's path is the shell's answer, not a guess.** It is reported
over `OSC 133;P;HistFile` once per session, after the user's startup files have
had their say, because `~/.zsh_history` is wrong for anyone who moved it and
for every session whose `ZDOTDIR` is not their home. It is read through
`open_tail` — the same bounded, link-refusing read the transcript takes, and
for the same reason: it happens on a keystroke with no click behind it.

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
each message's **true position** in the session. `Rail` draws its own
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
that buffer — the same session went from one screen to 24,000px of scroll
extent and the rail filled.

**But the mouse is on the other side of that trade, so it is a choice, not a
constant.** A session started with this variable emits no `CSI ?1000h` at all,
so its own prompts, its subagent picker and its running-shell list stop
answering a click. Measured across 187 recorded sessions here: 54 armed
`?1000h`/`?1002h`/`?1003h`/`?1006h`, all 54 carry an alternate-buffer marker,
and no session in the normal buffer armed any of them.

Be exact about what that evidence is, because one recording looks like a
counter-example and is not. The journal holds **output**, so it shows what the
CLI asked the terminal for and can never show what the terminal sent back —
"reports no mouse" here means "requests no mouse reporting", which is the
thing that decides it. And the one recording with tracking but no `?1049h`
(`179a52e0-…`, 3.0 MB) carries `?1049l` and begins mid-UTF-8-character: it is
a session the 4 MB cap trimmed, and the `?1049h` was in the half that was
dropped. Grep both markers, or a trimmed record reads as a normal-buffer
session that took the mouse.

What could still overturn it is a release, not a recording: if Claude Code's
classic renderer starts reporting mouse events, the trade dissolves and the
setting should go with it. Check a fresh record for `?1000h` before assuming
it still holds.

So the mode is carried per session, on `SpawnOptions::scrollback` from
`Session.scrollback`, and it is chosen in three places that must stay in this
order: the `terminalMode` **setting** is the default a launch takes, and a
`LaunchRequest` that names a mode **overrides** it. Three callers name one —
the start screen's own control, a resume that carries the tab's current mode,
and the status bar, which flips the tab through the agent's own `continue`,
because the variable is read once at spawn and the conversation is the only
thing worth carrying across the restart. The setting
defaults to `scrollback`, which is what every session did before it existed.
The rails can read the agent's transcript instead, but nothing else can: the
scrollbar and the marks on it, the path strip, the find bar and the width
repair all read the terminal's own history, and the alternate buffer has
none. So a clickable tab is the deliberate case.

Which is also why `Agent.scrollbackMode` gates that control rather than every
tab getting one: the variable is undocumented and read by Claude Code alone,
so any other agent holds the alternate buffer whatever it is told, has no rail
and no path strip, and would get a button that reopened the session and
changed nothing. And it must never join `INHERITED_SESSION_MARKERS`: the
strip loop runs after the environment is set, so a variable in both lists is
removed by the line that follows the one setting it, which reads exactly like
working.

**The mode control draws both modes, never just the current one.** A single
button labelled with the mode you are in reads as "press for this", which is
the opposite of what it does — and the mode someone is looking for is the one
it does not show. `MODES` in `StatusBar` is the pair, the tab's own carries
`aria-pressed`, and only the other one takes a click.

**And it is offered only where there is a conversation to reopen.** Having a
`continue` mode is not the same as having something to continue: both this
control and the ⟳ respawn through the agent's own `continue`, so a tab whose
first turn has not been written yet reopens onto `No conversation found to
continue`, the agent exits at once, and a tab that was working is dropped to a
shell prompt — or, under PowerShell, left at `exited 1` — by a button that
promised to change its mode. `usePastSessions` counts what
the store holds and `canReopen` decides, on the quiet edge the deck already
tracks rather than a timer — a count taken at spawn would read zero for a
conversation that exists moments later. `null` means unknown and still
offers: hiding a working control leaves the tab no way to change mode at all,
which is the worse error.

**Clicks mode only clears the way; the CLI still chooses its own renderer.**
The variable forces the classic renderer, so removing it is necessary — and it
is not sufficient. Claude Code's fullscreen renderer is a setting of its own
(`/tui default | fullscreen`) that it also **turns off by itself** after
repeated failures to start, and once off, no environment this app controls
brings it back: measured on 2.1.276, launches with the variable absent, with it
set, and with `CLAUDE_CODE_NO_FLICKER=1` produced byte-identical output, none
of it entering the alternate buffer or arming `?1000h`. So a clicks tab whose
clicks do nothing is the expected state after that, and `/tui fullscreen` in
the session is the only cure. Say that wherever the control is explained —
without it the tab reads as broken.

**A clicks session removes the variable; declining to set it is not enough.**
`apply_mode` strips it, and that direction is the one that breaks silently.
`CommandBuilder` seeds every child from Muster's own environment, and a shell
tab is itself a session run in the tab's mode — so a Muster started from a
shell tab in scrollback mode inherits the variable, which is the ordinary dev
loop here. Every session it then spawns would keep the classic renderer
whatever the tab said, including one the control had just switched to clicks:
the status bar reads Clicks, the conversation reopens, and nothing about it
changes. This is the mirror of the marker invariant in `src-tauri/AGENTS.md`, and `pty_tests.rs`
pins both directions.

What it cannot reach is the shell's own startup files. A session runs through
a login shell, so a profile that exports the variable sets it again after
`apply_mode` has removed it, and the tab is back in the state above with
nothing in Rust able to see it. `INHERITED_SESSION_MARKERS` has the same hole
for the same reason.

**The app's own links stand down while the agent is reading the mouse.** xterm
forwards the click to the child as soon as tracking is on, and its `Linkifier`
activates a link from the same `mouseup` without consulting that — so one
click on a path both opened the file column and reached the agent.
`agentReadsMouse` in `TerminalView` reads `term.modes.mouseTrackingMode`, the
platform's own answer rather than a guess about which mode the tab is in.

Two things about it are load-bearing. It gates **`provideLinks`, not the
activation** — a link that is still offered keeps xterm's underline and
pointer cursor, so the output would go on claiming to be clickable while
ignoring the click; the web-links addon registers its own provider, so
`gateLinks` meets it at that one call, the same shape as `withoutLocalFonts`.
And it is `false` once the session has ended, because xterm clears the mode
only when the child asks it to: a TUI that is killed rather than closed leaves
tracking armed forever, and the output stays on screen under the ended-session
bar with every path in it dead until the tab is closed. An agent session that
hands its terminal back is reset by the hand-back instead (`MODE_RESET`), which
is why the check can stay on `live` — the shell after it never sees tracking
the agent armed.

What stands down is the plain click. A ⌘-click (Ctrl-click off macOS) still
opens a link, as in iTerm2 and VS Code's terminal, with no underline to show
it. `onLinkMouseDown` claims the press only over a link, and listens on
`.xterm-screen` — after xterm's `Linkifier`, which listens there too, and
below the root where xterm reports the click — so stopping it there keeps the
agent from hearing the press, and xterm never arms the document listener that
would report the release. The link opens on the **release**, over the same
link, and that release is claimed wherever it lands: the `Linkifier` may still
hold a link it offered before tracking began and would open that one too. A
⌘-click on anything else is still the agent's.

**An agent's hyperlinks are xterm's, not ours, and they need a handler.**
`OSC 8` links — Claude Code's PR links, and a long URL it breaks across rows
with the full target on each — come from a provider xterm registers itself,
so `gateLinks` never sees it and xterm ranks it first. With no `linkHandler`,
xterm activates one through `window.confirm` — which `tauri-plugin-dialog`
replaces with a `plugin:dialog|confirm` command the capabilities do not
grant, so without a handler every such link throws, on every platform. The
handler opens them in the browser, as a URL is, on a plain click — a choice
made knowingly: an agent can make a whole row one hyperlink, so a click meant
to focus the pane loads its page, and the corner label is what shows where it
goes. It opens nothing while
tracking is on, because there the ⌘-click is `onLinkMouseDown`'s. It
also records the hovered link, since hover is the only way xterm says one is
under the pointer; `linkUnder` checks that before the ungated providers, as
xterm does — and shows its target at the pane's corner (`linkTarget`), because
the text an agent draws over a hyperlink need not be where it goes, and the
target is what a click opens. A web link's label also previews its page —
`LinkHover`, fetched by `link.rs` after `DWELL_MS` and cached per address by
`previewCache` — and names the real host whole above the address, since an
address truncated at the label's edge can read as another host. The label is
`pointer-events-none` on purpose: the click belongs to the link, whatever the preview has or has not loaded. The
fetch has no address policy, by the user's choice; SECURITY.md says what
that costs. A Stack Exchange question is read from the site's API instead of
its page, because the page is a Cloudflare challenge to anything that is not
a browser — measured with a browser's user agent too, so a header change
does not get past it. Every link, from here or a document, reaches the
opener through `Pane`'s `onUrl`, which opens a web address only, in the form `webHref` parsed it. While the agent reads
the mouse the gate offers xterm no links, so the web-links addon never hears a
hover; `onTrackedMove` labels a plain URL itself then, because the ⌘-click
still opens one. Two limits follow from xterm, not from us: these links stay
underlined while tracking is on, and a link drawn under a pointer that has
not moved is not hovered until the pointer moves, so a ⌘-click there finds
only what the ungated providers can see. Only
`http` and `https` targets are offered, which is xterm's default and keeps a
`file://` or `vscode://` target from reaching the opener.

**`macOptionClickForcesSelection` is toggled, never set.** It is what hands a
macOS user a drag a tracking CLI would otherwise take — but xterm reads the
same option in `shouldColumnSelect`, so it is also the switch that turns
Option-drag block selection off. Left permanently on, every session loses block
selection to buy an escape hatch only a clicks session needs;
`syncSelectionModifier` therefore follows `mouseTrackingMode` on the write
batch that changes it. Verified against xterm 5.5.0's own defaults:
`altClickMovesCursor` is `true`, `rightClickSelectsWord` is `isMac`, and
`macOptionClickForcesSelection` is `false` — this is the only one the app
moves.

Every surface the app floats over the grid answers to the same question, and
two of them are controls rather than marks. `MessageSteps` — the step arrows
and the ⟳ — is a real element over the bottom-right corner, and it is drawn
for whichever list the tab has, the transcript's as readily as the scan's.
The ⟳ inside it is the part that is conditional, and two gates decide it:
`Pane` offers `onReplay` where the agent has a `continue` **and** `canReopen`
says a conversation exists to reopen — see the mode-control invariant above,
which the ⟳ shares — and `TerminalView` passes
it on only where `surfaces.replay` says the live buffer has a scrollback for
a width change to ruin.

**A clickable session reads its places from the agent, not from the grid.**
The alternate buffer keeps no scrollback, so the scan finds nothing there —
and the agent has kept a structured record of the same conversation all
along. `agent_turns` in `transcript.rs` reads Claude Code's own
`~/.claude/projects/<dir>/<session>.jsonl`, resolved through the journal
sidecar's published session id, and `TerminalView` switches the rail to it
whenever the buffer is alternate and the transcript has turns.

Finding that directory takes **two** spellings of the tab's own path, because
two things can differ. The launcher sends tilde paths where the store's names
are absolute; and the CLI files a project under the path its own process
resolved to, which is not the one the user typed whenever a link stands
between them — `/tmp` is a symlink to `/private/tmp` on macOS, so a tab opened
at `/tmp/x` matched nothing, and the Continue button, the session count and
the rail all reported empty for a conversation that was there. `store_keys`
keeps both, and keeps the unresolved one too, because resolving needs the
directory to exist and a record outlives the directory it was made in.

Three things about that source are better than the scan, and one is worse.
It reports the turns the person actually typed — `promptSource == "typed"`,
the CLI's own distinction, where the scan infers from a tint that a diff
gutter also carries; and it holds the history a `--continue` printed before this
terminal existed, which the scan measured at five marks out of a 977-row
transcript. What it cannot do is move the viewport by itself: the agent owns
scrolling inside the alternate buffer, so `scrollToLine` does nothing there
and a transcript place has to be sought instead. The step buttons walk
either list; only the scan's marks are jumped to directly. Past the newest
place, ↓ goes to the live bottom in both — `scrollToBottom` in a scrollback
tab, a sweep the other way in a clickable one — because the output after the
last message is where the agent is working, and a walk that rests on the
newest message cannot reach it.

**There is no scrollbar over that buffer, and there is nothing to draw one
from.** The alternate buffer is exactly `rows` tall, so xterm has no extent
to size a thumb against, and the agent never reports where its own view sits
— nothing in the pty stream says how far back it has scrolled or how much it
kept. A bar there could only be an estimate counted from the notches this
app sent, and an estimate is what a scrollbar must not be: the agent pins its
view to the bottom on every repaint, so it drifts from the first turn
onwards. `surfacesFor` answers `scrollbar: false` for that buffer, and a tab
that wants a real one is a scrollback tab — which is the default, and the
reason the choice is offered at launch rather than assumed.

**A dot seeks only while the agent is reading the mouse, and that guard is
not tidiness.** xterm answers a wheel on a buffer with no scrollback, with
tracking off, by **typing**: it turns each line the notch would have scrolled
into `ESC[A` or `ESC[B` and writes them to the pty. A burst is eight notches
of roughly seven lines, so one stalled seek is about a hundred arrow presses
into a live agent — and Up recalls the previous prompt in Claude Code, so a
click meant to scroll overwrites a draft and nothing about the tab looks
wrong afterwards. `seekTo` therefore returns unless `agentReadsMouse` says
tracking is armed, and re-checks after every await, because a TUI can drop
tracking mid-seek. The rail is drawn from the buffer and the turns, neither
of which knows about tracking, so the check cannot live there — and for the
same reason the transcript rail is not drawn at all when the seek could not
work, since a dot that ignores a click is the thing `gateLinks` exists to
prevent.

**A dot seeks instead, and the stall check is the whole feature.** The wheel
is the one thing that moves a view the agent owns, and xterm forwards it —
measured, `CSI <64` on every notch — so `sweep` sends bursts and reads the
screen between them until the message is there. The first version had no
stall check and was unusable: the agent pins its view to the bottom while it
is **printing**, so 60 notches at a working session moved the top row not one
line, and two attempts spent 48 and 52 seconds finding nothing. `moved` in
`seek.ts` now ends it after two bursts that changed nothing, and the view goes
back exactly as far as it came.

The stall is also what the return to the bottom is built on. `seekToBottom`
runs the same loop downward with nothing to look for and keeps what it sent,
because nothing reports where the bottom is — arriving _is_ the stall. Both
go through `wheelOver`, which is where the tracking check lives: a sweep that
sends notches to a session not reading the mouse types a hundred arrow
presses into it instead.

Judging "changed nothing" is the part that needs care. An exact comparison
says _moved_ on a frozen view, because the agent repaints its own spinner,
token count and timer between frames — so `moved` calls a screen unchanged
when three quarters of its rows match, and a test pins that case. A message
shorter than eight characters is not sought at all: `do that` appears all over
a conversation, and landing on the wrong one is worse than not moving.

It is another program's private file, so every field check in
`transcript.rs` is the feature: a line that does not parse costs one turn,
never the rail, and a release that renames something leaves an empty list
that falls back to reading the terminal.

Three things about reading it were got wrong first, and each was measured
against this machine's records rather than reasoned about:

- **The bound has to be taken from the end.** The file is append-only and
  oldest first, so capping the read at the first 20,000 lines kept the start
  of a long session and dropped the rest: on a 23,796-line record that was
  105 turns whose newest was three hours stale, against 120 for the whole
  file — and since the rail shows the newest dozen of what it is handed, a
  stale turn was presented as the current one. `open_tail` takes the last
  `MAX_BYTES` and drops the partial line the seek lands in; bytes rather than
  lines because one line can carry a pasted attachment.
- **`typed` is not the only thing a person writes.** `queued` is the same
  prompt submitted while the agent was still working — 38 here, reading
  `btw, check out branch first`. `suggestion_accepted` stays out: those are an
  offered action chosen from a list, so the words may be the CLI's own.
- **A published session id is not a promise of a transcript.** 111 of 172
  ids on this machine name no file, a session having ended before the CLI
  wrote one, so `session_ids_for` answers with every id the tab published and
  the reader takes the newest that resolves.

Two things the corpus could not settle, so do not write them down as settled:
no record here has ever carried `isSidechain`, and no tool call has used
`notebook_path`. The sidechain skip and that key are insurance, not results.

The read is reached through the journal sidecar, so it inherits that feature's
switch: with recording off there is no sidecar, no published id and no rails
in a clicks tab. `Pane` asks for turns only where they can be drawn — a
Claude tab in clicks mode — because every pane stays mounted and an ungated
read would parse a transcript per idle edge in every other one.

The same buffer that costs the mouse costs the marks, so `useBufferMarks`
scans the **normal buffer only**. An agent's frame paints tinted cells in the
alternate buffer too, and the rail and the step buttons are app DOM rather
than xterm's ruler canvas — which xterm hides there — so they would draw dots
whose `scrollToLine` is a no-op on a buffer with no scroll extent.

`MessageSteps` walks the identical list the rail beside it draws — the scan's
marks in a scrollback tab, `messagesIn(turns)` in a clickable one — so the
number of dots and the number of presses always agree. That is the property to
preserve if either surface changes, and it is why the count is passed in
rather than recomputed. The rail sits clear of the scrollbar rather than
over it, and `pointer-events-none` on its column with `auto` on each dot keeps
the gaps inert either way.

**The filled dot answers a different question on each rail, and only one of
them can be measured.** A scrollback rail fills the mark the **viewport** is
inside. A clickable one fills the place the **walk** is on, because the agent
owns its own scrolling inside the alternate buffer and reports nothing about
where its view sits — so where the buttons are is the only position anything
here knows. That makes it state rather than a ref: it is the only thing the
rail has to draw from, and a ref redraws nothing, so every dot looks the same
however many times the buttons are pressed. The walk itself is `walk.ts`, out
of the component so a test can reach it — `walkTo` is where ↓ past the newest
message becomes the live bottom, and `placeKey` is what keeps the filled key
one the rail actually drew.

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
found rather than as something you wrote. Measured across 91 recorded sessions
on this machine, no shell emitted `OSC 133` semantic prompt markers on its own,
so there is no standard signal here to fall back on: what a **plain shell** tab
has is the pair Muster injects for it (see the shell-integration invariant in
`src-tauri/AGENTS.md`), and no agent CLI emits them at all.

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
was an `OSC` string terminator, not a bell. A Claude Code session broadcasts
`OSC 777;notify;warp://cli-agent;<json>` instead, carrying `session_start`,
`prompt_submit`, `tool_complete`, `idle_prompt`, `stop` and `stop_failure` —
and `permission_request`, which `NAMES` does not list, so it answers `null`
and is dropped. `stop` is the turn boundary, and `stop_failure` is the same
boundary reached through an API error; `endsTurn` treats them alike, because
a rate limit is exactly when the person who walked away needs telling. Their
payload carries the agent's own closing words — which become the notification
body — alongside fields `parseAgentEvent` deliberately drops, its transcript
path among them.
`parseAgentEvent` reads it and `Pane`'s `signalAttention` is where both routes
meet, so an agent that rings _and_ broadcasts notifies once — the cooldown in
`decideBellResponse` is what makes that true.

The broadcast is not the CLI's own, and that is the part that breaks
silently. It comes from a hook plugin the user installs, and the plugin stays
quiet until the terminal advertises that it can render the events —
`CLI_AGENT_ENV` in `pty.rs` is what advertises it, and `advertise_protocol`
beside it carries the rest of the reasoning. Without it every hook exits
without printing and no tab notifies. Before `advertise_protocol` existed
that read as a release-only fault, because `CommandBuilder` seeds each child
from this process's environment: only a Muster that had itself inherited the
variables passed them on, so a build started from a terminal worked and the
same build started from the Dock did not. Measured then, across one day's
records here, 11 sessions under the installed app carried **zero** events
against 8 under `bun run dev` that carried them.

A **WSL** session gets none of it unless the user's own `WSLENV` lists both
variables. `cmd` there is `wsl.exe`, and only what `WSLENV` names crosses
into the distro — the one name this app adds to it is the hand-back token
(`pass_token`), so `TERM`, `COLORTERM` and `SCROLLBACK_ENV` do not cross
either, and what else crosses is whatever a `WSLENV` inherited from the user's
own environment happens to list. What a WSL tab loses is the turn boundary:
the bell, the hand-back and `announceExit` are read from the session itself and
still notify.

The other cost is that the payload is **agent-authored JSON arriving over a
terminal escape sequence**, which is why `parseAgentEvent` answers `null` for
anything unexpected rather than throwing inside xterm's parser, and why it
caps the text it carries — an unbounded `response` becomes the body of a
desktop notification. Treat the field checks as the feature, not as detail.

**A width change destroys a TUI's scrollback, so the scrollback is dropped
rather than shown.** This is the price of scrollback mode above, and it has to
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
in the alternate buffer has no scrollback to damage, so its `rows` of frame
are all there is to lose. Note that a clicks tab is not the same thing: the
CLI chooses its own renderer, so one whose fullscreen renderer is off runs in
the normal buffer and builds real history — which is why the ⟳ is gated on
the live buffer type and never on the tab's mode. The control is passed only where a `continue` mode
exists, so a shell is not offered a button whose click would do nothing.

What survives a clear is the machinery, and that is worth knowing because it
is not obvious: the scan is subscribed to `onWriteParsed` for the life of the
mount, so output written after a resize is marked as usual — a cleared tab
still painted 702 pixels of file marks from the agent's repaint. Only the
history is gone.

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

**A file drop is a window event, not an element's.** Tauri intercepts the drop
before the DOM sees it — `dragDropEnabled` is on by default — so there is no
target to hang a handler on and `onDragDropEvent` is the only way to see one.
Every mounted pane would otherwise answer the same drop, so only the active one
subscribes; the effect is keyed on `active` for exactly that reason. The text it
inserts is built in `platform::drop_text`, not in the webview: the quoting is
the session's shell's, and a WSL session needs the path translated the way
`--cd` translates it at launch.
