# Contributing

Thanks for looking. This is a small codebase and a small surface — most changes
touch one or two files.

The conventions this repo expects, and the invariants that break quietly if you
miss them, live in [AGENTS.md](AGENTS.md). Read that before your first change;
it applies to people and coding agents alike. This file is the practical part:
how to run it, how to check it, and where things are.

## Stack

Tauri 2 (Rust) for the window and the process work, React 19 + Tailwind 4 for
the interface, xterm.js for the terminals. The review panel adds Shiki for
syntax highlighting, markdown-it for rendering documents and mermaid for the
diagrams in them — all three loaded on demand, which is why `build.ts` sets
`splitting: true`. Bun bundles, serves and tests the frontend — there is no
Vite, and no bundler config beyond `build.ts`.

## Setup

```bash
bun install
```

You need [Bun](https://bun.sh) and a [Rust toolchain](https://rustup.rs). The
exact Bun version is in `.bun-version`, which is what CI installs — a newer Bun
rewrites `bun.lock` and would fail CI's `--frozen-lockfile` on a lockfile that
is fine locally. Bump that file and the lockfile together.
On Debian or Ubuntu also install `libwebkit2gtk-4.1-dev`, `build-essential`,
`libssl-dev`, `libappindicator3-dev`, `librsvg2-dev` and `patchelf`. CI installs
a subset of these (see `.github/workflows/ci.yml`); a local build wants them all.

## Running

```bash
bun run dev      # tauri dev; Bun serves the frontend on :1420 with hot reload
bun run build    # typecheck, bundle, then produce this platform's installers
```

Frontend edits hot-reload. Rust edits trigger a rebuild and restart the window,
which drops every running session — expect that when working in `src-tauri/`.

`bun run serve` runs the frontend alone in a browser. Useful for laying out a
component, but every `invoke` fails there: nothing outside the Tauri window has
a backend.

## Checks

A `husky` pre-commit hook runs these for you: `lint-staged` formats the staged
files (Prettier for everything, `rustfmt` for Rust), then the typecheck and
tests run, with `bun run check:rust` only when Rust changed — the hook calls the
same script as CI, so neither can quietly check less than the other. Run them by
hand before opening a pull request too — `.github/workflows/ci.yml` runs the same set, and
clippy is `-D warnings` there.

`bun run check:all` is all seven, and `bun run check:rust` the four Rust ones.
Spelled out, because knowing which one failed is the point:

```bash
bun run check                     # tsc --noEmit
bun run format:check              # prettier; `bun run format` fixes it
(cd src-tauri && cargo fmt --check) # rustfmt; `cargo fmt` fixes it
cd src-tauri && cargo check --all-targets  # rustc alone: a compile error reads
                                  # better here than through clippy or a test
                                  # binary that never built
bun test                          # settings, deck, persist, flags, git chips,
                                  # branches, agents, recents, shortcuts, paths,
                                  # notify, editors, themes, clipboard,
                                  # termlinks, termcells, diff parsing, changed
                                  # files, highlighting, the file tree, file
                                  # icons, markdown rendering, font metrics,
                                  # panel widths, the code style, image paths,
                                  # byte sizes, the agent combobox — and
                                  # `test/layers`, which
                                  # enforces the import direction
cd src-tauri && cargo test --lib  # git parsing, shell quoting, cwd reading, WSL
                                  # paths, image MIME, link metadata and the SSRF
                                  # guard, session lookup, directory creation,
                                  # editor argv, diff and numstat parsing, drop
                                  # text and what it refuses, literal pathspecs,
                                  # symlink refusal, verbatim patches, ignored
                                  # entries, and the pty killer
cd src-tauri && cargo clippy --all-targets
```

Every command line the backend builds — POSIX, PowerShell and WSL alike — is
assembled by code that compiles on all three hosts, so `cargo test` covers the
Windows and WSL launch paths from a Mac. Keep it that way: put the `cfg` gate on
the _choice_ between them and on process inspection, never on the string
building.

## Where things are

| Piece                                              | Where                                         |
| -------------------------------------------------- | --------------------------------------------- |
| PTY sessions, one per tab                          | `src-tauri/src/pty.rs`                        |
| Shells, WSL and process inspection per host        | `src-tauri/src/platform.rs`                   |
| Path, git status, log, branches and checkout       | `src-tauri/src/workspace.rs`                  |
| Commands exposed to the frontend                   | `src-tauri/src/lib.rs`                        |
| Typed wrappers over those commands                 | `src/shared/ipc.ts`                           |
| Tab state, as a pure reducer                       | `src/entities/tab/model/deck.ts`              |
| Settings model and validation                      | `src/entities/preferences/model/settings.ts`  |
| Shortcut bindings per platform                     | `src/entities/preferences/model/shortcuts.ts` |
| Notification policy                                | `src/shared/lib/notify.ts`                    |
| Editor detection and launching                     | `src-tauri/src/editor.rs`                     |
| Terminal colour schemes                            | `src/shared/lib/themes.ts`                    |
| Clipboard key decisions                            | `src/features/terminal/model/clipboard.ts`    |
| Remembering tabs across a restart                  | `src/entities/tab/model/persist.ts`           |
| Branch filtering and switch warnings               | `src/features/workspace/model/branches.ts`    |
| Git chips, and the revision everything re-reads on | `src/features/workspace/model/status.ts`      |
| Paths and URLs in terminal output                  | `src/features/terminal/model/termlinks.ts`    |
| Local image reads                                  | `src-tauri/src/image.rs`                      |
| URL metadata fetching                              | `src-tauri/src/link.rs`                       |
| Agent session history                              | `src-tauri/src/sessions.rs`                   |
| Agent registry                                     | `src/entities/agent/model/agents.ts`          |
| Terminal ↔ PTY binding                             | `src/features/terminal/ui/TerminalView.tsx`   |
| New-tab start screen                               | `src/features/launch/ui/Launcher.tsx`         |
| One tab's contents                                 | `src/widgets/pane/ui/Pane.tsx`                |
| Changed files, diffs, file reads, listings         | `src-tauri/src/review.rs`                     |
| Unified-diff parsing                               | `src/features/review/model/diff.ts`           |
| Changed-file ordering and path matching            | `src/features/review/model/changes.ts`        |
| Syntax highlighting, and which grammar             | `src/features/review/model/highlight.ts`      |
| Type the review panel borrows from the terminal    | `src/features/review/model/codestyle.ts`      |
| What the file tree shows                           | `src/features/review/model/tree.ts`           |
| The review drawer: lists and navigation            | `src/features/review/ui/ReviewPanel.tsx`      |
| The changed-file list                              | `src/features/review/ui/ChangedFiles.tsx`     |
| The file tree, a folder at a time                  | `src/features/review/ui/FileTree.tsx`         |
| One line of coloured code                          | `src/features/review/ui/TokenLine.tsx`        |
| Reading changes, diffs and directories             | `src/features/review/model/use*.ts`           |
| The column a diff or a file is read in             | `src/features/review/ui/FileViewer.tsx`       |
| Markdown rendering, and what it refuses            | `src/features/review/model/markdown.ts`       |
| Mermaid drawing and image loading                  | `src/features/review/ui/MarkdownView.tsx`     |
| Matching xterm's cell size in CSS                  | `src/shared/lib/fontmetrics.ts`               |
| The diff, rendered row by row                      | `src/features/review/ui/DiffView.tsx`         |
| A whole file, as text or as a picture              | `src/features/review/ui/CodePreview.tsx`      |
| Reading a file as text, once, for both             | `src/features/review/model/useTextFile.ts`    |
| What the column is showing                         | `src/features/review/model/viewed.ts`         |
| Opening a file at a line in the editor             | `src/features/review/model/openline.ts`       |
| A panel edge you can drag                          | `src/shared/ui/DragEdge.tsx`                  |
| The menu a right-click opens                       | `src/shared/ui/ContextMenu.tsx`               |
| The agent picker, filterable                       | `src/shared/ui/Combobox.tsx`                  |
| Byte sizes as a person reads them                  | `src/shared/lib/bytes.ts`                     |
| Material icons, and which file gets which          | `src/shared/ui/`                              |
| Text a dropped file types                          | `src-tauri/src/platform.rs`                   |
| Drawer widths, dragged and remembered              | `src/shared/lib/usePanelWidth.ts`             |
| Which paths are images                             | `src/shared/lib/imagepaths.ts`                |

The shape to keep in mind: `src-tauri` owns processes and the filesystem and
knows nothing about tabs; `src/entities/tab/model/deck.ts` owns what a tab _is_
and knows nothing about the DOM; components wire the two together and hold no
logic worth testing on their own. That is why the tests are almost all on plain
modules.

## The client's layers

```
src/app/        composition root — App, main, the stylesheet, shortcut wiring
src/widgets/    surfaces that compose several features — Pane, TabStrip
src/features/   one capability each — terminal, workspace, launch, settings,
                review
src/entities/   vocabulary features share — tab, agent, preferences
src/shared/     ipc.ts, lib/ for contained libraries, ui/ for presentation
                with no domain in it
```

Imports go strictly downward, never sideways between slices on one layer, and
`test/layers.test.ts` fails the suite when they do not. [AGENTS.md](AGENTS.md)'s
Architecture section has the rule, why the layers exist, and where a new file
goes.

## Adding an agent

One entry in `src/entities/agent/model/agents.ts`, then the roster tests and the two places the
roster is written out by hand. Start with the entry:

```ts
{
  id: "mycli",
  name: "My CLI",
  command: "mycli",        // resolved through the user's login shell
  accent: "#4e8df5",       // tab underline, dot, and selected-state border
  acceptsFlags: true,      // false only for something that takes no arguments
  modes: [
    { id: "new", label: "New session", hint: "Start fresh in this directory", args: [] },
    { id: "continue", label: "Continue", hint: "Reopen the most recent session", args: ["--continue"] },
  ],
}
```

Rules the tests enforce, and the reasons for them:

- **The first mode must be the plain start, and its id must be `"new"`.** It is
  what the launcher offers first and what the default-agent setting starts.
  Usually that means no arguments at all; where a CLI has no bare form the
  first mode carries whatever does start it — `goose` has none, so its first
  mode is `["session"]`, and the roster test names that exception rather than
  letting the rule quietly weaken.
- **Mode ids are load-bearing, not labels.** The tests group modes by
  `id === "continue"` and `id === "resume"`, so a "Continue" mode called
  anything else is invisible to them.
- **Only list a mode the CLI really has.** Antigravity has no resume-picker
  flag, so it has no picker mode — do not paper over a gap with a flag that
  errors. Read the CLI's own `--help`; do not assume it matches a sibling.
  Where the CLI is not installed here, its own documentation is the source, and
  a mode nothing documents is left off: half the roster offers New only for
  exactly that reason. `agents.test.ts` pins every one of those absences as
  `undefined`, so adding a mode later means saying so in the test.
- **`acceptsFlags` must be `true` for every entry in `AGENTS`.** A test asserts
  it, and `SHELL_AGENT` is the only place `false` is legal — the login shell is
  the session itself, with no program to pass flags to. If you meet a real agent
  CLI that takes no arguments, that test is the thing to change. Note the drop
  happens in the frontend: `Launcher.tsx` computes
  `agent.acceptsFlags ? splitFlags(flags) : []`, so the backend never sees them.
- **Id, command and accent are all unique.** `agentById` falls back to the first
  agent, so a duplicate id would shadow rather than fail; a shared accent makes
  two tabs indistinguishable.

The launcher, settings picker and status bar all read the registry, so no
component needs touching. The other places that follow:

- **`src/entities/agent/model/agents.test.ts`** pins the roster deliberately — the exact command
  list, each agent's continue dialect, which agents offer a picker, and accent
  uniqueness. Update those assertions in the same change; a new entry turns the
  suite red until you do, and that is the point.
- **`README.md`**'s agent table, which users read.
- **`package.json`**'s `keywords`, which name the supported agents.
- **`src-tauri/src/pty.rs`**, _if_ the new CLI exports session-scoped
  environment variables of its own — the marker invariant in
  [AGENTS.md](AGENTS.md) says how to find out.
- **`src-tauri/src/sessions.rs`**, which decides whether the new agent's
  Continue and Resume modes are offered at all. An agent whose session store it
  does not know returns `None`, which leaves both modes enabled.

## Adding an icon

`src/shared/ui/icons.ts` holds Material Symbols as path data, all on Material's
own `0 -960 960 960` viewBox, so `Icon` can draw any of them. To add one, take
the `d` attribute from the outlined set and paste it in:

```bash
bun add -d @material-symbols/svg-400
cat node_modules/@material-symbols/svg-400/outlined/<name>.svg
bun remove @material-symbols/svg-400
```

The package is not a dependency — it exists only for this. Keep the key the
icon's own Material name, because that is what makes the next one findable.

## Where the tests live

Beside what they test, in both languages. TypeScript pairs `x.ts` with
`x.test.ts`; Rust pairs `x.rs` with `x_tests.rs`, attached as a child module so
it can still reach private items:

```rust
#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
```

A sibling `mod` would only see the public surface, and widening visibility just
to test something is the wrong trade. The point of the split is that
`workspace.rs` and `pty.rs` were nearly half test code, which made the parts
that ship hard to read.

## Accessibility

Level AA, and [AGENTS.md](AGENTS.md)'s Accessibility section says what that has
meant in practice. The two checks worth running on anything you add to the
chrome: Tab through it with the mouse untouched, and read the control's
accessible name out loud — if it is `~24` or `12`, it needs an `aria-label`.
Colour on its own never carries meaning; where a glyph is `aria-hidden`, an
`sr-only` word has to stand in for it.

## Style

Match the surrounding code. The parts worth stating:

- Comments explain _why_, in the language's doc-comment form (TSDoc, `///` in
  Rust), and go on the shared helper rather than at each call site. A comment
  that restates the code is noise; a name that makes the comment unnecessary is
  better than both.
- Keep logic out of components. If something is worth a test, it belongs in a
  plain module a test can call directly — a new file in the relevant slice's
  `model/` segment is welcome, not a last resort.
- There is no ESLint here, and no lint step among the checks. Nothing will catch
  a wrong hook dependency array for you, so read them.
- Test names read as behaviours — "closing the active tab focuses the one that
  slid into its place", not "test close". Cover the edge that would actually
  bite: an empty deck, a corrupt stored setting, a truncated `git` record.

## Releasing

Bump the version in three files, push a `v*` tag, review the draft release,
publish, then move the Homebrew and Scoop manifests.
[docs/RELEASE.md](docs/RELEASE.md) is the runbook.

## Verifying an install

The install instructions in the README cannot be tested from a machine that
already has the app: Homebrew trusts a cask it has installed before and keeps
its tap, so the two failures that matter — an untrusted tap and a record that
disagrees with `/Applications` — are both invisible to you. Wipe first.

```bash
brew uninstall --cask --force muster
brew untap ronny1020/tap
find "$(brew --cache)" -maxdepth 2 -iname '*muster*' -exec rm -rf {} +
# `untap` does not drop trust, and a retained entry is what makes a "cold"
# machine quietly not cold.
brew untrust --cask ronny1020/tap/muster
```

Then run the README's own command rather than one you have retyped — copy it
out of the published README, so a stale instruction shows up as a failure — and
check all three starting states:

1. **Cold** — nothing installed. Expect `Tapping` → `Trusted cask` → installed.
2. **Stale record** — move the app out of `/Applications` by hand, leaving
   Homebrew's record. Expect `Warning: Not upgrading muster, the latest version
is already installed` and nothing installed —
   `brew reinstall --cask ronny1020/tap/muster` is the repair.
3. **Already installed** — expect the install to no-op and the quarantine
   attribute to be cleared anyway.

Finish by launching the bundle by full path (`open /Applications/Muster.app`),
not by name — `open -a Muster` can resolve to a local `cargo build` bundle and
tell you the install worked when it did not. Confirm the running binary with
`pgrep -fl "MacOS/muster"`.

## Pull requests

- Run the six checks.
- One commit is fine and preferred; there is no changelog to update.
- Write the subject as a
  [Conventional Commit](https://www.conventionalcommits.org) —
  `type(scope): summary`, from `feat`, `fix`, `docs`, `refactor`, `test`,
  `build`, `ci`, `chore` — in the imperative and without a trailing full stop.
  No hook checks this. Put the reasoning in the body rather than the subject.
- Say what you verified by hand, especially for anything touching a PTY,
  process spawning, or a platform you cannot test.
