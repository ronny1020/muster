# Muster

**A terminal built for AI agent CLIs.**

<!-- Screenshot goes here, as docs/screenshot.png:
![Muster on macOS: the launcher, with the agent roster and the New / Continue / Resume choice](docs/screenshot.png)
-->

`claude`, `codex` and `agy` run exactly as they do in your usual terminal — a
real PTY, full TUI, colours, keyboard and all. What Muster adds is the part a
terminal has no way to know: which agent a tab is running, whether it has a
conversation worth resuming, when it has stopped and wants you back, and what it
did to your working tree while you were reading another tab.

Tabs are not the point — Windows Terminal and PowerShell have had those for
years. The point is that Muster knows what is _in_ the tab:

- 🎯 **The launcher asks which agent**, then offers New, Continue or Resume — and
  greys out the ones that would fail, because it checks for a recorded
  conversation in that directory first instead of letting the CLI print
  `No conversation found to continue`.
- 🧹 **Agent session markers are stripped from every tab**, so an agent launched
  from inside another agent still records its own transcript. Without that,
  `--continue` later finds nothing.
- 🐚 **Sessions run through a login shell**, so a CLI installed by your own profile
  — mise, nvm, `~/.local/bin` — is found. A GUI app otherwise inherits a bare
  `PATH` and none of them exist.
- 🔔 **A finished agent raises a dot on its tab and a desktop notification**,
  because the reason to run several is that you are not watching this one.
- 🌿 **The footer follows the directory and its git state** as the agent changes
  it, and the drawer switches branches without leaving the tab.
- 🔍 **Click a file the agent just changed and its diff opens beside the
  terminal**, syntax-highlighted, with the file tree next to it. Reviewing what
  an agent did is the other half of running one.
- 🖱️ **Paths, URLs and images in the output are clickable.** Agent output is full
  of them, and dropping a file on a tab types its path.

_To muster:_ to assemble a force, and to look it over. The launcher musters an
agent; the status bar and the history drawer are the looking over.

Runs on macOS, Windows and Linux. On Windows a tab can run inside WSL.

## 📦 Install

The download is the whole app on macOS and Linux. On Windows the installer
fetches Microsoft's WebView2 runtime if the machine does not already have it.

**macOS**

```bash
brew install --cask ronny1020/tap/muster && xattr -cr /Applications/Muster.app
```

Run it as one line. It adds the tap, installs the app, and clears the quarantine
attribute that would otherwise stop macOS from opening it. Then launch Muster
from Applications.

Or take the `.dmg` from the
[Releases page](https://github.com/ronny1020/muster/releases): drag it to
Applications, then run the same `xattr -cr /Applications/Muster.app`, or
right-click → _Open_ the first time.

To uninstall, `brew uninstall --cask ronny1020/tap/muster` — dragging the app to
the Trash leaves Homebrew's record of it behind.

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
| `.deb`      | `sudo apt install ./Muster_*_amd64.deb`             |
| `.rpm`      | `sudo dnf install ./Muster-*.x86_64.rpm`            |

### ⚠️ Why the warnings

This project has not bought a code-signing certificate — an Apple Developer
membership and a Windows certificate cost real money, and it has no users yet
to justify it. So macOS sees an app that is only ad-hoc signed, and Windows
sees an unsigned installer, and both say so.

On macOS that is also why the install command ends in `xattr -cr`: Homebrew
quarantines every cask it installs, and Gatekeeper refuses to open a quarantined
copy that is not notarized. Homebrew 6 removed the `--no-quarantine` flag that
used to skip the step.

What you get instead of a signature: every binary is built in public by GitHub
Actions from the tag it claims to be, in a workflow you can read
([`.github/workflows/release.yml`](.github/workflows/release.yml)). The Homebrew
and Scoop routes additionally verify a checksum recorded in their manifests.

### 🕶️ Privacy

Muster makes no network requests of its own. It has no telemetry, no update
check, and no accounts — it reads your filesystem and git state, and runs the
CLIs you point it at, locally. Those CLIs do talk to their own providers, on
their own terms, exactly as they would in your usual terminal.

The agent CLIs are separate, and Muster deliberately does not bundle them.
Install whichever you use — `claude`, `codex`, `agy` — and check each runs in
your own terminal first; Muster finds them exactly the way your shell does.

Building from source instead is a few commands, and needs a Bun and Rust
toolchain: see [CONTRIBUTING.md](CONTRIBUTING.md).

## 🚀 Using it

A new tab opens on a start screen: choose a **directory** (recent ones are one
click away, or browse for it), an **agent** — type to filter the list, since
there are nine of them — and how the session should open. The
shell is not among them; its button sits between the agent list and the
modes.
Pick a mode and the terminal takes over the tab.

| Agent       | Command         | New session | Continue          | Pick from past       |
| ----------- | --------------- | ----------- | ----------------- | -------------------- |
| Claude Code | `claude`        | ✓           | most recent       | ✓                    |
| Codex       | `codex`         | ✓           | most recent       | ✓                    |
| OpenCode    | `opencode`      | ✓           | most recent       | —                    |
| Gemini CLI  | `gemini`        | ✓           | —                 | —                    |
| Goose       | `goose session` | ✓           | most recent       | —                    |
| OpenClaw    | `openclaw`      | ✓           | —                 | —                    |
| Hermes      | `hermes`        | ✓           | —                 | —                    |
| Aider       | `aider`         | ✓           | —                 | —                    |
| Antigravity | `agy`           | ✓           | last conversation | `/resume` in its TUI |

Two of those command names are shared with unrelated tools — `goose` is also a
database-migration CLI, and `hermes` is React Native's JavaScript engine. Muster
runs whichever one your `PATH` finds first, so if a tab starts the wrong
program, that is why.

A dash under Continue means that CLI documents no flag for it, not that Muster
forgot: a flag a CLI does not have makes it refuse to start, so the mode is
left off rather than guessed at. Several of them keep their own history anyway
and pick it up when you start them.

**Open a plain shell instead** is there for the times you want a plain
terminal in the same window — it takes no flags, because there is no program to
pass them to, which is why it sits beside the agent list rather than in it.

**A directory that does not exist yet** is not an error: Muster offers to create
it, parents included, and starts the session there once you confirm. `~` means
home, so `~/code/new-thing` lands where you would expect.

**Extra flags** passes anything else straight through — `--model opus`, say.
Quoted values stay in one piece.

**Tabs keep running while you look at another one.** Nothing restarts and no
scrollback is lost, so leaving an agent to work and coming back later is the
normal way to use this.

**The tabs are the title bar.** On macOS they sit inside the system one, behind
the traffic lights; on Windows there is no system title bar at all, and the
minimize, maximize and close buttons are drawn at the right of the strip — so
you get one row of window chrome rather than two stacked. Dragging the strip
moves the window and double-clicking it maximizes, as a title bar should.
Linux keeps its desktop's own decorations above the strip.

## 📊 The status bar

Along the bottom of each tab:

- **The directory**, shortened with `~`. Click it for the file tree — it names
  the tree, so it opens the tree.
- **The branch**, or `detached @ 1a2b3c4` when there is no branch. Click it for
  the history drawer.
- **`↑2 ↓1`** — commits you have not pushed, and commits waiting to be pulled.
  Click them for the history drawer, which is where commits are.
- **`+3 ~5 ?2 !1`** — staged, modified, untracked and conflicted files, as one
  button. Click it for the review drawer's Changes view, which is where those
  files are. A clean tree just says `clean`, and goes nowhere.
- **`src/auth.ts also in …`** — a file another tab is changing at the same time.
  See "When two tabs touch one file".
- **The Earlier sessions button** — conversations recorded in this directory,
  with a way back into one. See "Earlier sessions".
- **Open in …** — opens the current directory in your editor. It finds whichever
  of VS Code (including Insiders), Cursor, Antigravity IDE, Windsurf, Zed,
  Sublime Text, the JetBrains IDEs, VSCodium, Neovim or Vim you have, and
  Settings picks between them. On macOS an installed editor is found even
  without its shell command — VS Code's `code` only exists if you ran "Shell
  Command: Install 'code' command" from its palette, and most people never
  have.
- **The gear**, at the far right, opens Settings. The bar is there on every
  tab, including one that has not launched anything yet, so the gear always is
  too.

Each of those names what it shows rather than toggling something: clicking the
directory while the tree is already up closes the drawer, but clicking the
change counts switches it to Changes instead. The drawer remembers which view
you left it on.

Quitting with an agent still working asks first, and says how many sessions are
running — then ends them, and anything they started, rather than leaving a dev
server behind.

Tabs come back when you reopen the app: each one returns as a launcher with its
directory and agent already chosen, one click from going. The session itself is
not resumed — that would restart the agent mid-thought — so `Continue` is right
there when the conversation is what you want back.

`cd` somewhere else in the terminal and all of it follows you. Not on Windows,
which offers no way to read another process's directory: a tab there stays on
the folder it started in, and the tooltip says so.

## 🖱️ Clicking things in the output

Agents print paths and URLs constantly, and all of them are live:

| You click                                                      | Muster does                                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A file the agent changed — `src/features/review/model/diff.ts` | Opens its diff in the review panel, scrolled to the line if the output named one                                 |
| A directory — `~/work/api`                                     | Reveals it in Finder or your file manager                                                                        |
| An image path it has not changed — `/tmp/shot.png`             | Opens it in a preview overlay                                                                                    |
| Any other path — `src/entities/tab/model/deck.ts:187`          | Opens it in your editor; VS Code, Cursor, Antigravity IDE, Windsurf, VSCodium and Insiders also jump to the line |
| A URL                                                          | Shows a card with the page's title, description and preview image, and a button to open it                       |

The rows are in the order Muster asks the questions: a path that names a changed
file opens as a diff before anything else is considered, so an image the agent
has just added opens in the review column as a picture rather than in the
overlay.

Paths resolve against the tab's current directory, so `src/app/App.tsx` works as
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

> Known gap: every hop of a redirect is checked, but the hostname is resolved
> once to check it and again to connect, so a record that changes between the
> two remains a theoretical way past it. Treat clicking an untrusted link as a
> request that may reach your own network.

## 🪣 Dropping files in

Drag a file onto a tab and its path is typed at the prompt, quoted, with a space
after it — the way terminals have handled a dropped file for thirty years, and
the shortest route from "that file" to a prompt that needs it. Drop several and
you get several arguments.

The quoting matches the shell the tab is running, and a file dropped on a WSL
tab arrives as the path the distro can open — `/mnt/c/…`, not `C:\…`.

## 🔍 Reviewing what changed

`⌘G`, or `Ctrl+Shift+G`, opens the review drawer on the right. It is a
navigator, in two views over the same directory:

**Changes** lists every file that differs, with its status letter and line
counts. The **vs** picker compares against a branch instead of your uncommitted
state, and it compares against the point the two branches diverged — so the
base branch's own later commits never read as your work. Files the agent has
only just written are in the list too; git has not seen them yet, but they are
the change you most want to read.

**Files** is the working directory's structure, a folder at a time. Dotfiles are
left out until you press **Hidden files**, which is also where `.github/` went.
Anything a `.gitignore` matches is dimmed rather than hidden — a `dist/` you have just
built is something you go looking for, and it should not read as part of the
work. **Right-click any row** — file or folder — for a menu: reveal it in Finder,
Explorer or your file manager, copy its path, or copy it relative to the
directory. The Menu key and `⇧F10` open the same menu from the keyboard, and
the arrows walk it.

Picking anything from either view opens it in a **column between the terminal
and the drawer** — never over the terminal, because reading what an agent
changed and typing the next instruction are the same activity. A changed file
opens as a diff: two line-number gutters, added and removed lines tinted,
syntax highlighted by [Shiki](https://shiki.style), `context` widening the
unchanged lines around each hunk to twelve or to the whole file. It is set in
the terminal's own font, size, line height and text width — whatever you chose
for reading code is what a diff is worth reading in. A file from the
tree opens as itself. Either way **Wrap** controls long lines — and breaks
inside a word when a word is the long line, so a minified bundle or a base64
blob folds into the column instead of scrolling it sideways — **clicking a line
number opens that line in your editor**, and Escape closes the column.

Images show as pictures — on a checkered ground, so a transparent logo is not
invisible — which is also what a changed image shows instead of "binary file".

Two limits worth knowing before they surprise you: a file or diff longer than
5,000 rows is cut with a line saying how many there were, because drawing a
quarter of a million elements locks the window; and a symlink is not read
through, so a linked file shows a refusal rather than its target. **Re-read**
refreshes both views, the file tree included.

**Markdown you opened from the tree opens rendered**: headings, tables, lists
and quotes, fenced code highlighted by Shiki, and ```mermaid diagrams drawn as
diagrams. A markdown file opened from the Changes list opens as its diff — you
asked to see a change — and The header's button switches between them, and says
where it goes: **Preview** to render, **Raw** or **Diff** to come back. Agents write a lot of markdown, and reading the source of a
nested table is not reading the document. Nothing in a document can act on its
own: its own HTML is escaped, links open through the same preview card the
terminal's URLs use — with the URL in a tooltip, so you read it before you
commit to it — and images are read off disk rather than fetched, from inside
the document's own folder only. One pointing outside says so instead of
loading.

**Drag any panel's left edge** to resize it; double-click the edge to put it
back, Escape mid-drag cancels, and the width is remembered for next time. The
history drawer resizes the same way. All three can be open at once, and the
terminal keeps a column of its own however wide you drag them.

Nothing in the drawer or the column writes. There is no staging, no discarding
and no editing: the agent in the tab is what edits files, and a second editable
copy of a file being rewritten underneath you is a merge conflict waiting to
happen. What it offers instead is a button to type the file's path into the
session — the fastest way to say "look at this one again" — plus copy-path and
open-in-editor.

## 🌿 History and branches

Click the branch name, or press the history shortcut, for a drawer on the right
listing that directory's commits — subject, branch and tag badges, short sha,
author and age. A dot marks commits that are not on the remote yet. It reloads
when the directory or branch changes, and there is a refresh button for when you
want it sooner.

**Switch** in the same drawer lists branches instead, most recently committed to
first, with a filter box. Pick one and it checks out. Branches only a remote has
are listed too, marked `remote`; picking one starts a local branch from it.

If the tree has uncommitted work the drawer says so before you pick, because a
checkout can fail on it — though only when the two branches differ in the files
you have touched, so it does not stop you trying. When git refuses, it names the
files in the way and the drawer shows that as it came.

## 🔎 Searching the scrollback

`⌘F`, or `Ctrl+Shift+F`, opens a find bar over the terminal. Type to jump to
the first match as you go; Enter and `⇧Enter` walk the rest, the count reads
`3 of 17`, and Escape closes it and hands the keyboard back to the agent.
Matches are highlighted in the grid and marked down the scrollbar, so a match
far above the fold is still findable.

Agents print hundreds of lines and the interesting error is always the one that
has scrolled away.

## 📋 Pasting something large

Paste a 2,000-line log or a long diff into a session and it arrives as 2,000
lines of keystrokes for the agent's own editor to reflow — which is why the
agent CLIs collapse a big paste to a placeholder you cannot open afterwards.
Muster writes it to a file instead and types the path, so the agent reads it
with a file tool and it is still there later. Anything under 5,000 characters
pastes exactly as before.

The files sit beside the session records and expire with them — not in the
system temp directory, which the OS can clear before the agent reads the path,
and not in your repository, where they would show up as changes the agent did
not make.

## ⚠️ When two tabs touch one file

Run two agents on one repository — two worktrees, two branches — and the first
you hear of them editing the same file is usually a merge conflict, after both
have already produced diffs that cannot both apply. Muster owns every tab, so it
can see it happening: the status bar names the file and which other tab has it.

Tabs in the _same_ directory are left alone. They are one working tree, so they
share every file by definition, and a warning that is always on is one nobody
reads.

## 📼 Earlier sessions

A terminal's scrollback dies with the window, and the agent CLIs keep their
conversations behind their own pickers — so "what was I doing in this folder
yesterday" means leaving the tab to go and look. Muster records each session as
it runs, so the **Earlier sessions** button in the status bar lists what has
happened in this directory: which agent, how long ago it last printed, and how
much it said. One row per run, including runs of the tab you are in.

Where the agent published an id for the conversation, the row offers **Resume
in this tab** — it ends whatever is running there and reopens that conversation
in place, using the agent's own resume flag. Claude Code publishes one; the
others do not, and their rows say so rather than offering a button that would
quietly start something new.

The button is there whenever a directory is: while a session runs, and on a
restored or just-ended tab before the next one starts.

The records are verbatim, so they hold whatever the agent printed — including
anything secret that reached the screen, and anything running as you can read
them. Recording is a setting, each session is capped at 4 MB with the tail
kept, and records are deleted after the retention period you set. Nothing is
ever sent anywhere, and nothing currently displays a record's contents — the
list is built from each file's size and age.

## 🪟 One window, where you left it

Muster remembers its size, position and whether it was maximised, so a restart
reopens the window you were using rather than the default one.

Launching it twice focuses the window you already have instead of opening a
second copy — which matters because two copies would restore the same tabs,
start their own sessions for all of them, and record over each other. And
`muster ~/some/project` from a shell, with the app already open, opens a tab
ready to start in that directory. It is left ready rather than started: asking
for a folder is not asking for an agent to be running in it.

## 🐚 Just a shell

The start screen lists the agents; below that list, and above the mode
buttons, sits **Open a plain shell instead**, because the shell is not one of
them — no flags, no modes, nothing to
resume. Minimising the window on macOS and clicking the Dock icon brings it
back; closing the window quits the app, as it always has.

## 🚫 When a folder cannot be read

Start a session in a folder the app is not allowed to list and it says so,
rather than letting the shell fail with `brew`, `mise` and the agent all
complaining separately about a directory that "does not exist". It warns and
then gets out of the way: click the same button a second time and the session
starts there regardless, because a folder you cannot list is not always a
folder you cannot work in.

On macOS this is the usual cause: `~/Documents`, `~/Desktop` and `~/Downloads`
need your permission, and **the answer is remembered** — so if you dismiss the
prompt with "Don't Allow", trying again cannot bring it back. Muster says that
and offers a button straight to Privacy settings, where you switch it back on.
Because the app is not signed with a Developer ID, macOS treats each new version
as different software, so it asks again after an update.

On Windows the folder is refused by its own permissions, or by Controlled folder
access if it sits under Documents, Desktop or Pictures. On Linux it is file
permissions, or a Flatpak or Snap sandbox.

## 🔔 Notifications

Agents ring the terminal bell when they finish a turn and hand control back, so
that is the moment you hear about:

- the tab's dot lights up and pulses, and
- a desktop notification names the agent and the tab.

Nothing fires while you are already looking at that tab, and a burst of bells
becomes a single notification. Sessions that end are announced the same way,
with the exit code when they failed. All of it is adjustable, including off.

## ⚙️ Settings

Press the settings shortcut or click the gear at the right of the status bar.
Settings open as a tab, and changes take effect immediately — including in
terminals that are already running. The one exception is **Record what sessions
print**: it is read when a session starts, so switching it off stops the next
session rather than the ones already going.

- **New tabs** — which agent and directory to start on.
- **Terminal** — theme, font, size, line height, text width, scrollback,
  blinking cursor. The font list is every family installed on the machine,
  narrowed to the ones that can hold a column; **Show all system fonts**
  widens it to the rest. The review panel's diffs and files are drawn in the
  same type, so a column of code reads exactly like the output beside it.
- **Background** — an image behind the terminal, with a brightness slider and a
  preview that shows sample output over it, since brightness is only ever
  judged against the text it sits behind.
- **Editor** — which editor the status bar's button opens.
- **Notifications** — whether to notify, whether to stay quiet on the tab you
  are watching, whether to play a sound.
- **Git** — how often to re-read status, how many commits history loads.
- **Session records** — whether to record what sessions print, and how long to
  keep those records.
- **Data** — clear remembered directories, or restore every default.

On Windows with WSL installed, **New tabs** also chooses between Windows and a
distro.

## ⌨️ Shortcuts

| Action              | macOS         | Windows / Linux                 |
| ------------------- | ------------- | ------------------------------- |
| New tab             | `⌘T`          | `Ctrl+Shift+T`                  |
| Close tab           | `⌘W`          | `Ctrl+Shift+W`                  |
| Toggle git history  | `⌘Y`          | `Ctrl+Shift+Y`                  |
| Toggle review panel | `⌘G`          | `Ctrl+Shift+G`                  |
| Find in scrollback  | `⌘F`          | `Ctrl+Shift+F`                  |
| Copy selection      | `⌘C`          | `Ctrl+Shift+C`                  |
| Paste               | `⌘V`          | `Ctrl+Shift+V`                  |
| Settings            | `⌘,`          | `Ctrl+,`                        |
| Jump to tab 1–8     | `⌘1`–`⌘8`     | `Ctrl+1`–`Ctrl+8`               |
| Jump to last tab    | `⌘9`          | `Ctrl+9`                        |
| Previous / next tab | `⌘⇧[` / `⌘⇧]` | `Ctrl+PageUp` / `Ctrl+PageDown` |

In the review drawer and the file column: Tab reaches every control, Escape
closes the column, and a panel edge can be focused and then moved with `←`/`→`
— hold `⇧` for bigger steps, and double-click it to put the width back. A line
number in a diff or a file is a link into your editor at that line, and `⇧F10`
on a row in the Files tab opens its menu.

Middle-click a tab to close it. Every other key goes to the agent untouched —
which is why the letters take `Ctrl+Shift` off macOS: bare `Ctrl+C` has to stay
SIGINT, and `Ctrl+T`/`Ctrl+W` belong to readline.

## 🩹 If something looks wrong

**A dropped file typed nothing.** A path containing a control character is
refused rather than typed, because the sequence that ends a bracketed paste can
be part of a filename — at which point the rest of the name would arrive as
keystrokes. Rename the file if you meant to use it.

**Warnings about taps you have never heard of.** Homebrew 6 refuses to load
third-party taps until they are trusted, and it lists _every_ untrusted tap on
your machine on _every_ command — so a tap unrelated to Muster can fill the
middle of the install output. It is noise, not a failure; look for
`successfully installed` at the end. Muster needs no `brew trust` of its own:
naming the cask explicitly is what authorises it.

**`brew tap ronny1020/tap` fails with `Cannot tap ronny1020/tap: invalid syntax
in tap!`.** You do not need to tap anything — the install command does it for
you. On its own, tapping trips over Homebrew's trust rule: it validates the cask
as it taps, and refuses to load a cask from a tap you have not trusted. Asking
for the cask by name is what grants that trust.

**Nothing happens when you double-click it, right after installing.** macOS
needs a moment to register a freshly replaced app bundle. Open it again and it
starts.

**`brew install` says `Warning: Not upgrading muster, the latest version is
already installed`, and the app is there.** That is Homebrew telling you it is
already installed, not an error — there is nothing to do. To force a fresh copy
anyway, use `brew reinstall --cask ronny1020/tap/muster`.

**`brew install` says "already installed" but there is no app.** The app was
deleted by hand, so Homebrew's record and the disk disagree, and `brew install`
will go on reporting success without installing anything. Repair it with `brew
reinstall --cask ronny1020/tap/muster`, then clear the quarantine attribute as
above.

**"command not found" when a session starts.** That agent's CLI is not
installed, or is not on the `PATH` your login shell sets up. Check that the
command from the table above runs in your own terminal.

**No desktop notifications.** Grant the app notification permission when your OS
asks, or later in system settings. The tab dot works either way.

**A tab says `exited 1` immediately.** The agent itself refused to start —
scroll up in that tab, its own output says why.

## 🔒 Your data

Settings, remembered directories and the widths you drag the panels to are
stored by the app; there is no config file to edit yet. Three things more are kept on disk, all expiring after the retention period in
Settings → Session records: a verbatim recording of what every session printed,
a small file beside each recording naming the agent and conversation, and a copy
of every oversized paste. The recording is **on by default** and has a switch in
that same place; the paste copies have no switch — they are written whenever a
paste is large enough to become a file. See "Earlier sessions" above for what a
recording holds. Everything the review
drawer and the file column read is your own disk. A file's _contents_ are read
when you open it, and the review drawer reads new files — the ones git has not
seen — to count the lines they would add, for the first few hundred of them.
That happens only on the Changes view, which is the one showing the numbers:
clicking a path in the terminal, or opening the drawer on the file tree, asks
git which files differ and reads none of them. The exception is an image path
you click in the terminal, which is read to show you the picture you asked for.

One thing does leave your machine, and only when you ask it to: clicking a URL —
in the terminal or in a rendered document — fetches that page once for the
preview card. Nothing else is sent anywhere, and the agents you run are the
agents you picked.

## 🤝 Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout, the checks, and how to add
another agent. [AGENTS.md](AGENTS.md) holds the conventions, for people and
coding agents alike.

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 Muster
contributors.
