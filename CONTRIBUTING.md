# Contributing

Thanks for looking. This is a small codebase and a small surface — most changes
touch one or two files.

The conventions this repo expects, and the invariants that break quietly if you
miss them, live in [AGENTS.md](AGENTS.md). Read that before your first change;
it applies to people and coding agents alike. This file is the practical part:
how to run it, how to check it, and where things are.

## Stack

Tauri 2 (Rust) for the window and the process work, React 19 + Tailwind 4 for
the interface, xterm.js for the terminals. Bun bundles, serves and tests the
frontend — there is no Vite, and no bundler config beyond `build.ts`.

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
tests run, with the Rust suite only when Rust changed. Run them by hand before
opening a pull request too — `.github/workflows/ci.yml` runs the same set, and
clippy is `-D warnings` there.

```bash
bun run check                     # tsc --noEmit
bun run format:check              # prettier; `bun run format` fixes it
(cd src-tauri && cargo fmt --check) # rustfmt; `cargo fmt` fixes it
bun test                          # settings, deck, flags, git chips, agents,
                                  # recents, shortcuts, paths, notify, editors,
                                  # termlinks
cd src-tauri && cargo test --lib  # git parsing, shell quoting, cwd reading, WSL
                                  # paths, image MIME, link metadata and the SSRF
                                  # guard, session lookup, directory creation,
                                  # editor argv, and the pty killer
cd src-tauri && cargo clippy --all-targets
```

Every command line the backend builds — POSIX, PowerShell and WSL alike — is
assembled by code that compiles on all three hosts, so `cargo test` covers the
Windows and WSL launch paths from a Mac. Keep it that way: put the `cfg` gate on
the _choice_ between them and on process inspection, never on the string
building.

## Where things are

| Piece                                       | Where                             |
| ------------------------------------------- | --------------------------------- |
| PTY sessions, one per tab                   | `src-tauri/src/pty.rs`            |
| Shells, WSL and process inspection per host | `src-tauri/src/platform.rs`       |
| Path, git status and git log                | `src-tauri/src/workspace.rs`      |
| Commands exposed to the frontend            | `src-tauri/src/lib.rs`            |
| Typed wrappers over those commands          | `src/ipc.ts`                      |
| Tab state, as a pure reducer                | `src/deck.ts`                     |
| Settings model and validation               | `src/settings.ts`                 |
| Shortcut bindings per platform              | `src/shortcuts.ts`                |
| Notification policy                         | `src/notify.ts`                   |
| Editor detection and launching              | `src-tauri/src/editor.rs`         |
| Paths and URLs in terminal output           | `src/termlinks.ts`                |
| Local image reads                           | `src-tauri/src/image.rs`          |
| URL metadata fetching                       | `src-tauri/src/link.rs`           |
| Agent session history                       | `src-tauri/src/sessions.rs`       |
| Agent registry                              | `src/agents.ts`                   |
| Terminal ↔ PTY binding                      | `src/components/TerminalView.tsx` |
| New-tab start screen                        | `src/components/Launcher.tsx`     |
| One tab's contents                          | `src/components/Pane.tsx`         |

The shape to keep in mind: `src-tauri` owns processes and the filesystem and
knows nothing about tabs; `src/deck.ts` owns what a tab _is_ and knows nothing
about the DOM; components wire the two together and hold no logic worth testing
on their own. That is why the tests are almost all on plain modules.

## Adding an agent

One entry in `src/agents.ts`, then the roster tests and the two places the
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

- **The first mode must launch with no arguments, and its id must be `"new"`.**
  It is what the launcher offers first and what the default-agent setting starts.
- **Mode ids are load-bearing, not labels.** The tests group modes by
  `id === "continue"` and `id === "resume"`, so a "Continue" mode called
  anything else is invisible to them.
- **Only list a mode the CLI really has.** Antigravity has no resume-picker
  flag, so it has no picker mode — do not paper over a gap with a flag that
  errors. Read the CLI's own `--help`; do not assume it matches a sibling.
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
component needs touching. Four other places do:

- **`src/agents.test.ts`** pins the roster deliberately — the exact command
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

## Style

Match the surrounding code. The parts worth stating:

- Comments explain _why_, in the language's doc-comment form (TSDoc, `///` in
  Rust), and go on the shared helper rather than at each call site. A comment
  that restates the code is noise; a name that makes the comment unnecessary is
  better than both.
- Keep logic out of components. If something is worth a test, it belongs in a
  plain module that a test can call directly — a new `src/<thing>.ts` alongside
  the existing ones is welcome, not a last resort.
- There is no ESLint here, and no lint step among the checks. Nothing will catch
  a wrong hook dependency array for you, so read them.
- Test names read as behaviours — "closing the active tab focuses the one that
  slid into its place", not "test close". Cover the edge that would actually
  bite: an empty deck, a corrupt stored setting, a truncated `git` record.

## Releasing

Bump the version in three files, push a `v*` tag, review the draft release,
publish, then move the Homebrew and Scoop manifests.
[docs/RELEASE.md](docs/RELEASE.md) is the runbook.

## Pull requests

- Run the five checks.
- One commit is fine and preferred; there is no changelog to update.
- Say what you verified by hand, especially for anything touching a PTY,
  process spawning, or a platform you cannot test.
