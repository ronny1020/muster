# Muster

Run your AI agent CLIs in one window, in tabs, the way a browser holds pages.

Every tab is a real terminal in its own directory, so `claude`, `codex` and
`agy` behave exactly as they do in your usual terminal — full TUI, colours,
keyboard and all. What the app adds is everything around them: tabs across the
top, the directory and its git state along the bottom, a commit history you can
pull open, and a notification when an agent finishes and wants you back.

_To muster:_ to assemble a force, and to look it over. The launcher musters an
agent; the status bar and the history drawer are the looking over.

Runs on macOS, Windows and Linux. On Windows a tab can run inside WSL.

## Install

> The Homebrew tap and Scoop bucket below are not published yet. Until they
> are, take the installer from the Releases page.

The download is the whole app on macOS and Linux. On Windows the installer
fetches Microsoft's WebView2 runtime if the machine does not already have it.

**macOS**

```bash
brew install --cask --no-quarantine ronny1020/tap/muster
```

`--no-quarantine` is what saves you the Gatekeeper dance below. If you would
rather take the `.dmg` from the
[Releases page](https://github.com/ronny1020/muster/releases), clear the
quarantine flag yourself once it is in place:

```bash
xattr -cr /Applications/Muster.app
```

**Windows**

```powershell
scoop bucket add ronny1020 https://github.com/ronny1020/scoop-bucket
scoop install muster
```

Or run the `_x64-setup.exe` from the Releases page. SmartScreen will call it an
unrecognised app: choose **More info → Run anyway**. It installs for the current
user, so no admin prompt.

**Linux** — from the Releases page:

| File        | Install                                             |
| ----------- | --------------------------------------------------- |
| `.AppImage` | `chmod +x Muster_*.AppImage && ./Muster_*.AppImage` |
| `.deb`      | `sudo apt install ./muster_*.deb`                   |
| `.rpm`      | `sudo dnf install ./muster-*.rpm`                   |

### Why the warnings

This project has not bought a code-signing certificate — an Apple Developer
membership and a Windows certificate cost real money, and it has no users yet
to justify it. So macOS sees an app that is only ad-hoc signed, and Windows
sees an unsigned installer, and both say so.

What you get instead of a signature: every binary is built in public by GitHub
Actions from the tag it claims to be, in a workflow you can read
([`.github/workflows/release.yml`](.github/workflows/release.yml)). The Homebrew
and Scoop routes additionally verify a checksum recorded in their manifests.

### Privacy

Muster makes no network requests of its own. It has no telemetry, no update
check, and no accounts — it reads your filesystem and git state, and runs the
CLIs you point it at, locally. Those CLIs do talk to their own providers, on
their own terms, exactly as they would in your usual terminal.

The agent CLIs are separate, and Muster deliberately does not bundle them.
Install whichever you use — `claude`, `codex`, `agy` — and check each runs in
your own terminal first; Muster finds them exactly the way your shell does.

Building from source instead is a few commands, and needs a Bun and Rust
toolchain: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Using it

A new tab opens on a start screen: choose a **directory** (recent ones are one
click away, or browse for it), an **agent**, and how the session should open.
Pick a mode and the terminal takes over the tab.

| Agent       | Command          | New session | Continue          | Pick from past       |
| ----------- | ---------------- | ----------- | ----------------- | -------------------- |
| Claude Code | `claude`         | ✓           | most recent       | ✓                    |
| Codex       | `codex`          | ✓           | most recent       | ✓                    |
| Antigravity | `agy`            | ✓           | last conversation | `/resume` in its TUI |
| Shell       | your login shell | ✓           | —                 | —                    |

**Shell** is there for the times you want a plain terminal in the same window —
it takes no flags, because there is no program to pass them to.

**A directory that does not exist yet** is not an error: Muster offers to create
it, parents included, and starts the session there once you confirm. `~` means
home, so `~/code/new-thing` lands where you would expect.

**Extra flags** passes anything else straight through — `--model opus`, say.
Quoted values stay in one piece.

**Tabs keep running while you look at another one.** Nothing restarts and no
scrollback is lost, so leaving an agent to work and coming back later is the
normal way to use this.

## The status bar

Along the bottom of each tab:

- **The directory**, shortened with `~`. Click it to open that folder in Finder,
  Explorer, or your file manager.
- **The branch**, or `detached @ 1a2b3c4` when there is no branch. Click it for
  the history drawer.
- **`↑2 ↓1`** — commits you have not pushed, and commits waiting to be pulled.
- **`+3 ~5 ?2 !1`** — staged, modified, untracked and conflicted files. A clean
  tree just says `clean`.
- **Open in …** — opens the current directory in your editor. It finds whichever
  of VS Code (including Insiders), Cursor, Antigravity, Windsurf, Zed, Sublime
  Text, the JetBrains IDEs, VSCodium, Neovim or Vim you have, and Settings picks
  between them.

`cd` somewhere else in the terminal and all of it follows you. Not on Windows,
which offers no way to read another process's directory: a tab there stays on
the folder it started in, and the tooltip says so.

## Clicking things in the output

Agents print paths and URLs constantly, and all of them are live:

| You click                          | Muster does                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| An image path — `/tmp/shot.png`    | Opens it in a preview overlay                                                                   |
| Any other path — `src/deck.ts:187` | Opens it in your editor; VS Code, Cursor, Windsurf, VSCodium and Insiders also jump to the line |
| A URL                              | Shows a card with the page's title, description and preview image, and a button to open it      |

Paths resolve against the tab's current directory, so `src/App.tsx` works as
well as an absolute path, and `~` means home. A path is only underlined when it
carries a separator — otherwise every sentence mentioning `package.json` would
light up.

Tools that emit images as terminal escape sequences work too: Sixel and
iTerm2's inline-image protocol are both supported, so `imgcat`, `chafa
--format=sixel` and `timg` render in place.

Muster reads a URL's metadata only when you click it, never as output scrolls
past — a page fetched automatically would turn any URL an agent printed into a
tracking pixel. A URL that points straight at a private or loopback address is
refused.

> Known gap: that check runs on the URL you clicked, not on each hop of a
> redirect, so a public page can still redirect the fetch to a private address.
> Treat clicking an untrusted link as a request that may reach your own network.

## History

Click the branch name, or press the history shortcut, for a drawer on the right
listing that directory's commits — subject, branch and tag badges, short sha,
author and age. A dot marks commits that are not on the remote yet. It reloads
when the directory or branch changes, and there is a refresh button for when you
want it sooner.

## Notifications

Agents ring the terminal bell when they finish a turn and hand control back, so
that is the moment you hear about:

- the tab's dot lights up and pulses, and
- a desktop notification names the agent and the tab.

Nothing fires while you are already looking at that tab, and a burst of bells
becomes a single notification. Sessions that end are announced the same way,
with the exit code when they failed. All of it is adjustable, including off.

## Settings

Press the settings shortcut or click the gear at the right of the tab strip.
Settings open as a tab, and changes take effect immediately — including in
terminals that are already running.

- **New tabs** — which agent and directory to start on.
- **Terminal** — font, size, line height, scrollback, blinking cursor.
- **Editor** — which editor the status bar's button opens.
- **Notifications** — whether to notify, whether to stay quiet on the tab you
  are watching, whether to play a sound.
- **Git** — how often to re-read status, how many commits history loads.
- **Data** — clear remembered directories, or restore every default.

On Windows with WSL installed, **New tabs** also chooses between Windows and a
distro.

## Shortcuts

| Action              | macOS         | Windows / Linux                 |
| ------------------- | ------------- | ------------------------------- |
| New tab             | `⌘T`          | `Ctrl+Shift+T`                  |
| Close tab           | `⌘W`          | `Ctrl+Shift+W`                  |
| Toggle git history  | `⌘Y`          | `Ctrl+Shift+Y`                  |
| Settings            | `⌘,`          | `Ctrl+,`                        |
| Jump to tab 1–8     | `⌘1`–`⌘8`     | `Ctrl+1`–`Ctrl+8`               |
| Jump to last tab    | `⌘9`          | `Ctrl+9`                        |
| Previous / next tab | `⌘⇧[` / `⌘⇧]` | `Ctrl+PageUp` / `Ctrl+PageDown` |

Middle-click a tab to close it. Every other key goes to the agent untouched.

## If something looks wrong

**"command not found" when a session starts.** That agent's CLI is not
installed, or is not on the `PATH` your login shell sets up. Check that the
command from the table above runs in your own terminal.

**No desktop notifications.** Grant the app notification permission when your OS
asks, or later in system settings. The tab dot works either way.

**A tab says `exited 1` immediately.** The agent itself refused to start —
scroll up in that tab, its own output says why.

## Your data

Settings and remembered directories are stored by the app; there is no config
file to edit yet. Nothing leaves your machine — the app only runs the CLIs you
pick, locally.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, the checks, and how to add
another agent. [AGENTS.md](AGENTS.md) holds the conventions, for people and
coding agents alike.

MIT licensed — see [LICENSE](LICENSE).
