# AGENTS.md

Conventions for working in this repository. Written for coding agents, and just
as true for people.

**What this is:** a desktop app that runs AI agent CLIs in Chrome-style tabs.
Tauri 2 (Rust) owns the window, the PTYs and the filesystem; React 19 +
Tailwind 4 draw the interface; xterm.js renders each terminal. Bun bundles,
serves and tests the frontend.

Practical setup, commands and file map: [CONTRIBUTING.md](CONTRIBUTING.md).

## Before you claim a change works

Run `bun run check:all`: seven checks, the frontend's three from the repo root
and then `bun run check:rust`'s four from `src-tauri`. The script is the list,
so "I ran the checks" means the same thing every time. `cargo check` runs ahead
of clippy and the tests because a plain compile error reported as rustc's own
diagnostic is easier to read than the same error arriving through clippy or a
test binary that failed to build. Clippy runs with `-D warnings`, as CI does: a
warning that passes locally and fails in CI is the whole reason the two ever
disagree.

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

- **AGENTS.md**, this one and the three beside the code (`src/features/terminal`,
  `src-tauri`, `src/features/review`) — the invariants, the layer table, the
  conventions. A new invariant goes in the file beside the code it governs,
  and its title into this file's index. The layer table is meant to be what
  exists, so a new slice or segment belongs in it.
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

Each of these was a real bug. None of them fail loudly. The ones below cross
every layer; the rest live beside the code they govern, in an `AGENTS.md` that
loads when you work in that directory. **Before changing code that one of the
titles in the index names, read its file** — a change made from elsewhere does
not load it, and the cost of missing one is a bug nothing reports.

**Panes stay mounted while hidden.** `Pane` renders every tab and hides the
inactive ones with `hidden`. Unmounting would kill the PTY and the scrollback,
which is the opposite of the product. Never key a pane on the active tab.

Nor render them in tab order. Dragging a tab reorders `deck.tabs`, and React
answers a reordered keyed list by moving DOM nodes — a moved node loses its
focus and its scroll position, in terminals nobody touched. `App` renders the
panes sorted by id, which no drag changes; they are stacked, so the order
shows nowhere.

The consequence, which is easy to miss: a timer or subscription in a pane runs
in _every_ tab, forever, visible or not. `useWorkspace` already git-polls on
that basis, at a user-set interval. Anything ticking faster — a per-second
clock, an animation — needs to check whether its pane is active first.

**No `StrictMode`.** Its double-invoked effects spawn two PTYs per tab in
development. `src/app/main.tsx` says so — leave it.

**Tailwind needs an `@source` naming `src`.** In `src/app/index.css`,
resolved relative to that file — so moving the stylesheet breaks it. The dev server and
the production build resolve their scan root differently, and without it the dev
build silently emits no custom utilities.

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

**Tab ids must be unique across runs.** They key the backend's PTY map, and
`pty_spawn` reads a reused id as "end that session and take its place". A
per-run counter restarts at 1, so a restored tab and a later `⌘T` would collide;
`crypto.randomUUID` is what makes restore safe.

**Tabs and settings belong to the app, not to a window.** They live in
`state.json` beside the journal, written by `store.rs`, because `localStorage`
is per-origin: every window of the app shares one copy, so two windows editing
tabs would overwrite each other, and anything that clears site data takes the
tab list with it. Each window's tab list is its own key,
`muster.deck:<label>`, and the labels other than `main` are what
`window::restore` reopens on launch — `w-<hex>`, which is also the pattern the
capability file grants, so a window under any other label would have no core
or plugin permissions (the app's own commands are not capability-gated).

Each window reads the store into its own cache, so `state_write` tells the
other windows what changed (`muster://state`) and `appstate.ts` applies it.
Without that, a settings change in one window is undone by the next write from
another, since settings are written whole. For the same reason the journal
sweep, which a window runs with only its own tabs as `live`, also spares every
session the backend has registered: another window's agent is recording too.

An event meant for one window goes through `getCurrentWebviewWindow().listen`
and `emit_to`. The module-level `listen` hears an event sent to _any_ window,
so `muster ~/proj` would open a launcher in every one.

The whole store is read once, before the first render — `main.tsx` awaits
`loadAppState`, and a component that read state earlier would see an empty
store and restore a blank deck over a real one. Callers keep their synchronous
shape because reads are served from that cache; only writes leave the webview,
and `store.rs` persists each one as it arrives via a temp file and a rename, so
an interrupted write cannot leave a half-written file that parses as empty.

Per-window preferences stay in `localStorage` on purpose: a panel width dragged
in one window must not move in another. That is the test for where a value
belongs — is it the app's, or this window's?

**Nothing an agent names may reach a session as keystrokes.** `drop_text`
refuses any path carrying a control byte, because quoting is not the only
boundary in play: the text is delivered through xterm's bracketed paste, which
wraps it in `ESC[200~`…`ESC[201~` and does **not** strip an end marker embedded
in the middle. A filename holding that sequence — git stores arbitrary path
bytes, and an agent picks its own filenames — ends paste mode early, and the
rest arrives as typed keys with a carriage return to submit them. Balanced
quoting does not help, because the shell's line editor never sees quotes at
all.

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

**Material icons ship as path data, not a webfont.** `src/shared/ui/icons.ts`
holds the `d` attributes traced from Material Symbols. A webfont would need a
`font-src` the policy does not grant, and an icon font that fails to load
renders tofu boxes rather than nothing — a failure that looks like a bug in the
app. The three `window_*` glyphs are the exception to the tracing: Material's
window icons are several times the weight of the hairline squares a titlebar
draws, so those are drawn to the same 960 grid rather than copied.

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

**A scroll needs a bounded box.** `overflow-y-auto` on a child of an
`overflow-hidden` parent never becomes a scroll container: the child grows to
its content and the parent clips it, so the list looks truncated and the wheel
does nothing. Put the overflow on the element that has the height — the
`min-h-0 flex-1` box that the drawer's list and the reader both are — never on
both it and a child.

**An overlay that closes on Escape must claim the key, not share it.** Several
surfaces listen for Escape on their own, and they stack: the file column, the
image overlay, and a width drag in progress. Listeners on
`window` all fire, so dismissing a card also closed the column behind it, and
cancelling a drag closed the panel being dragged. The rule: a transient surface
listens in the **capture** phase on `document` and calls `stopPropagation`, so
the topmost one answers and the rest do not. A surface that is per-tab must also
gate on `active` — every pane stays mounted, so an Escape typed at a TUI in one
tab was closing another tab's panel.

### Where the rest live

**In [`src/features/terminal/AGENTS.md`](src/features/terminal/AGENTS.md)** — the terminal:

- Terminals blur when their pane hides.
- An oversized paste is caught in two places, because macOS has no third.
- `allowTransparency` is set once and never changed.
- Dispose every addon before the terminal, and hold a handle to each so you can.
- Three addons are pinned exactly — webgl, ligatures and serialize — and the rest keep ranges.
- Ligatures are activated with the Local Font Access API hidden.
- A multi-line prompt reports its end twice.
- The command a block ran is the shell's answer, never the row it was drawn on.
- Only a session Muster injected into is believed, and the backend is what says so.
- A block's rows are markers, never row numbers.
- Accepting a completion types it into a live shell.
- The completion keys are claimed only while there is something to claim.
- A control drawn over the grid must not sit on the grid's own listener.
- The history file's path is the shell's answer, not a guess.
- A user's own messages are found by cell attribute, not by text.
- Two surfaces mark your messages, and they answer different questions.
- But the mouse is on the other side of that trade, so it is a choice, not a constant.
- The mode control draws both modes, never just the current one.
- And it is offered only where there is a conversation to reopen.
- Clicks mode only clears the way; the CLI still chooses its own renderer.
- A clicks session removes the variable; declining to set it is not enough.
- The app's own links stand down while the agent is reading the mouse.
- An agent's hyperlinks are xterm's, not ours, and they need a handler.
- `macOptionClickForcesSelection` is toggled, never set.
- A clickable session reads its places from the agent, not from the grid.
- There is no scrollbar over that buffer, and there is nothing to draw one from.
- A dot seeks only while the agent is reading the mouse, and that guard is not tidiness.
- A dot seeks instead, and the stall check is the whole feature.
- The filled dot answers a different question on each rail, and only one of them can be measured.
- xterm only writes the scroll area's height when its own record disagrees with it.
- A turn ending is announced two ways, and Claude Code never uses the bell.
- A width change destroys a TUI's scrollback, so the scrollback is dropped rather than shown.
- The path beside the scrollbar is searched upward, never scanned.
- Which line that is was guessed wrong once, and the guess cost the whole feature.
- `findFileBlocks` scans where `fileAbove` walks, and the two are not interchangeable.
- A file mark is a span, and both of its bounds were got wrong once.
- A tab's status is measured, not announced.
- A file drop is a window event, not an element's.

**In [`src-tauri/AGENTS.md`](src-tauri/AGENTS.md)** — the Rust backend:

- Strip agent session markers from every spawned process.
- Sessions run through a login shell — and where they cannot, they imitate one.
- An agent tab hands its terminal to a shell, and the agent never learns.
- A git write is stopped by the thread that waits for it.
- No git the app runs may take its repository from the environment.
- Paths are stored in the host's own form.
- Output is recorded before it is sent, and every bound on it is load-bearing.
- `Channel` payloads must be owned.
- Closing the last window exits the app; minimizing it does not.
- A blocked directory is not a missing one, and `metadata` cannot tell you which.
- Blocked warns; it does not refuse.
- An empty list of past conversations means "let the CLI pick", never "there is nothing".
- Window state is saved on `RunEvent::Exit` too, and for the same reason.
- A reload is the one browser shortcut this app cannot survive.
- `single-instance` is registered first, and it has to be.
- Cleanup runs on `RunEvent::Exit`, not on a window event.
- A tab moves between windows; its process does not.
- A tab dragged off the strip lands where the backend says the cursor is.
- The label that follows a torn-off tab is a window, and it must never count as one.
- A kill names a registration, not a tab.
- A session must be forgotten when its child exits.
- But it must forget its own session, not whatever holds the id now.
- `workspace_info` does not add a `read_dir` unless it is asked to.
- A shell reports its own command boundaries, and nothing else can.
- zsh moves `HISTFILE` when `ZDOTDIR` moves.
- bash cannot be given both `-l` and `--init-file`.
- A pathspec must be literal.
- Nothing is read through a symlink, and the automatic reads are bounded.
- An id another program published is checked once, for two hazards.
- An editor installed on macOS usually has no shell command.
- Windows has no frame, and the two window configs must say the same things.
- A patch must come back from git verbatim.
- Keep command-line building platform-independent.

**In [`src/features/review/AGENTS.md`](src/features/review/AGENTS.md)** — the review panel:

- Nothing in the review panel may need WASM.
- Highlighted code is rendered as elements, never as markup.
- The review surfaces re-read on a revision derived from the tree, never on a clock.
- The review panels mark their own scrollbars, and they measure rows rather than compute them.
- A panel's close button may never be the control that clips.
- The file column never covers the terminal.
- Code in the review panel is the terminal's own type.

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
- **Prettier owns the formatting** (`.prettierrc`). Do not hand-format around it, and do not argue
  with it in review — run `bun run format`. JSX attributes stay double-quoted,
  which is Prettier's own default and reads as the HTML it resembles.
- **Tailwind classes inline**, no `@apply` outside `src/app/index.css`'s base layer.
  Reach for the `@theme` tokens first (`canvas`, `chrome`, `surface`, `line`,
  `ink`, `muted`, `faint`, `primary`, `danger`, `agent`). Claude Code's
  orange is that agent's colour, never the app's: `primary` is the app's own
  accent, for chrome that belongs to no agent, and `agent` is whatever the tab
  is running — set per terminal from that agent's `accent`, a shell's once it
  has handed back — for everything drawn over a session's output. Raw hex is still in use where no
  token fits — the git-status chip colours, the palettes in `src/shared/lib/themes.ts`, an
  agent's `accent` — so prefer promoting a repeated hex to a token over adding
  another one-off.

## TypeScript

`strict` and its companion flags are on (`tsconfig.json`). There is no ESLint, so the
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
  is honestly typed and still throws — see the addon invariant in
  `src/features/terminal/AGENTS.md`. Where a
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

## Releasing

**"Release" means installable, not tagged.** When the instruction is to release,
carry it through until `brew upgrade --cask muster` (or the Scoop equivalent)
actually offers the new version, and say so with the evidence. A green build is
not a release; a published release whose manifests still point at the previous
version is not one either, and it is the state that looks finished from the
Releases page while every user's `brew upgrade` reports nothing to do.

[docs/RELEASE.md](docs/RELEASE.md) is the runbook. The steps that need a human
are the version number and the decision to ship; everything after the tag is
the pipeline's job, and where it cannot do something the reason belongs in this
file rather than in someone's memory. Today that is two things, and both stand
between a built release and an installable one.

`PACKAGES_PAT` is the first: without it the manifests cannot move, because a
tap lives in its own repository and the automatic `GITHUB_TOKEN` is scoped to
this one. The run without it stays **green** — it stops at a gate and writes
the manual steps into its summary — so the colour of that run is not evidence
about the manifests, and only the manifests are.

The second is that nothing starts that workflow. Its trigger is
`release: published`, and a tag's release is published by `release.yml` under
the automatic `GITHUB_TOKEN`, which GitHub does not let raise events that start
other workflows. Publishing on a tag is what made the release reliable and it
is also what broke this, so `gh workflow run update-packages.yml -f
version=<tag>` is a step of every release until the two are reconciled.

Two things are still a person's call and stay that way. **Every push is asked
about first**, including the tag. And an asset is downloaded and opened before
anyone else can, because nothing in CI runs the app — a bundle that builds and
crashes on launch passes every check this repository has.

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
  `resume` mode rather than a second table — and it builds the start screen's
  own list too, so a row there and a row in the drawer launch the same argv.
  Which conversations that list offers comes from the **agent's** store
  (`agent_session_list`), not from the journal: the journal holds only what
  Muster recorded, with recording on, while the store is the same one the
  CLI's picker reads.
- **Shell integration** is `src-tauri/src/shell.rs` and the scripts beside it
  in `src-tauri/shell/`, with `src/features/terminal/model/blocks.ts` reading
  what they report. A shell it has no script for is not a failure: the two
  surfaces are absent and the session is otherwise untouched. Adding one means
  a script, a `Shell` variant and the arguments or environment it needs — and
  measuring what it emits under a pty, never reasoning about it.
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
  is what the "automatic reads are bounded" invariant in `src-tauri/AGENTS.md`
  exists to prevent,
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
