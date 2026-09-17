# Security

## Reporting

Report privately through
[GitHub's advisory form](https://github.com/ronny1020/muster/security/advisories/new)
rather than opening an issue. This is a personal project with no paid support,
so expect a reply in days rather than hours, and no bounty.

## What Muster is, so a report can be judged against it

Muster is a terminal emulator. Its purpose is to run programs you chose, as
you, with your full privileges. **"An attacker who can already run code in the
webview can run arbitrary commands" is not a vulnerability here** — that is the
product, and `pty_spawn` grants it by design.

What _is_ in scope is anything that gives one of these three a capability it
should not have:

| Actor                                      | Why it counts                                                                                                                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A remote web page** you click a link to  | Muster fetches it for the preview card. This is the app's only network egress.                                                                                                                 |
| **A hostile repository** you open a tab in | Its filenames, commit messages and file contents reach the parser, the terminal, the editor — and the review panel, which renders its markdown and draws its diagrams.                         |
| **An agent CLI's output**                  | It is written into the terminal, scanned for paths and URLs, can carry inline-image escape sequences, and announces its turn boundaries as structured JSON in an `OSC 777` sequence.           |
| **A file an agent just wrote**             | Same reach as a hostile repository: an agent chooses its own filenames and file contents, and both are what the review panel reads.                                                            |
| **Any other local process**                | New with the single-instance listener: a socket on macOS, a session-bus name on Linux, a message-only window on Windows, none of which authenticate the peer. It can send an arbitrary `argv`. |

None of those five is you, and none of them should be able to reach the
network on your behalf, read a file you did not choose, or put an argument in
front of a program you did not type.

The last one is worth spelling out, because it is the only inbound channel a
released build has. A development build asked for with `bun run dev:mcp`
opens a second one — see the debugging-socket section below. What a sender can reach is `first_directory` and then a **pre-filled
launcher tab** — no spawn, no file written, no path but the one it named, and
the agent and flags come from your own settings. What it does gain is that the
window is raised and that tab made active, so a stray Return in the focused
directory field would start a session in a directory the sender chose.

## The debugging socket, and why a release build has none

`bun run dev:mcp` builds with the optional `mcp` Cargo feature, which registers
`tauri-plugin-mcp`. That plugin listens on a unix socket and will, for a caller
holding its token, read the webview's DOM, run arbitrary JavaScript in it,
inject input and read cookies — strictly more than the single-instance
listener above grants. It exists because a Tauri webview has no remote
debugging port, and there is no other way to inspect one.

Four things keep it out of anything shipped, and all four are checkable:

- The registration is `#[cfg(all(feature = "mcp", debug_assertions))]`, so it
  needs the feature _and_ a debug build.
- The feature is `optional` with no `default` list, so it is absent unless
  asked for by name.
- The plugin refuses to start its socket server in a non-`debug_assertions`
  build on its own account.
- Neither CI nor the release workflow passes `--features mcp`.

The webview half is gated separately, and that gate is the one that failed
review once: `main.tsx` guards it on `import.meta.env.DEV`, which Bun's dev
server defines and `Bun.build` does not. `build.ts` now defines it as `false`
for the production bundle, which is what removes both the branch and the
plugin's client code from `dist/`. If that define is ever dropped, the guard
does not merely stop working — it throws before the app renders.

Two known weaknesses in the development build, accepted because it is a
development build and not something a user runs:

- The socket path is the fixed `/tmp/muster-mcp.sock`, not the per-user
  temporary directory. `/tmp` is world-writable, and while the plugin refuses
  a socket path that is not a socket, the token file it writes beside it is
  opened with `create`+`truncate` and no `O_NOFOLLOW` — so another user on the
  machine can pre-create that name as a symlink and have the app truncate
  whatever it points at.
- `tauri-plugin-mcp` is unlicensed and pulled from a git revision; its Rust
  half is pinned to an immutable commit and its npm half to an exact version,
  for the reason `Cargo.toml` gives about anything that injects script into
  this app's webview.

## What an agent may put in a desktop notification

An agent CLI announces the end of a turn with
`OSC 777;notify;warp://cli-agent;<json>`, and Muster reads it — that sequence
is how Claude Code hands control back, since it never rings the terminal bell.
The event's `response` field becomes the body of a desktop notification, so
text the agent chose leaves the terminal and appears in the OS.

What bounds it:

- `parseAgentEvent` treats the payload as untrusted. A malformed body, a JSON
  value that is not an object, or an event name it does not know all answer
  `null`; any other field of the wrong type is dropped and the event is kept
  without it. Nothing throws inside xterm's parser, where a throw would stop
  the terminal drawing. The payload is also refused unread past 8 KB, so the
  cap below is not the only bound on it.
- The text it carries is capped, because an unbounded string in a notification
  body is a wall of text on your screen.
- Only `stop` reaches the notification path. `session_start`,
  `prompt_submit` and `tool_complete` are parsed and ignored.
- The payload is never interpreted as anything but text: no path is resolved
  from it, no file read, nothing typed into a session. The "nothing an agent
  names may reach a session as keystrokes" rule in AGENTS.md applies here too.

The channel itself is not a new capability. The bytes already arrived in the
pty stream Muster reads and records, so nothing was opened to get them — no
hook, no plugin, and no read of the agent's own transcript files.

## Two places an agent's own text is drawn outside the grid

Both are display-only, and both are worth knowing because the grid is where
agent output is normally confined.

**A desktop notification body**, from `OSC 777`'s `stop` event — bounded as the
section above describes.

**The message rail's tooltip and accessible name.** `findMessageRows` marks a
row whose first columns carry a non-default background, and `labelled` reads
that row's text back out of the buffer for the dot's `title` and `aria-label`.
Two consequences follow, and neither is a capability gain — the agent could
already print anything — but both affect what the surface _means_:

- **A rail entry is "the agent tinted this row", not "you typed this".** Any
  tinted left edge qualifies: a banner, a diff gutter, a coloured `git log`.
  The control says "scroll to your message" about text the agent chose, so do
  not read the rail as an audit trail of your own instructions.
- The label is bounded and inert. React sets both attributes through
  `setAttribute`, so nothing there is parsed as markup, and xterm stores only
  printable code points in a cell — no control bytes or escape sequences can
  reach it. It is read with a bounded column range and capped in length, and it
  reaches no other consumer: no path, no pty write, no IPC, no file.

## What a terminal click will read

Clicking a path in the terminal opens it in the file column when it resolves to
somewhere under the session's own directory, and that read is the app's, not
the agent's. The containment test is `isUnder`, and it is a **prefix
comparison**: neither it nor `resolvePath` collapses `..`, and neither resolves
an intermediate directory symlink. So a path an agent wrote as
`../../secrets/key` or one under a `docs -> ~/Desktop` symlink satisfies it
while pointing outside the directory, and in the symlink case the path Muster
displays looks entirely repo-relative.

What bounds it: the read needs a click, `read_capped` refuses a symlinked final
component with `symlink_metadata` and `O_NOFOLLOW`, refuses anything that is
not a regular file, refuses a file containing a NUL byte, and stops at 2 MB.
Treat the directory test as "where the agent said it was", not as a boundary.

## What the message rail says, and what it does not

The dots down the terminal's right edge, and the marks on its scrollbar, are
placed by `findMessageRows`, which looks for a **tinted block of cells** — the
way a CLI draws the prompt you typed. That is a guess about provenance, not a
record of it, and the agent chooses every byte written to the pty. So:

- A rail entry means "something tinted the first few columns here". It does not
  mean you typed it. An agent can produce one deliberately, and ordinary output
  produces them by accident — a diff gutter, a `bat` line-number column, a
  coloured `git log`. This app's own startup banner is marked.
- Each entry's tooltip and accessible name carry text read out of the buffer,
  bounded to 80 characters and refused when it would render blank. React sets
  both through `setAttribute`, so the text is inert markup; what it can do is
  misattribute.
- Clicking one only scrolls. The row comes from the scan, so it is in range by
  construction: no path is resolved, no file read, nothing typed into the
  session.

The honest source for "what did I ask" is the `OSC 777` `prompt_submit` event,
which names each message as the user sends it. Nothing consumes it yet.

## What the session journal keeps, and for how long

Recording a session writes the pty stream verbatim to
`<app data>/journal/<directory>/<tab id>-<started at>.log` — which means it holds whatever
the agent printed, including anything secret that reached the screen. Anything
running as you can read it, this app included: a second agent in another tab
can read what the first one printed, which was previously only in the webview's
memory. Four properties bound it:

- **It is a setting, and it is the user's** — though it currently defaults to
  **on**, and the paste copies below have no switch at all, only the shared
  retention period. `pty_spawn` records only when the caller passes
  `journal: true`, which is that toggle and nothing else. This one is enforced in `pty_spawn` and **is not
  covered by a test**; the three below each have one in `journal_tests.rs`.
- **One session cannot grow without limit.** Past 4 MB the older half is
  dropped, so a tab that prints for a day costs a bounded amount of disk and
  keeps the tail.
- **Records expire.** A sweep at startup deletes anything past the retention
  period, and removes a directory once it holds nothing.
- **A tab id cannot become a path.** Ids are minted by `crypto.randomUUID`, and
  `file_stem` refuses anything carrying a separator, a dot or a non-ASCII
  character — so a crafted id reaches no file but its own. The directory half
  is confined separately, by `key`, which flattens the whole path to one
  component through `sessions::normalize_key` and appends a digest. The digest
  makes a shared folder unlikely rather than impossible — it is an identity,
  not a security boundary, and a collision costs two directories one folder.

Oversized pasted text is written the same way, to
`<app data>/attachments/paste-<ms>.<ext>`, and expires on the same setting.
`attachment_name` builds a bare filename from a timestamp and a sniffed
extension — never from the pasted text — so nothing in the clipboard can decide
where the file lands, and `the_name_is_a_bare_filename` pins it.

Neither refuses a symlink today, which is a **known gap** — listed below.

The journal is never sent anywhere. `journal_read` is the only way to read one
back, and it is confined to the journal root the same way. The sidecar beside
each record holds an agent's own session id, which is read back into an argv —
so `published_session_id` accepts only the shape an id has (ASCII
alphanumerics, `-`, `_`, at most 64 characters) rather than trusting what
another program wrote.

## What the review panel will not do

The panel reads a working tree an agent has been editing, so the file contents
and the filenames in it are attacker-controlled in the sense above. Four
properties hold, and each has a test:

- **Nothing an agent names reaches a session as keystrokes.** A path carrying a
  control byte is never typed: the text goes through bracketed paste, which
  does not strip an end marker embedded in a filename, so such a path would
  leave paste mode and submit whatever followed.
- **A pathspec is literal.** A file named `:setup.sh` or `!notes.md` names
  itself and nothing else, so the diff you are shown is the diff of the file you
  clicked.
- **Nothing is read through a symlink**, including the line count taken for a
  new file, which happens whenever the review drawer is showing the changes.
  The final component is refused by the open itself (`O_NOFOLLOW`, so it cannot
  be raced), and for the reads that
  happen without a click, every directory between the repository root and the
  file is checked too — a committed `docs -> ~/.ssh` would otherwise make
  everything under it look repo-relative. The root may itself sit under a link;
  that is not refused, because it is the tree you opened.
- **A document's images stay inside its own folder.** A markdown file cannot
  point at `../../../../Pictures` and have it displayed, and the check is the
  filesystem's rather than the path's spelling — a folder that is a symlink
  resolves to where it really goes before being compared.
- **A diagram cannot navigate the window.** Mermaid's `click` directive becomes
  a real anchor in the SVG and `securityLevel: strict` does not prevent that,
  so the destination is moved onto the same preview card every other link in a
  document uses.

Rendering a document also loads code — markdown-it, and mermaid with DOMPurify
for a diagram — in response to what a file contains. Markdown is parsed with
raw HTML disabled, links carry no `href` and are activated through the same
preview card a terminal URL uses, and mermaid runs at `securityLevel: strict`.

## Known gaps

Named rather than hidden, because the code carries the same notes:

- **The journal's own reads and writes do not refuse a symlink.** `review.rs`
  and `image.rs` both check `symlink_metadata` before reading, because a
  repository can ship `docs/notes.md -> ~/.ssh/id_ed25519`. Three paths added
  with the session journal do not: `journal.rs`'s retention sweep walks and
  **deletes** through a symlinked directory under the journal root, with no
  click and at every launch; `attach.rs` writes a pasted attachment with
  `fs::write`, which follows a pre-planted link at that name; and
  `sessions.rs`'s `published_session_id` reads `~/.claude/sessions/<pid>.json`
  without the check. All three are dominated by the fact that an agent with a
  pty can run `rm` itself, which is why they are gaps rather than
  vulnerabilities — but the invariant AGENTS.md states is not currently kept,
  and the fixes are one `symlink_metadata` call, one `create_new(true)`, and
  one more `symlink_metadata`.
- **A paste is not scanned for a bracketed-paste end marker.** `drop_text`
  refuses control bytes in a dropped path for exactly this reason, but text
  reaching `term.paste` is not filtered: xterm wraps it in `ESC[200~`…`ESC[201~`
  by plain concatenation and strips nothing, so a clipboard carrying
  `ESC[201~` ends paste mode early and the rest arrives as typed keys. It
  requires the user to copy hostile content, and it predates the journal work.

- **Redirects in the link preview.** The private-address check validates every
  hop of a redirect chain, but DNS is resolved twice — once to validate and
  once to connect — so a short-TTL rebinding record remains a theoretical
  bypass. Resolving once and connecting to that address is the fix.
- **Unsigned binaries.** No Apple Developer membership and no Windows
  certificate, so macOS builds are ad-hoc signed and Windows builds are
  unsigned. Every release is built in public by GitHub Actions from the tag it
  claims to be; that provenance is what stands in for a signature.
- **The font picker parses every installed font.** Opening it runs
  `font_families`, which loads one face per installed family through CoreText,
  DirectWrite or FreeType — in this process, the one that owns every PTY.
  `~/Library/Fonts` and `~/.local/share/fonts` are writable by anything running
  as you, and on Linux `~/.config/fontconfig/fonts.conf` can point the scan
  somewhere else again, so the bytes being parsed are not confined to the
  directory you opened. It is gated on the click that opens the picker rather
  than run at launch, and `panic = "abort"` in the release profile means a
  malformed font aborts instead of falling back to the built-in list.
- **`create_directory` is unscoped.** It creates any directory you confirm.
  Dominated by the PTY for any attacker who already has webview execution.
- **The review panel's readers are unscoped too.** `read_text_file`,
  `list_directory` and `git_file_diff` take the path they are given. Confinement
  lives at the callers that act without a click — a markdown image, a new
  file's line count — rather than in the commands, because the file tree and
  the image preview both legitimately point wherever you pointed them. Same
  reasoning as `create_directory`: dominated by the PTY for anyone who already
  has webview execution.
- **Syntax colours are below the contrast bar in a diff.** The dimmest token of
  the bundled theme measures 2.43:1 against the added-line tint, where WCAG AA
  asks 4.5:1. An accessibility gap rather than a security one, recorded here
  because it is measured and unfixed.

## Out of scope

- Vulnerabilities in the agent CLIs themselves — report those to their projects.
- A hostile local user, or malware already running as you.
- The Gatekeeper and SmartScreen warnings; those are the unsigned builds above.
