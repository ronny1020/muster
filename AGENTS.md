# AGENTS.md

Conventions for working in this repository. Written for coding agents, and just
as true for people.

**What this is:** a desktop app that runs AI agent CLIs in Chrome-style tabs.
Tauri 2 (Rust) owns the window, the PTYs and the filesystem; React 19 +
Tailwind 4 draw the interface; xterm.js renders each terminal. Bun bundles,
serves and tests the frontend.

Practical setup, commands and file map: [CONTRIBUTING.md](CONTRIBUTING.md).

## Before you claim a change works

All six. The first three run from the repo root, the last three from
`src-tauri`:

```bash
bun run check
bun run format:check
bun test
(cd src-tauri && cargo fmt --check)
(cd src-tauri && cargo test --lib)
(cd src-tauri && cargo clippy --all-targets)
```

`bun run format` and `cargo fmt` fix what the two format checks report.

A husky pre-commit hook covers _some_ of this: `lint-staged` formats the staged
files, then `bun run check` and `bun test` run. It does not run either format
check (it formats instead), and it runs the Rust suite and clippy only when a
`.rs` file is staged. Run the six by hand before a pull request.

None of them lints: there is no ESLint in this repo and no lint step. A wrong
hook dependency array — re-running the spawn effect, say — fails silently with
nothing to catch it, so read every dependency list you touch.

A green typecheck is not a passing test, and neither one exercises a PTY. If
you changed process spawning, terminal behaviour, or anything in the window
chrome, say plainly that you did not run it, or run it: `bun run dev`, then
report what you saw.

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
development. `src/main.tsx` says so — leave it.

**Tailwind needs `@source "../src"`.** In `src/index.css`. The dev server and
the production build resolve their scan root differently, and without it the dev
build silently emits no custom utilities.

**`Channel` payloads must be owned.** PTY output goes over
`Channel<InvokeResponseBody>` and sends `InvokeResponseBody::Raw(...)`. A
borrowed `&[u8]` cannot outlive the command, and the reader thread needs it to.

**Keep command-line building platform-independent.** POSIX, PowerShell and WSL
argv construction in `src-tauri/src/platform.rs` compiles on every target so
`cargo test` covers all three from any host. `cfg`-gate the _choice_ between
them and the process inspection, never the string building.

## Architecture

Dependencies point one way:

- `src-tauri/` owns processes, git and the filesystem. It knows nothing about
  tabs.
- `src/deck.ts` owns what a tab _is_ — a pure reducer over `Deck`. It knows
  nothing about the DOM. Tab behaviour worth arguing about belongs here, where a
  test can reach it.
- `src/settings.ts`, `src/notify.ts`, `src/shortcuts.ts`, `src/git.ts`,
  `src/flags.ts`, `src/paths.ts`, `src/recents.ts`, `src/termlinks.ts` and `src/termcells.ts` are
  plain modules: no React, no runtime IPC, each with its own test file. (`src/platform.ts` sits
  beside them but does call `invoke`, and has no test of its own.) A new
  `src/<thing>.ts` beside them is the right home for new logic — the list is
  what exists, not a closed set.
- Components wire those together and hold no logic worth testing alone.

When you find yourself wanting a test for something inside a component, that is
the signal to move it into a module first.

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
- **Tailwind classes inline**, no `@apply` outside `src/index.css`'s base layer.
  Reach for the `@theme` tokens first (`canvas`, `chrome`, `surface`, `line`,
  `ink`, `muted`, `faint`, `brand`, `danger`). Raw hex is still in use where no
  token fits — the git-status chip colours, the xterm `THEME` palette, an
  agent's `accent` — so prefer promoting a repeated hex to a token over adding
  another one-off.

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

## Scope

Change this repository only. If a fix seems to require editing a dependency or
another repo, stop and say so.

Two files are the seams for common asks:

- **A new agent** starts as one entry in `src/agents.ts`, but the roster is also
  pinned by `src/agents.test.ts` and written out in `README.md` and
  `package.json`'s keywords. CONTRIBUTING.md's "Adding an agent" lists every
  rule the tests enforce and every file that follows.
- **A new user-facing preference** is one field in `src/settings.ts` — with its
  fallback in `normalizeSettings` — plus one row in `SettingsPane`.
